/**
 * Chain config consistency validator.
 *
 * Checks that the three parallel chain config layers are in sync:
 *   1. chains.ts (EVM_CHAINS) — deposit system
 *   2. gas.chains.ts (GAS_CHAINS) — gas delivery system
 *   3. chainMeta.ts (CHAIN_CAPABILITIES) — capability/readiness matrix
 *
 * Usage:
 *   npx ts-node src/scripts/validateChainSync.ts
 *   npx ts-node src/scripts/validateChainSync.ts --rpc   (also verifies on-chain decimals)
 *
 * Wire as:  "check:chains": "ts-node src/scripts/validateChainSync.ts"
 */

import 'dotenv/config'
import { EVM_CHAINS } from '../lib/chains'
import { GAS_CHAINS, DbGasChain } from '../lib/gas/gas.chains'
import { CHAIN_CAPABILITIES } from '../lib/gas/chainMeta'

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const GREEN  = '\x1b[32m'
const RED    = '\x1b[31m'
const YELLOW = '\x1b[33m'
const BOLD   = '\x1b[1m'
const RESET  = '\x1b[0m'

// GAS_CHAINS ID → chainMeta uses ETH not ETHEREUM
const GAS_TO_META: Record<string, string> = { ETHEREUM: 'ETH' }
const metaKey = (gasId: string) => GAS_TO_META[gasId] ?? gasId

// DB GasChain enum values (from gas.chains.ts DbGasChain type)
const DB_GAS_CHAINS: DbGasChain[] = ['TRON','BSC','ETH','SOL','MATIC','ARB','BASE','OP','AVAX','TON','SUI']

type CheckResult = { pass: boolean; message: string; chain: string | undefined; detail: string | undefined }

const results: CheckResult[] = []

function check(pass: boolean, message: string, chain?: string, detail?: string) {
  results.push({ pass, message, chain, detail })
}

// ── Check 1: Every EVM_CHAINS entry has a GAS_CHAINS entry ───────────────────
console.log(`\n${BOLD}Check 1: EVM_CHAINS → GAS_CHAINS coverage${RESET}`)
for (const chain of EVM_CHAINS) {
  // chains.ts uses 'ethereum', gas.chains.ts uses 'ETHEREUM'
  const gasKey = chain.id.toUpperCase() === 'POLYGON' ? 'MATIC'
    : chain.id.toUpperCase() === 'ARBITRUM' ? 'ARB'
    : chain.id.toUpperCase() === 'OPTIMISM' ? 'OP'
    : chain.id.toUpperCase()
  const gasChain = GAS_CHAINS[gasKey as keyof typeof GAS_CHAINS]
  check(
    !!gasChain,
    `chains.ts "${chain.id}" → gas.chains.ts "${gasKey}"`,
    chain.id,
    gasChain ? undefined : `Missing entry in GAS_CHAINS — add "${gasKey}" to gas.chains.ts`,
  )
}

// ── Check 2: Every GAS_CHAINS entry has a CHAIN_CAPABILITIES entry ──────────
console.log(`${BOLD}Check 2: GAS_CHAINS → CHAIN_CAPABILITIES coverage${RESET}`)
for (const [gasId] of Object.entries(GAS_CHAINS)) {
  const meta = CHAIN_CAPABILITIES[metaKey(gasId)]
  check(
    !!meta,
    `gas.chains.ts "${gasId}" → chainMeta.ts "${metaKey(gasId)}"`,
    gasId,
    meta ? undefined : `Missing entry in CHAIN_CAPABILITIES — add "${metaKey(gasId)}" to chainMeta.ts`,
  )
}

// ── Check 3: Every GAS_CHAINS ID maps to a DB enum value ─────────────────────
console.log(`${BOLD}Check 3: GAS_CHAINS IDs map to DB GasChain enum${RESET}`)
for (const gasId of Object.keys(GAS_CHAINS)) {
  const dbVal = gasId === 'ETHEREUM' ? 'ETH' : gasId
  const inEnum = DB_GAS_CHAINS.includes(dbVal as DbGasChain)
  check(
    inEnum,
    `gas.chains.ts "${gasId}" → DB enum "${dbVal}"`,
    gasId,
    inEnum ? undefined : `"${dbVal}" is missing from DbGasChain type in gas.chains.ts`,
  )
}

// ── Check 4: Token contract addresses format (0x + 40 hex chars) ─────────────
console.log(`${BOLD}Check 4: Token contract address format${RESET}`)
const EVM_RE = /^0x[0-9a-fA-F]{40}$/
for (const chain of EVM_CHAINS) {
  for (const token of chain.tokens) {
    if (token.address === null) {
      check(true, `${chain.id}/${token.symbol}: null address (native asset)`, chain.id)
      continue
    }
    check(
      EVM_RE.test(token.address),
      `${chain.id}/${token.symbol}: address ${token.address}`,
      chain.id,
      EVM_RE.test(token.address) ? undefined : `Invalid address format — expected 0x + 40 hex chars`,
    )
  }
}

// ── Check 5: networkLabel uniqueness ─────────────────────────────────────────
console.log(`${BOLD}Check 5: networkLabel uniqueness in EVM_CHAINS${RESET}`)
const labelSeen = new Map<string, string>()
for (const chain of EVM_CHAINS) {
  const prev = labelSeen.get(chain.networkLabel)
  if (prev) {
    check(false, `Duplicate networkLabel "${chain.networkLabel}"`, chain.id, `Also used by "${prev}"`)
  } else {
    labelSeen.set(chain.networkLabel, chain.id)
    check(true, `networkLabel "${chain.networkLabel}" on "${chain.id}"`, chain.id)
  }
}

// ── Check 6: EVM_CHAINS minConfirmations > 0 ─────────────────────────────────
console.log(`${BOLD}Check 6: minConfirmations > 0${RESET}`)
for (const chain of EVM_CHAINS) {
  check(chain.minConfirmations > 0, `${chain.id}: minConfirmations=${chain.minConfirmations}`, chain.id,
    chain.minConfirmations > 0 ? undefined : 'minConfirmations must be > 0')
}

// ── Optional Check 7: On-chain RPC decimals verification (--rpc flag) ─────────
const rpcMode = process.argv.includes('--rpc')

async function verifyDecimalsOnChain() {
  if (!rpcMode) return

  console.log(`\n${BOLD}Check 7 (--rpc): On-chain decimals verification${RESET}`)

  const RPC_URLS: Record<string, string> = {
    ethereum: process.env.ETHEREUM_RPC_URL ?? 'https://eth.llamarpc.com',
    bsc:      process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org',
    polygon:  process.env.POLYGON_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com',
    arbitrum: process.env.ARBITRUM_RPC_URL ?? 'https://arb1.arbitrum.io/rpc',
    optimism: process.env.OPTIMISM_RPC_URL ?? 'https://mainnet.optimism.io',
    base:     process.env.BASE_RPC_URL ?? 'https://mainnet.base.org',
  }

  for (const chain of EVM_CHAINS) {
    const rpcUrl = RPC_URLS[chain.id]
    if (!rpcUrl) {
      check(false, `${chain.id}: no RPC URL configured`, chain.id, `Set ${chain.id.toUpperCase()}_RPC_URL env var`)
      continue
    }

    for (const token of chain.tokens) {
      if (!token.address) continue
      try {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: token.address, data: '0x313ce567' }, 'latest'] })
        const res = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
        const json = await res.json() as { result?: string; error?: { message: string } }
        if (json.error) throw new Error(json.error.message)
        const onChainDecimals = Number(BigInt(json.result ?? '0x0'))
        const match = onChainDecimals === token.decimals
        check(
          match,
          `${chain.id}/${token.symbol}: on-chain decimals=${onChainDecimals}, config decimals=${token.decimals}`,
          chain.id,
          match ? undefined : `MISMATCH — on-chain=${onChainDecimals} but chains.ts says ${token.decimals}`,
        )
      } catch (err) {
        check(false, `${chain.id}/${token.symbol}: RPC error`, chain.id, err instanceof Error ? err.message : 'unknown error')
      }
    }
  }
}

async function main() {
  await verifyDecimalsOnChain()

  const passed = results.filter((r) => r.pass).length
  const failed = results.filter((r) => !r.pass).length

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`${BOLD}Results: ${GREEN}${passed} passed${RESET}${BOLD}, ${failed > 0 ? RED : GREEN}${failed} failed${RESET}`)
  console.log('─'.repeat(60))

  for (const r of results) {
    if (r.pass) {
      console.log(`  ${GREEN}✓${RESET}  ${r.message}`)
    } else {
      console.log(`  ${RED}✗${RESET}  ${r.message}`)
      if (r.detail) console.log(`      ${YELLOW}→ ${r.detail}${RESET}`)
    }
  }

  if (failed > 0) {
    console.log(`\n${RED}${BOLD}${failed} check(s) failed — fix the issues above before deploying.${RESET}\n`)
    process.exit(1)
  } else {
    console.log(`\n${GREEN}${BOLD}All checks passed.${RESET}\n`)
  }
}

main().catch((err) => {
  console.error(`${RED}Fatal:${RESET}`, err instanceof Error ? err.message : err)
  process.exit(1)
})
