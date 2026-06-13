/**
 * Emergency sweep — drain all hot wallet native balances to treasury.
 *
 * Usage:
 *   npx ts-node src/scripts/emergencySweep.ts                  # dry-run (safe)
 *   npx ts-node src/scripts/emergencySweep.ts --drain          # execute all chains
 *   npx ts-node src/scripts/emergencySweep.ts --drain --chain TRON
 */

import { db } from '../lib/prisma'
import { decryptGasSeed, deriveTronPrivateKeyHex, deriveEvmPrivateKeyHex, gasWalletIsConfigured } from '../lib/gas/gasWalletService'
import { appendLedgerEntry } from '../lib/gas/gas.ledger'
import { getHotWalletBalance } from '../lib/gas/gas.balance'
import { fromDbChain } from '../lib/gas/gas.chains'
import type { GasChainId } from '../lib/gas/gas.chains'
import type { GasChain } from '@prisma/client'
import { env } from '../lib/env'

const args = process.argv.slice(2)
const isDrain = args.includes('--drain')
const chainFilter = args.includes('--chain')
  ? args[args.indexOf('--chain') + 1]?.toUpperCase()
  : null

const EVM_CHAINS: GasChain[] = ['BSC', 'ETH', 'BASE', 'ARB', 'OP', 'MATIC', 'AVAX']

async function main() {
  if (!gasWalletIsConfigured()) {
    console.error('❌ Gas mnemonic not configured — cannot sweep')
    process.exit(1)
  }

  const wallets = await db.gasHotWallet.findMany({ where: { isActive: true }, orderBy: [{ chain: 'asc' }, { hdIndex: 'asc' }] })

  console.log(`\n${'='.repeat(60)}`)
  console.log(isDrain ? '🚨 EMERGENCY SWEEP — DRAIN MODE' : '🔍 EMERGENCY SWEEP — DRY RUN')
  console.log(`${'='.repeat(60)}\n`)

  const treasuryWallets = await db.gasTreasuryWallet.findMany()
  const tronTreasury = treasuryWallets.find((t) => t.chainFamily === 'TRON')
  const evmTreasury  = treasuryWallets.find((t) => t.chainFamily === 'EVM')

  if (!tronTreasury || !evmTreasury) {
    console.error('❌ Treasury wallets not seeded — run POST /admin/gas/treasury/seed first')
    process.exit(1)
  }

  for (const wallet of wallets) {
    if (chainFilter && wallet.chain !== chainFilter) continue

    const chainId: GasChainId = fromDbChain(wallet.chain)

    let balance: number
    try {
      balance = await getHotWalletBalance(chainId, wallet.address)
    } catch (err) {
      console.log(`  ${wallet.chain}[${wallet.hdIndex}] — ⚠️  balance fetch failed: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }

    const isEvm = EVM_CHAINS.includes(wallet.chain)
    const treasuryAddr = isEvm ? evmTreasury.address : tronTreasury.address

    console.log(`  ${wallet.chain}[${wallet.hdIndex}] ${wallet.address.slice(0, 12)}...`)
    console.log(`    Balance:  ${balance} native`)
    console.log(`    Treasury: ${treasuryAddr.slice(0, 12)}...`)

    if (balance <= 0) {
      console.log(`    Skipped:  zero balance\n`)
      continue
    }

    if (!isDrain) {
      console.log(`    Action:   [DRY RUN — would drain ${balance} to treasury]\n`)
      continue
    }

    // Execute drain
    console.log(`    Draining  ${balance} → treasury...`)

    try {
      let txHash: string | undefined

      if (wallet.chain === 'TRON') {
        const seed = decryptGasSeed()
        try {
          const privateKey = deriveTronPrivateKeyHex(seed, wallet.hdIndex)
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { TronWeb } = require('tronweb') as typeof import('tronweb')
          const tronWeb = new TronWeb({
            fullHost: env.TRON_FULLNODE_URL,
            headers: env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY } : {},
            privateKey,
          })
          const sunAmount = Math.round((balance - 1) * 1_000_000) // keep 1 TRX for fees
          if (sunAmount <= 0) { console.log(`    Skipped:  balance too low after fee reserve\n`); continue }
          const result = await tronWeb.trx.sendTransaction(treasuryAddr, sunAmount)
          if (!result.result) throw new Error(`TronWeb failed: ${JSON.stringify(result)}`)
          txHash = result.txid as string
        } finally {
          seed.fill(0)
        }
      } else if (isEvm) {
        const seed = decryptGasSeed()
        try {
          const { createWalletClient, http, parseEther } = await import('viem')
          const { privateKeyToAccount } = await import('viem/accounts')
          const { mainnet, bsc, base, arbitrum, optimism, polygon, avalanche } = await import('viem/chains')
          const CHAIN_MAP: Record<string, Parameters<typeof createWalletClient>[0]['chain']> = {
            ETH: mainnet, BSC: bsc, BASE: base, ARB: arbitrum, OP: optimism, MATIC: polygon, AVAX: avalanche,
          }
          const viemChain = CHAIN_MAP[wallet.chain]
          if (!viemChain) { console.log(`    Skipped:  no viem chain for ${wallet.chain}\n`); continue }

          const rpcUrls: Record<string, string> = {
            ETH: env.ETHEREUM_RPC_URL, BSC: env.BSC_RPC_URL, BASE: env.BASE_RPC_URL,
            ARB: env.ARBITRUM_RPC_URL, OP: env.OPTIMISM_RPC_URL, MATIC: env.POLYGON_RPC_URL, AVAX: env.AVALANCHE_RPC_URL,
          }
          const rpcUrl = rpcUrls[wallet.chain] ?? ''
          const pk = deriveEvmPrivateKeyHex(seed, wallet.hdIndex)
          const account = privateKeyToAccount(pk)
          const client  = createWalletClient({ chain: viemChain, transport: http(rpcUrl), account })
          const sweepAmount = balance * 0.95 // keep 5% for gas
          txHash = await client.sendTransaction({
            account,
            to: treasuryAddr as `0x${string}`,
            value: parseEther(sweepAmount.toFixed(18)),
          })
        } finally {
          seed.fill(0)
        }
      } else {
        console.log(`    Skipped:  drain not implemented for ${wallet.chain}\n`)
        continue
      }

      await appendLedgerEntry({
        entryType:   'drain_hot_to_treasury',
        chain:       chainId,
        nativeAmount: -balance,
        txHash,
        fromAddress: wallet.address,
        toAddress:   treasuryAddr,
        notes:       `Emergency sweep script [hdIndex=${wallet.hdIndex}]`,
      })

      console.log(`    ✅ Drained — txHash: ${txHash}\n`)
    } catch (err) {
      console.error(`    ❌ Drain failed: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  console.log(isDrain ? '\n✅ Sweep complete.' : '\n(Dry-run complete — no funds moved. Add --drain to execute.)')
  process.exit(0)
}

main().catch((err) => { console.error(err); process.exit(1) })
