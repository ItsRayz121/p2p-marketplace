/**
 * Gas-token diagnostics CLI.
 *
 *   npm run gas:diagnose-tokens          # read-only report
 *   npm run gas:diagnose-tokens -- --fix # also correct addresses to canonical
 *
 * Read-only by default: it probes each configured non-native gas token on-chain
 * and prints, per token, whether it will show in the wallet view, whether the
 * stored contract address is canonical, the on-chain probe result, a verdict, and
 * the exact remediation. Safe to run against production.
 *
 * With --fix it then rewrites any non-canonical contract address to the canonical
 * one (contractAddress only — never flips isActive/deliveryLive).
 */

import 'dotenv/config'
import { diagnoseGasTokens, fixGasTokenAddresses, type TokenVerdict } from '../lib/gas/gas.tokenDiagnostics'
import { db } from '../lib/prisma'

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m',
}

const VERDICT_STYLE: Record<TokenVerdict, { icon: string; color: string }> = {
  OK:               { icon: '✓', color: C.green },
  CANONICAL_UNKNOWN:{ icon: '✓', color: C.green },
  INACTIVE:         { icon: '•', color: C.gray },
  NOT_SUPPORTED:    { icon: '•', color: C.gray },
  RATE_LIMITED:     { icon: '!', color: C.yellow },
  RPC_ERROR:        { icon: '!', color: C.yellow },
  WRONG_ADDRESS:    { icon: '✗', color: C.red },
  ADDRESS_MISSING:  { icon: '✗', color: C.red },
  UNKNOWN_ERROR:    { icon: '✗', color: C.red },
}

async function main() {
  const doFix = process.argv.includes('--fix')

  console.log(`\n${C.bold}${C.cyan}Gas Token Diagnostics${C.reset}  ${C.dim}(read-only probe of every configured non-native token)${C.reset}`)
  console.log('─'.repeat(72))

  const report = await diagnoseGasTokens()
  if (report.length === 0) {
    console.log(`${C.yellow}No non-native gas tokens are configured.${C.reset}`)
    return
  }

  let lastChain = ''
  for (const d of report) {
    if (d.chainSlug !== lastChain) {
      lastChain = d.chainSlug
      console.log(`\n${C.bold}${d.chainSlug}${C.reset} ${C.gray}(backendChainId=${d.backendChainId ?? '—'}, rpc=${d.rpcUrl})${C.reset}`)
      if (d.hotWalletAddress) console.log(`  ${C.gray}hot wallet: ${d.hotWalletAddress}${C.reset}`)
    }
    const s = VERDICT_STYLE[d.verdict]
    const show = d.willShowInWalletView ? '' : `${C.gray} [hidden from wallet view]${C.reset}`
    console.log(`  ${s.color}${s.icon} ${d.symbol.padEnd(5)}${C.reset} ${s.color}${d.verdict}${C.reset}${show}`)
    console.log(`      ${C.gray}stored:   ${d.configuredAddress ?? '(none)'}${C.reset}`)
    if (d.canonicalAddress && d.addressMatchesCanonical === false) {
      console.log(`      ${C.gray}canonical:${C.reset} ${C.green}${d.canonicalAddress}${C.reset}`)
    }
    if (d.probeError) console.log(`      ${C.gray}probe:    ${C.red}${d.probeError}${C.reset}`)
    else if (d.probeOk) console.log(`      ${C.gray}probe:    ok (decimals=${d.probeDecimals})${C.reset}`)
    console.log(`      ${C.dim}→ ${d.remediation}${C.reset}`)
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  const counts = report.reduce<Record<string, number>>((m, d) => { m[d.verdict] = (m[d.verdict] ?? 0) + 1; return m }, {})
  console.log(`\n${'─'.repeat(72)}`)
  console.log(`${C.bold}Summary:${C.reset} ` + Object.entries(counts).map(([v, n]) => `${VERDICT_STYLE[v as TokenVerdict]?.color ?? ''}${v}=${n}${C.reset}`).join('  '))

  const needsAddressFix = report.filter((d) => d.verdict === 'WRONG_ADDRESS' && d.canonicalAddress).length
  if (needsAddressFix > 0 && !doFix) {
    console.log(`\n${C.yellow}${needsAddressFix} token(s) have a wrong address with a known canonical fix. Re-run with --fix to correct them.${C.reset}`)
  }

  // ── Optional fix ───────────────────────────────────────────────────────────────
  if (doFix) {
    console.log(`\n${C.bold}Applying canonical address corrections…${C.reset}`)
    const changes = await fixGasTokenAddresses()
    if (changes.length === 0) {
      console.log(`${C.green}Nothing to fix — all addresses already canonical.${C.reset}`)
    } else {
      for (const c of changes) {
        console.log(`  ${C.green}✓${C.reset} ${c.chain} ${c.symbol}: ${C.gray}${c.from ?? '(none)'}${C.reset} → ${C.green}${c.to}${C.reset}`)
      }
      console.log(`\n${C.green}Fixed ${changes.length} address(es). Re-run without --fix to re-verify.${C.reset}`)
    }
  }

  console.log()
}

main()
  .catch((e) => { console.error(`${C.red}Fatal:${C.reset}`, e instanceof Error ? e.message : e); process.exit(1) })
  .finally(() => db.$disconnect())
