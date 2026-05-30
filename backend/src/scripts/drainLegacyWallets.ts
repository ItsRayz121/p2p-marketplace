/**
 * drainLegacyWallets.ts
 *
 * Phase 8 cleanup script — drain residual balances from the old per-chain
 * private-key wallets to the new mnemonic-derived hot wallet, then confirm
 * zero before removing GAS_WALLET_PRIVATE_KEY_* env vars from Railway.
 *
 * Usage:
 *   npx ts-node src/scripts/drainLegacyWallets.ts           # balance check only
 *   npx ts-node src/scripts/drainLegacyWallets.ts --drain   # sweep to mnemonic wallet
 *
 * Pre-conditions:
 *   - GAS_MASTER_KEY + GAS_SEED_CIPHERTEXT are set (mnemonic system is live)
 *   - GAS_WALLET_PRIVATE_KEY_TRON / _BSC / _ETH are still set in Railway
 *   - TRON_FULLNODE_URL, BSC_RPC_URL, ETHEREUM_RPC_URL are set
 *
 * After running --drain and confirming zero balances on all three chains,
 * remove GAS_WALLET_PRIVATE_KEY_TRON, GAS_WALLET_PRIVATE_KEY_BSC,
 * GAS_WALLET_PRIVATE_KEY_ETH from Railway environment variables.
 */

import { createHash } from 'node:crypto'
import { createPublicClient, createWalletClient, formatEther, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc, mainnet } from 'viem/chains'
import {
  getEvmHotWalletAddress,
  getTronHotWalletAddress,
  gasWalletIsConfigured,
} from '../lib/gas/gasWalletService'

const DRAIN = process.argv.includes('--drain')

// ── Helpers ──────────────────────────────────────────────────────────────────

const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Encode(buf: Buffer): string {
  let num = BigInt('0x' + buf.toString('hex'))
  let result = ''
  const base = BigInt(58)
  while (num > 0n) {
    result = BASE58_CHARS[Number(num % base)]! + result
    num = num / base
  }
  for (let i = 0; i < buf.length && buf[i] === 0; i++) result = '1' + result
  return result
}

function ethToTron(ethAddr: string): string {
  const raw = Buffer.from('41' + ethAddr.slice(2).toLowerCase(), 'hex')
  const h1  = createHash('sha256').update(raw).digest()
  const h2  = createHash('sha256').update(h1).digest()
  return base58Encode(Buffer.concat([raw, h2.subarray(0, 4)]))
}

function tronPrivKeyToAddress(privateKeyHex: string): string {
  const pkWith0x = ('0x' + privateKeyHex) as `0x${string}`
  const { address } = privateKeyToAccount(pkWith0x)
  return ethToTron(address)
}

// ── TRON ──────────────────────────────────────────────────────────────────────

async function tronGetBalance(address: string, nodeUrl: string, apiKey?: string): Promise<bigint> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['TRONGRID-API-Key'] = apiKey
  const res = await fetch(`${nodeUrl}/v1/accounts/${address}`, { headers, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`TronGrid accounts API ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { data?: Array<{ balance?: number }> }
  return BigInt(body.data?.[0]?.balance ?? 0)
}

async function tronGetUsdtBalance(address: string, nodeUrl: string, apiKey?: string): Promise<number> {
  const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['TRONGRID-API-Key'] = apiKey
  const url = `${nodeUrl}/v1/accounts/${address}/tokens?token_id=${USDT_TRC20}&limit=1`
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) return 0
  const body = (await res.json()) as { data?: Array<{ balance?: string }> }
  const raw = Number(body.data?.[0]?.balance ?? '0')
  return raw / 1_000_000  // TRC20 USDT has 6 decimals
}

async function tronDrain(legacyKeyHex: string, toAddress: string, nodeUrl: string, apiKey?: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { TronWeb } = require('tronweb')
  const tronWeb = new TronWeb({
    fullHost: nodeUrl,
    headers: apiKey ? { 'TRONGRID-API-Key': apiKey } : {},
    privateKey: legacyKeyHex,
  })
  const fromAddress = tronWeb.defaultAddress.base58 as string
  const balanceSun = await tronGetBalance(fromAddress, nodeUrl, apiKey)
  if (balanceSun === 0n) return '(already zero)'

  // Keep 1 TRX for bandwidth/energy fees on the drain tx itself
  const RESERVE_SUN = 1_000_000n
  const sendSun = balanceSun - RESERVE_SUN
  if (sendSun <= 0n) {
    console.log(`  TRON: balance ${Number(balanceSun) / 1e6} TRX is ≤ 1 TRX reserve — skipping drain`)
    return '(below reserve)'
  }
  const result = await tronWeb.trx.sendTransaction(toAddress, Number(sendSun))
  if (!result.result) throw new Error(`TRON drain tx failed: ${JSON.stringify(result)}`)
  return result.txid as string
}

// ── EVM (BSC / ETH) ───────────────────────────────────────────────────────────

type EvmChain = typeof bsc | typeof mainnet

async function evmGetBalance(address: string, chain: EvmChain, rpcUrl: string): Promise<bigint> {
  const client = createPublicClient({ chain, transport: http(rpcUrl) })
  return client.getBalance({ address: address as `0x${string}` })
}

async function evmGetUsdtBalance(
  address: string,
  chain: EvmChain,
  rpcUrl: string,
  contractAddress: `0x${string}`,
  decimals: number,
): Promise<number> {
  const client = createPublicClient({ chain, transport: http(rpcUrl) })
  const raw = await client.readContract({
    address: contractAddress,
    abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }] as const,
    functionName: 'balanceOf',
    args: [address as `0x${string}`],
  })
  return Number(raw) / 10 ** decimals
}

async function evmDrain(
  legacyKey: string,
  toAddress: string,
  chain: EvmChain,
  rpcUrl: string,
  symbol: string,
): Promise<string> {
  const account = privateKeyToAccount(legacyKey as `0x${string}`)
  const client = createPublicClient({ chain, transport: http(rpcUrl) })

  const balance = await client.getBalance({ address: account.address })
  if (balance === 0n) return '(already zero)'

  // Estimate gas cost with 2× safety buffer.
  // getGasPrice() returns the current estimate but viem re-estimates on submit;
  // if base fee spikes in the gap, value + actual_fee > balance → revert.
  // 2× covers any reasonable spike without leaving material funds behind.
  const gasPrice = await client.getGasPrice()
  const GAS_LIMIT = 21_000n
  const gasCost = gasPrice * GAS_LIMIT * 2n
  const sendAmount = balance - gasCost
  if (sendAmount <= 0n) {
    console.log(`  ${symbol}: balance ${formatEther(balance)} is not enough to cover gas (including 2× buffer) — skipping`)
    return '(below gas cost)'
  }

  const walletClient = createWalletClient({ chain, transport: http(rpcUrl), account })
  const hash = await walletClient.sendTransaction({
    account,
    to: toAddress as `0x${string}`,
    value: sendAmount,
  })
  return hash
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== RupChain Phase 8 — Legacy Wallet Drain ===')
  console.log(`Mode: ${DRAIN ? 'DRAIN (live transactions)' : 'CHECK (balance report only)'}`)
  console.log()

  // Verify mnemonic system is live
  if (!gasWalletIsConfigured()) {
    console.error('ERROR: GAS_MASTER_KEY / GAS_SEED_CIPHERTEXT not set.')
    console.error('The mnemonic system must be running before draining legacy wallets.')
    process.exit(1)
  }

  const tronNodeUrl  = process.env.TRON_FULLNODE_URL  ?? 'https://api.trongrid.io'
  const tronApiKey   = process.env.TRONGRID_API_KEY
  const bscRpcUrl    = process.env.BSC_RPC_URL        ?? 'https://bsc-dataseed.binance.org'
  const ethRpcUrl    = process.env.ETHEREUM_RPC_URL   ?? 'https://eth.llamarpc.com'

  const legacyTronKey = process.env.GAS_WALLET_PRIVATE_KEY_TRON
  const legacyBscKey  = process.env.GAS_WALLET_PRIVATE_KEY_BSC
  const legacyEthKey  = process.env.GAS_WALLET_PRIVATE_KEY_ETH

  // Derive mnemonic addresses (destination)
  const mnemonicTronAddr = getTronHotWalletAddress()
  const mnemonicEvmAddr  = getEvmHotWalletAddress()

  console.log('Mnemonic hot wallet addresses (DESTINATION):')
  console.log(`  TRON: ${mnemonicTronAddr ?? '(not derived)'}`)
  console.log(`  EVM:  ${mnemonicEvmAddr  ?? '(not derived)'}`)
  console.log()

  let anyNonZero    = false  // non-zero NATIVE balance (TRX / BNB / ETH)
  let anyUsdtNonZero = false  // non-zero USDT balance — manual action required

  // ── TRON ──────────────────────────────────────────────────────────────────

  console.log('── TRON ──────────────────────────────────────────────────────────')
  if (!legacyTronKey) {
    console.log('  GAS_WALLET_PRIVATE_KEY_TRON not set — skipping')
  } else {
    const legacyTronAddr = tronPrivKeyToAddress(legacyTronKey)
    if (legacyTronAddr === mnemonicTronAddr) {
      console.log('  Legacy key derives the SAME address as mnemonic — nothing to drain')
    } else {
      console.log(`  Legacy address: ${legacyTronAddr}`)
      console.log(`  Mnemonic addr:  ${mnemonicTronAddr}`)
      try {
        const trxBal   = await tronGetBalance(legacyTronAddr, tronNodeUrl, tronApiKey)
        const usdtBal  = await tronGetUsdtBalance(legacyTronAddr, tronNodeUrl, tronApiKey)
        const trxFloat = Number(trxBal) / 1_000_000
        console.log(`  TRX balance:  ${trxFloat} TRX`)
        console.log(`  USDT balance: ${usdtBal.toFixed(6)} USDT`)

        if (trxBal > 0n) anyNonZero = true
        if (usdtBal > 0) {
          anyUsdtNonZero = true
          console.log('  ⚠  USDT TRC20 balance is non-zero — drain USDT manually via TronScan before removing the key')
        }

        if (DRAIN && trxBal > 0n && mnemonicTronAddr) {
          console.log(`  Draining ${trxFloat} TRX → ${mnemonicTronAddr} ...`)
          const txid = await tronDrain(legacyTronKey, mnemonicTronAddr, tronNodeUrl, tronApiKey)
          console.log(`  TX: ${txid}`)
        }
      } catch (err) {
        console.error(`  ERROR checking TRON balance: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  console.log()

  // ── BSC ───────────────────────────────────────────────────────────────────

  console.log('── BSC ───────────────────────────────────────────────────────────')
  if (!legacyBscKey) {
    console.log('  GAS_WALLET_PRIVATE_KEY_BSC not set — skipping')
  } else {
    const legacyBscAddr = privateKeyToAccount(legacyBscKey as `0x${string}`).address
    if (legacyBscAddr.toLowerCase() === mnemonicEvmAddr?.toLowerCase()) {
      console.log('  Legacy key derives the SAME address as mnemonic — nothing to drain')
    } else {
      console.log(`  Legacy address: ${legacyBscAddr}`)
      console.log(`  Mnemonic addr:  ${mnemonicEvmAddr}`)
      try {
        const bnbBal  = await evmGetBalance(legacyBscAddr, bsc, bscRpcUrl)
        const usdtBal = await evmGetUsdtBalance(
          legacyBscAddr, bsc, bscRpcUrl,
          '0x55d398326f99059fF775485246999027B3197955', 18,
        )
        console.log(`  BNB balance:  ${formatEther(bnbBal)} BNB`)
        console.log(`  USDT balance: ${usdtBal.toFixed(6)} USDT`)

        if (bnbBal > 0n) anyNonZero = true
        if (usdtBal > 0) {
          anyUsdtNonZero = true
          console.log('  ⚠  USDT BEP20 balance is non-zero — drain USDT manually via BscScan before removing the key')
        }

        if (DRAIN && bnbBal > 0n && mnemonicEvmAddr) {
          console.log(`  Draining BNB → ${mnemonicEvmAddr} ...`)
          const hash = await evmDrain(legacyBscKey, mnemonicEvmAddr, bsc, bscRpcUrl, 'BNB')
          console.log(`  TX: ${hash}`)
        }
      } catch (err) {
        console.error(`  ERROR checking BSC balance: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  console.log()

  // ── Ethereum ─────────────────────────────────────────────────────────────

  console.log('── Ethereum ──────────────────────────────────────────────────────')
  if (!legacyEthKey) {
    console.log('  GAS_WALLET_PRIVATE_KEY_ETH not set — skipping')
  } else {
    const legacyEthAddr = privateKeyToAccount(legacyEthKey as `0x${string}`).address
    if (legacyEthAddr.toLowerCase() === mnemonicEvmAddr?.toLowerCase()) {
      console.log('  Legacy key derives the SAME address as mnemonic — nothing to drain')
    } else {
      console.log(`  Legacy address: ${legacyEthAddr}`)
      console.log(`  Mnemonic addr:  ${mnemonicEvmAddr}`)
      try {
        const ethBal  = await evmGetBalance(legacyEthAddr, mainnet, ethRpcUrl)
        const usdtBal = await evmGetUsdtBalance(
          legacyEthAddr, mainnet, ethRpcUrl,
          '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6,
        )
        console.log(`  ETH balance:  ${formatEther(ethBal)} ETH`)
        console.log(`  USDT balance: ${usdtBal.toFixed(6)} USDT`)

        if (ethBal > 0n) anyNonZero = true
        if (usdtBal > 0) {
          anyUsdtNonZero = true
          console.log('  ⚠  USDT ERC20 balance is non-zero — drain USDT manually via Etherscan before removing the key')
        }

        if (DRAIN && ethBal > 0n && mnemonicEvmAddr) {
          console.log(`  Draining ETH → ${mnemonicEvmAddr} ...`)
          const hash = await evmDrain(legacyEthKey, mnemonicEvmAddr, mainnet, ethRpcUrl, 'ETH')
          console.log(`  TX: ${hash}`)
        }
      } catch (err) {
        console.error(`  ERROR checking ETH balance: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  console.log()

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log('── Summary ───────────────────────────────────────────────────────')
  if (DRAIN && anyNonZero) {
    console.log('Drain transactions sent. Wait for on-chain confirmation, then re-run (no --drain) to verify zero.')
  } else if (!anyNonZero && !anyUsdtNonZero) {
    console.log('✓ All legacy wallets are at zero native AND USDT balance.')
    console.log('  Safe to remove GAS_WALLET_PRIVATE_KEY_TRON / _BSC / _ETH from Railway.')
  } else if (!anyNonZero && anyUsdtNonZero) {
    console.log('⚠  Native balances are zero but USDT is still present on one or more legacy wallets.')
    console.log('  Manually sweep USDT via the chain explorer (TronScan / BscScan / Etherscan),')
    console.log('  then re-run this script to confirm zero before removing keys from Railway.')
    process.exitCode = 1
  } else {
    console.log('Non-zero native balance(s) detected. Run with --drain to sweep to the mnemonic hot wallet.')
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
