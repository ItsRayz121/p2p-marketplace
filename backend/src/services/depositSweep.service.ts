/**
 * Admin sweep of per-user EVM deposit addresses.
 *
 * When deposit detection misses funds (or the platform simply needs to move
 * them), the operator can read live on-chain balances of a user's HD deposit
 * address and sweep a chosen asset to a platform-controlled destination
 * (default: the EVM gas hot wallet). Recovery path only — it never touches the
 * user's internal ledger; crediting stays with the deposit pipeline
 * (deposits:rescan / evmDepositPoller).
 *
 * SAFETY MODEL (money movement — read before editing):
 *   - The private key is re-derived from the stored derivationIndex and the
 *     derived address MUST equal the stored DepositAddress.address — a drifted
 *     seed or corrupted index aborts before anything is signed.
 *   - Deposit addresses hold no native gas, so ERC20 sweeps first top up gas
 *     from the gas hot wallet (serialized through withHotWalletLock so the
 *     top-up can never nonce-collide with gas deliveries).
 *   - Every send waits for its receipt and asserts success.
 *   - Destination defaults to the gas hot wallet; an explicit external
 *     destination is allowed but the ROUTE restricts that to super_admin.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
  type Chain,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum, base, bsc, mainnet, optimism, polygon } from 'viem/chains'
import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { AppError } from '../lib/errors'
import { deriveEvmDepositPrivateKeyHex, walletCustodyIsConfigured } from '../lib/walletCrypto'
import { getAllChains, getRpcUrl } from './chainRegistry.service'
import { decryptGasSeed, deriveEvmPrivateKeyHex, getEvmHotWalletAddress, HOT_WALLET_INDEX, gasWalletIsConfigured } from '../lib/gas/gasWalletService'
import { withHotWalletLock } from '../lib/hotWalletLock'
import { getTransactionCount } from '../lib/evmRpc'

const VIEM_CHAINS: Record<string, Chain> = {
  bsc,
  ethereum: mainnet,
  polygon,
  arbitrum,
  optimism,
  base,
}

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function' as const, inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { name: 'transfer',  type: 'function' as const, inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' },
] as const

// Gas ceiling for a single ERC20 transfer (USDT on BSC uses ~52k; 90k covers
// every whitelisted stablecoin with headroom).
const ERC20_TRANSFER_GAS = 90_000n
const NATIVE_TRANSFER_GAS = 21_000n

export interface ChainBalances {
  chain: string
  chainName: string
  nativeSymbol: string
  /** Human-readable native balance, or null when the RPC read failed. */
  native: string | null
  tokens: Array<{ symbol: string; contract: string; decimals: number; balance: string }>
  error?: string
}

/**
 * Live on-chain balances of an EVM deposit address across every configured EVM
 * chain (native + each whitelisted token). Read-only.
 */
export async function getDepositAddressBalances(address: string): Promise<ChainBalances[]> {
  const chains = (await getAllChains()).filter(
    (c) => c.family === 'EVM' && c.chainId != null && VIEM_CHAINS[c.id] && getRpcUrl(c.id),
  )
  const results: ChainBalances[] = []
  for (const chain of chains) {
    const rpc = getRpcUrl(chain.id)!
    const client = createPublicClient({ chain: VIEM_CHAINS[chain.id]!, transport: http(rpc) })
    const entry: ChainBalances = {
      chain: chain.id,
      chainName: chain.name,
      nativeSymbol: chain.nativeSymbol,
      native: null,
      tokens: [],
    }
    try {
      const native = await client.getBalance({ address: address as `0x${string}` })
      entry.native = formatUnits(native, 18)
    } catch (err) {
      entry.error = `native read failed: ${(err as Error).message?.slice(0, 120)}`
    }
    for (const token of chain.tokens) {
      if (!token.address) continue
      try {
        const raw = await client.readContract({
          address: token.address as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [address as `0x${string}`],
        })
        entry.tokens.push({
          symbol: token.symbol,
          contract: token.address,
          decimals: token.decimals,
          balance: formatUnits(raw, token.decimals),
        })
      } catch {
        // One unreadable token must not hide the rest — skip it.
      }
    }
    results.push(entry)
  }
  return results
}

export interface SweepResult {
  txHash: string
  chain: string
  asset: string
  symbol: string
  amount: string
  from: string
  destination: string
  gasTopUpTxHash?: string
}

/**
 * Sweep one asset ('native' or a whitelisted token contract) from a user's
 * EVM deposit address to `destination`. Returns the confirmed tx hash(es).
 */
export async function sweepDepositAddress(params: {
  depositAddressId: string
  chain: string
  /** 'native' or the token contract address. */
  asset: string
  destination?: string
}): Promise<SweepResult> {
  if (!walletCustodyIsConfigured()) {
    throw new AppError('CUSTODY_UNCONFIGURED', 'Wallet custody is not configured', 503)
  }

  const row = await db.depositAddress.findUnique({ where: { id: params.depositAddressId } })
  if (!row) throw new AppError('NOT_FOUND', 'Deposit address not found', 404)
  if (row.chainFamily !== 'EVM') {
    throw new AppError('UNSUPPORTED_FAMILY', `Sweep supports EVM deposit addresses only (got ${row.chainFamily})`, 400)
  }

  const chain = (await getAllChains()).find((c) => c.id === params.chain)
  if (!chain || chain.family !== 'EVM' || chain.chainId == null || !VIEM_CHAINS[chain.id]) {
    throw new AppError('UNSUPPORTED_CHAIN', `Chain ${params.chain} is not a sweepable EVM chain`, 400)
  }
  const rpc = getRpcUrl(chain.id)
  if (!rpc) throw new AppError('NO_RPC_URL', `No RPC URL configured for ${chain.id}`, 503)

  // Destination: explicit (route gates this to super_admin) or the gas hot wallet.
  const destination = params.destination ?? getEvmHotWalletAddress() ?? undefined
  if (!destination || !/^0x[a-fA-F0-9]{40}$/.test(destination)) {
    throw new AppError('NO_DESTINATION', 'No valid destination address (gas hot wallet unconfigured and none supplied)', 400)
  }
  if (destination.toLowerCase() === row.address.toLowerCase()) {
    throw new AppError('SELF_SWEEP', 'Destination equals the deposit address', 400)
  }

  // Re-derive the key and PROVE it controls the stored address before signing.
  const pk = deriveEvmDepositPrivateKeyHex(row.derivationIndex)
  const account = privateKeyToAccount(pk)
  if (account.address.toLowerCase() !== row.address.toLowerCase()) {
    logger.error(
      { depositAddressId: row.id, derivationIndex: row.derivationIndex, stored: row.address, derived: account.address },
      'depositSweep: derived address does not match stored address — seed drift or index corruption, ABORTING',
    )
    throw new AppError('DERIVATION_MISMATCH', 'Derived key does not control the stored address — sweep aborted', 500)
  }

  const viemChain = VIEM_CHAINS[chain.id]!
  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpc) })
  const walletClient = createWalletClient({ chain: viemChain, transport: http(rpc), account })
  const gasPrice = await publicClient.getGasPrice()

  // ── Native sweep ────────────────────────────────────────────────────────────
  if (params.asset === 'native') {
    const balance = await publicClient.getBalance({ address: account.address })
    // Real gas estimate where possible — L2s (Arbitrum) have intrinsic gas well
    // above 21k and OP-stack chains charge an L1 data fee on top; the estimate
    // accounts for both. Falls back to the plain-transfer constant.
    let nativeGas = NATIVE_TRANSFER_GAS
    try {
      const est = await publicClient.estimateGas({ account: account.address, to: destination as `0x${string}`, value: 1n })
      if (est > nativeGas) nativeGas = est
    } catch { /* keep default */ }
    // Reserve fee at a 1.5x buffer so the send can't fail on a price bump or an
    // OP-stack L1-fee component.
    const fee = (gasPrice * nativeGas * 150n) / 100n
    if (balance <= fee) {
      throw new AppError('BALANCE_TOO_LOW', `Native balance ${formatUnits(balance, 18)} does not cover the transfer fee`, 400)
    }
    const value = balance - fee
    const hash = await walletClient.sendTransaction({
      account,
      to: destination as `0x${string}`,
      value,
      gas: nativeGas,
      gasPrice,
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 })
    if (receipt.status !== 'success') {
      throw new AppError('SWEEP_REVERTED', `Native sweep reverted on-chain (tx ${hash})`, 502)
    }
    const amount = formatUnits(value, 18)
    logger.info({ depositAddressId: row.id, chain: chain.id, amount, destination, txHash: hash }, 'depositSweep: native sweep confirmed')
    return { txHash: hash, chain: chain.id, asset: 'native', symbol: chain.nativeSymbol, amount, from: row.address, destination }
  }

  // ── Token sweep ─────────────────────────────────────────────────────────────
  const token = chain.tokens.find((t) => t.address?.toLowerCase() === params.asset.toLowerCase())
  if (!token || !token.address) {
    throw new AppError('ASSET_NOT_WHITELISTED', `Asset ${params.asset} is not a whitelisted token on ${chain.id}`, 400)
  }
  const contract = token.address as `0x${string}`

  const rawBalance = await publicClient.readContract({
    address: contract, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address],
  })
  if (rawBalance === 0n) {
    throw new AppError('BALANCE_ZERO', `Deposit address holds no ${token.symbol} on ${chain.id}`, 400)
  }

  // Real gas estimate for the token transfer (Arbitrum token transfers run well
  // past the 90k default). estimateContractGas doesn't need the sender to hold
  // native, so it works before the top-up; fall back to the constant on RPC error.
  let tokenGas = ERC20_TRANSFER_GAS
  try {
    const est = await publicClient.estimateContractGas({
      address: contract, abi: ERC20_ABI, functionName: 'transfer',
      args: [destination as `0x${string}`, rawBalance], account: account.address,
    })
    const buffered = (est * 130n) / 100n
    if (buffered > tokenGas) tokenGas = buffered
  } catch { /* keep default */ }

  // Deposit addresses hold no gas — top up native from the gas hot wallet when
  // the fee reserve is short. 2x buffer absorbs gas-price movement; leftovers
  // stay on the deposit address and are recoverable with a native sweep.
  const feeNeeded = (gasPrice * tokenGas * 125n) / 100n
  const nativeBalance = await publicClient.getBalance({ address: account.address })
  let gasTopUpTxHash: string | undefined
  if (nativeBalance < feeNeeded) {
    if (!gasWalletIsConfigured()) {
      throw new AppError(
        'NO_GAS_SOURCE',
        `Deposit address needs ${formatUnits(feeNeeded - nativeBalance, 18)} ${chain.nativeSymbol} for gas and the gas hot wallet is not configured`,
        503,
      )
    }
    const topUp = feeNeeded * 2n - nativeBalance
    const seed = decryptGasSeed()
    try {
      const hotPk = deriveEvmPrivateKeyHex(seed, HOT_WALLET_INDEX)
      const hotAccount = privateKeyToAccount(hotPk)
      const hotClient = createWalletClient({ chain: viemChain, transport: http(rpc), account: hotAccount })
      const hotBalance = await publicClient.getBalance({ address: hotAccount.address })
      if (hotBalance < topUp + (gasPrice * NATIVE_TRANSFER_GAS * 125n) / 100n) {
        throw new AppError(
          'HOT_WALLET_GAS_LOW',
          `Gas hot wallet ${chain.nativeSymbol} balance (${formatUnits(hotBalance, 18)}) cannot fund the ${formatUnits(topUp, 18)} gas top-up`,
          503,
        )
      }
      // Serialize with gas deliveries/withdrawals from the same hot wallet
      // (nonce safety): explicit pending nonce + broadcast inside the lock,
      // receipt wait outside (matches withdrawal.sender/gas.delivery protocol).
      gasTopUpTxHash = await withHotWalletLock(chain.id, async () => {
        const nonce = await getTransactionCount(rpc, chain.id, hotAccount.address, 'pending')
        return hotClient.sendTransaction({
          account: hotAccount,
          to: account.address,
          value: topUp,
          nonce,
        })
      })
      const topUpReceipt = await publicClient.waitForTransactionReceipt({ hash: gasTopUpTxHash as `0x${string}`, timeout: 180_000 })
      if (topUpReceipt.status !== 'success') {
        throw new AppError('TOPUP_REVERTED', `Gas top-up reverted on-chain (tx ${gasTopUpTxHash})`, 502)
      }
      logger.info(
        { depositAddressId: row.id, chain: chain.id, topUp: formatUnits(topUp, 18), txHash: gasTopUpTxHash },
        'depositSweep: gas top-up confirmed',
      )
    } finally {
      seed.fill(0)
    }
  }

  const hash = await walletClient.writeContract({
    address: contract,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [destination as `0x${string}`, rawBalance],
    gas: tokenGas,
    gasPrice,
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 })
  if (receipt.status !== 'success') {
    throw new AppError('SWEEP_REVERTED', `Token sweep reverted on-chain (tx ${hash})`, 502)
  }

  const amount = formatUnits(rawBalance, token.decimals)
  logger.info(
    { depositAddressId: row.id, chain: chain.id, symbol: token.symbol, amount, destination, txHash: hash, gasTopUpTxHash },
    'depositSweep: token sweep confirmed',
  )
  return {
    txHash: hash,
    chain: chain.id,
    asset: contract,
    symbol: token.symbol,
    amount,
    from: row.address,
    destination,
    ...(gasTopUpTxHash ? { gasTopUpTxHash } : {}),
  }
}
