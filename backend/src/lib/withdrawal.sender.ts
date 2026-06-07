/**
 * Automated withdrawal sender — sends ERC20 tokens (USDT/USDC) from the
 * platform hot wallet for auto-approved (Tier 1) withdrawals.
 *
 * Called fire-and-forget from requestWithdrawal after the DB record is created.
 * On success: updates withdrawal → sent and the pending Transaction → completed.
 * On failure: leaves withdrawal as auto_approved and alerts admins.
 */

import { createWalletClient, http, parseUnits, type Chain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum, base, bsc, mainnet, optimism, polygon } from 'viem/chains'
import { db } from './prisma'
import { env } from './env'
import {
  decryptGasSeed,
  deriveEvmPrivateKeyHex,
  getEvmHotWalletAddress,
  HOT_WALLET_INDEX,
} from './gas/gasWalletService'
import { getChainByNetworkLabel } from '../services/chainRegistry.service'
import { logger as log } from './logger'
import { createAdminNotif } from '../services/adminNotification.service'
import { getEvmGasPrice, getTransactionCount } from './evmRpc'
import { withHotWalletLock } from './hotWalletLock'
import { getHotWalletBalance } from './gas/gas.balance'
import type { GasChainId } from './gas/gas.chains'
import { appendLedgerEntry } from './gas/gas.ledger'

const ERC20_TRANSFER_ABI = [
  {
    name: 'transfer',
    type: 'function' as const,
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const

const VIEM_CHAINS: Partial<Record<string, Chain>> = {
  ethereum: mainnet,
  bsc,
  polygon,
  arbitrum,
  optimism,
  base,
  // avalanche intentionally omitted — no USDT on Avalanche in chains.ts
}

const getRpcUrl = (chainId: string): string | undefined => {
  const map: Partial<Record<string, string>> = {
    ethereum: env.ETHEREUM_RPC_URL,
    bsc:      env.BSC_RPC_URL,
    polygon:  env.POLYGON_RPC_URL,
    arbitrum: env.ARBITRUM_RPC_URL,
    optimism: env.OPTIMISM_RPC_URL,
    base:     env.BASE_RPC_URL,
  }
  return map[chainId]
}

// Maps deposit chain slug → GasChainId for native balance lookups
const CHAIN_TO_GAS_CHAIN: Partial<Record<string, GasChainId>> = {
  bsc:      'BSC',
  ethereum: 'ETHEREUM',
  polygon:  'MATIC',
  arbitrum: 'ARB',
  optimism: 'OP',
  base:     'BASE',
}

// Maps withdrawal network label → GasChainId for the platform_fee ledger entry
const NETWORK_TO_GAS_CHAIN: Partial<Record<string, GasChainId>> = {
  TRC20:    'TRON',
  BEP20:    'BSC',
  ERC20:    'ETHEREUM',
  BASE:     'BASE',
  ARBITRUM: 'ARB',
  OPTIMISM: 'OP',
  POLYGON:  'MATIC',
}

// Native symbol per chain slug — used in alert messages
const CHAIN_NATIVE_SYMBOL: Partial<Record<string, string>> = {
  bsc:      'BNB',
  ethereum: 'ETH',
  polygon:  'POL',
  arbitrum: 'ETH',
  optimism: 'ETH',
  base:     'ETH',
}

// Gas units required for an ERC-20 token transfer
const ERC20_GAS_LIMIT = 65_000n

interface AutoWithdrawal {
  id: string
  userId: string
  coin: string
  network: string
  amount: number | string
  fee?: number | string
  toAddress: string
}

export async function sendWithdrawalOnChain(wd: AutoWithdrawal): Promise<void> {
  // Resolve chain config from network label (e.g. "BEP20" → bsc)
  const chainCfg = await getChainByNetworkLabel(wd.network)
  if (!chainCfg) {
    log.warn({ withdrawalId: wd.id, network: wd.network }, 'sendWithdrawalOnChain: unknown network')
    return
  }

  // Find the ERC20 contract address for the coin on this chain
  const tokenCfg = chainCfg.tokens.find(
    (t: { symbol: string; address: string | null }) => t.symbol.toUpperCase() === wd.coin.toUpperCase() && t.address,
  )
  if (!tokenCfg?.address) {
    log.warn({ withdrawalId: wd.id, coin: wd.coin, chainId: chainCfg.id }, 'sendWithdrawalOnChain: no ERC20 contract for coin')
    return
  }

  const viemChain = VIEM_CHAINS[chainCfg.id]
  const rpcUrl = getRpcUrl(chainCfg.id)
  if (!viemChain || !rpcUrl) {
    log.warn({ withdrawalId: wd.id, chainId: chainCfg.id }, 'sendWithdrawalOnChain: no viem chain config')
    return
  }

  // Check hot wallet seed is available (GAS_SEED_CIPHERTEXT env var)
  if (!env.GAS_SEED_CIPHERTEXT) {
    log.warn({ withdrawalId: wd.id }, 'sendWithdrawalOnChain: GAS_SEED_CIPHERTEXT not set, skipping auto-send')
    void createAdminNotif({
      category: 'SYSTEM',
      title:    'Auto-withdrawal skipped — hot wallet not configured',
      body:     `Withdrawal ${wd.id} (${wd.amount} ${wd.coin} on ${wd.network}) is auto-approved but GAS_SEED_CIPHERTEXT is not set. Send manually from your wallet, then open the withdrawal in the admin panel → Review → Mark Sent (Manual Fallback).`,
      href:     '/admin/withdrawals',
      metadata: { withdrawalId: wd.id },
    })
    return
  }

  // ── Gas pre-flight check ──────────────────────────────────────────────────────
  // Verify the hot wallet has enough native token (BNB / ETH / POL) to cover the
  // ERC-20 transfer gas cost before we even attempt to broadcast. A withdrawal
  // that can't pay gas will either drop from the mempool or revert; catching it
  // here lets us alert admins and leave the withdrawal in auto_approved (rather
  // than marking it "sent" with a stuck/dropped txHash).
  const gasChainId = CHAIN_TO_GAS_CHAIN[chainCfg.id]
  const nativeSymbol = CHAIN_NATIVE_SYMBOL[chainCfg.id] ?? 'native'
  const hotAddress = getEvmHotWalletAddress()

  if (gasChainId && hotAddress) {
    try {
      const [gasPriceWei, nativeBalance] = await Promise.all([
        getEvmGasPrice(rpcUrl, chainCfg.id),
        getHotWalletBalance(gasChainId, hotAddress),
      ])

      // Minimum balance = live gas price × 65,000 gas units × 2 safety buffer
      const gasNeededWei = gasPriceWei * ERC20_GAS_LIMIT
      const gasNeededNative = Number(gasNeededWei) / 1e18
      const minimumBalance = gasNeededNative * 2

      if (nativeBalance < minimumBalance) {
        log.warn(
          { withdrawalId: wd.id, nativeBalance, gasNeededNative, minimumBalance, nativeSymbol, chainId: chainCfg.id },
          'sendWithdrawalOnChain: insufficient gas balance — skipping auto-send',
        )
        void createAdminNotif({
          category: 'SYSTEM',
          title:    `Auto-withdrawal skipped — hot wallet low on ${nativeSymbol} gas`,
          body:     `Withdrawal ${wd.id} (${wd.amount} ${wd.coin} on ${wd.network}) cannot be auto-sent: hot wallet has ${nativeBalance.toFixed(6)} ${nativeSymbol} but needs at least ${minimumBalance.toFixed(6)} ${nativeSymbol} for gas. Top up the hot wallet (${hotAddress}), then the withdrawal will retry automatically or you can Mark Sent manually after sending.`,
          href:     '/admin/withdrawals',
          metadata: { withdrawalId: wd.id, nativeBalance, gasNeededNative, nativeSymbol },
        })
        return
      }

      log.info(
        { withdrawalId: wd.id, nativeBalance, gasNeededNative, nativeSymbol },
        'sendWithdrawalOnChain: gas pre-flight passed',
      )
    } catch (err) {
      // Gas check failure is non-fatal — log and proceed. writeContract will fail
      // naturally if gas is truly insufficient, and the catch block below will alert.
      log.warn({ err, withdrawalId: wd.id }, 'sendWithdrawalOnChain: gas pre-check errored, proceeding anyway')
    }
  }

  let txHash: `0x${string}`
  let seed: Buffer | undefined
  try {
    seed = decryptGasSeed()
    const privateKey = deriveEvmPrivateKeyHex(seed, HOT_WALLET_INDEX)
    const account = privateKeyToAccount(privateKey)
    const client = createWalletClient({ chain: viemChain, transport: http(rpcUrl), account })

    // Serialize sends from the shared hot wallet per-chain and pin an explicit
    // pending nonce so a concurrent withdrawal/gas-delivery can't collide on the
    // same nonce and silently drop one tx (see hotWalletLock.ts).
    txHash = await withHotWalletLock(chainCfg.id, async () => {
      const nonce = await getTransactionCount(rpcUrl, chainCfg.id, account.address, 'pending')
      return client.writeContract({
        address: tokenCfg.address as `0x${string}`,
        abi: ERC20_TRANSFER_ABI,
        functionName: 'transfer',
        args: [wd.toAddress as `0x${string}`, parseUnits(String(wd.amount), tokenCfg.decimals)],
        nonce,
      })
    })
  } catch (err) {
    seed?.fill(0)
    const msg = err instanceof Error ? err.message : String(err)
    log.error({ err, withdrawalId: wd.id }, 'sendWithdrawalOnChain: on-chain send failed')
    void createAdminNotif({
      category: 'SYSTEM',
      title:    'Auto-withdrawal send FAILED — manual action required',
      body:     `Withdrawal ${wd.id} (${wd.amount} ${wd.coin} on ${wd.network}) failed to send automatically: ${msg}. Send manually from the hot wallet, then open the withdrawal → Review → Mark Sent (Manual Fallback). Or reject to refund the user.`,
      href:     '/admin/withdrawals',
      metadata: { withdrawalId: wd.id, error: msg },
    })
    return
  }
  seed.fill(0)

  // Update DB: withdrawal → sent, existing pending Transaction → completed
  try {
    const wallet = await db.wallet.findFirst({
      where: { userId: wd.userId, coin: wd.coin, network: wd.network },
      select: { id: true },
    })

    await db.$transaction(async (tx) => {
      const locked = await tx.withdrawal.updateMany({
        where: { id: wd.id, status: 'auto_approved' },
        data:  { status: 'sent', txHash, completedAt: new Date() },
      })
      if (locked.count === 0) return // already processed by admin concurrently

      if (wallet) {
        // Update the pending transaction record created at withdrawal creation time
        const pendingTx = await tx.transaction.findFirst({
          where: {
            walletId: wallet.id,
            type:     'withdrawal',
            status:   'pending',
            metadata: { path: ['withdrawalId'], equals: wd.id },
          },
        })
        if (pendingTx) {
          await tx.transaction.update({
            where: { id: pendingTx.id },
            data:  { status: 'completed', txHash },
          })
        }
      }
    })

    log.info({ withdrawalId: wd.id, txHash, coin: wd.coin, network: wd.network }, 'Auto-send withdrawal completed')

    // Record the platform fee in the gas ledger so it shows up in revenue accounting.
    // The fee stays physically in the hot wallet (only `amount` is sent on-chain, not
    // amount+fee). This entry makes it traceable and queryable.
    const feeAmount = Number(wd.fee ?? 0)
    if (feeAmount > 0) {
      const gasChain = NETWORK_TO_GAS_CHAIN[wd.network.toUpperCase()]
      if (gasChain) {
        void appendLedgerEntry({
          entryType:   'platform_fee',
          chain:       gasChain,
          nativeAmount: 0,                    // no native movement — fee is in token
          tokenSymbol:  wd.coin.toUpperCase(),
          tokenAmount:  feeAmount,
          usdAmount:    feeAmount,            // USDT ≈ 1 USD; adjust per-coin if needed
          txHash,
          sourceKey:    `platform_fee:withdrawal:${wd.id}`,
          notes:        `Withdrawal fee from user ${wd.userId} — withdrawal ${wd.id}`,
        }).catch((err) => log.error({ err, withdrawalId: wd.id }, 'Failed to write platform_fee ledger entry'))
      }
    }

    // Notify admin so completed auto-sends appear in the notifications feed.
    // Without this the only way to see them is the "Auto-Sent" tab.
    const userRow = await db.user.findUnique({
      where: { id: wd.userId },
      select: { username: true },
    }).catch(() => null)
    const userLabel = userRow?.username ?? wd.userId.slice(-8)
    void createAdminNotif({
      category: 'SYSTEM',
      title:    `Withdrawal Sent: ${wd.amount} ${wd.coin}`,
      body:     `User ${userLabel} auto-withdrawal of ${wd.amount} ${wd.coin} (${wd.network}) sent on-chain. TX: ${txHash.slice(0, 18)}...`,
      href:     '/admin/withdrawals?tab=sent',
      metadata: { withdrawalId: wd.id, txHash, coin: wd.coin, amount: String(wd.amount), network: wd.network, userId: wd.userId },
    })
  } catch (err) {
    // On-chain tx is already broadcast — log the DB failure but don't throw
    log.error({ err, withdrawalId: wd.id, txHash }, 'sendWithdrawalOnChain: DB update failed after successful on-chain send')
    void createAdminNotif({
      category: 'SYSTEM',
      title:    'Auto-withdrawal sent on-chain but DB update failed',
      body:     `Withdrawal ${wd.id} txHash ${txHash} was broadcast but the DB could not be updated. Update the status manually.`,
      href:     '/admin/withdrawals',
      metadata: { withdrawalId: wd.id, txHash },
    })
  }
}
