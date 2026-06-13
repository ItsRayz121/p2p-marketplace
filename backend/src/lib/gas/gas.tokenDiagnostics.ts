/**
 * Gas-token health diagnostics — shared by the CLI (`npm run gas:diagnose-tokens`)
 * and the admin "Token Diagnostics" panel.
 *
 * For every configured non-native gas token it answers three questions an admin
 * can't answer from the wallet view alone:
 *
 *   1. Will this token even APPEAR in the hot-wallet view? (active + has address)
 *   2. Is the stored contract address the CANONICAL one for that chain?
 *   3. Does a real token actually live at that address on-chain (probe), and if
 *      not, is the cause a wrong address, a flaky/rate-limited RPC, or an
 *      unsupported chain family?
 *
 * The verdict logic deliberately disambiguates "wrong address" from "RPC error":
 * a probe that fails while the stored address ALREADY equals the canonical one is
 * an RPC problem, not an address problem — the earlier blanket "fix the address"
 * assumption would not have helped there.
 *
 * This is the single source of truth for canonical USDT/USDC addresses; the seed
 * and the config-restrict script should converge on CANONICAL_GAS_TOKENS over time
 * (see the address-drift loophole noted in project memory).
 */

import { db } from '../prisma'
import { env } from '../env'
import { getHotWalletTokenBalance } from './gas.tokenBalance'

// ── Canonical token contracts (backendChainId → symbol → address) ───────────────
// EVM addresses are checksum-as-published; comparisons are case-insensitive.
export const CANONICAL_GAS_TOKENS: Record<string, Record<string, string>> = {
  BSC:   { USDT: '0x55d398326f99059fF775485246999027B3197955', USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' },
  ETH:   { USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7', USDC: '0xA0b86991c6218b36c1D19D4a2e9Eb0cE3606eB48' },
  BASE:  { USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  ARB:   { USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
  OP:    { USDT: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' },
  MATIC: { USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
  AVAX:  { USDT: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', USDC: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E' },
  TRON:  { USDT: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',         USDC: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8' },
  APT:   {
    USDT: '0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b',
    USDC: '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b',
  },
  SOL:   { USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  // SUI uses coin-type identifiers (package::module::TYPE), not bare addresses.
  // Only native USDC (Circle) exists here. There is NO native USDT on Sui — the
  // only USDT is Wormhole-bridged, which we deliberately do not offer, so it is
  // intentionally absent (operator decision, 2026-06-13).
  SUI:   { USDC: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC' },
  // TON jettons. USDT is the official Tether jetton master. Circle does NOT issue
  // USDC on TON, so there is no USDC entry (the TON USDC config is removed, not
  // corrected) — operator decision, 2026-06-13.
  TON:   { USDT: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs' },
}

// backendChainId → RPC URL we actually read balances through (for display/diagnosis).
const RPC_FOR_CHAIN: Record<string, string> = {
  BSC:   env.BSC_RPC_URL,
  ETH:   env.ETHEREUM_RPC_URL,
  BASE:  env.BASE_RPC_URL,
  ARB:   env.ARBITRUM_RPC_URL,
  OP:    env.OPTIMISM_RPC_URL,
  MATIC: env.POLYGON_RPC_URL,
  AVAX:  env.AVALANCHE_RPC_URL,
  TRON:  env.TRON_FULLNODE_URL,
  SOL:   env.SOL_RPC_URL,
  SUI:   env.SUI_RPC_URL,
  TON:   env.TON_ENDPOINT_URL,
  APT:   env.APTOS_FULLNODE_URL,
}

// Families we have no live token-balance reader for yet. SOL (SPL), SUI (Coin<T>)
// and TON (jetton) all have readers now — leave this empty unless a new family is
// added before its reader lands.
const UNSUPPORTED_FAMILIES = new Set<string>([])

export type TokenVerdict =
  | 'OK'                // probe succeeded and address is canonical (or canonical unknown)
  | 'WRONG_ADDRESS'     // stored address differs from canonical and/or no token lives there
  | 'ADDRESS_MISSING'   // no contract address stored — can never appear or deliver
  | 'INACTIVE'          // isActive=false — hidden from the wallet view by design
  | 'RATE_LIMITED'      // RPC returned 429 — address fine, needs an API key / backoff
  | 'NOT_SUPPORTED'     // chain family has no balance reader (SOL/TON/SUI)
  | 'RPC_ERROR'         // address IS canonical but probe still failed → RPC/node problem
  | 'CANONICAL_UNKNOWN' // probe ok but we have no canonical reference to compare against
  | 'UNKNOWN_ERROR'

export interface TokenDiagnostic {
  chainSlug: string
  backendChainId: string | null
  chainType: string | null
  addressType: string | null
  rpcUrl: string
  hotWalletAddress: string | null
  symbol: string
  name: string | null
  tokenType: string
  isActive: boolean
  deliveryLive: boolean
  configuredAddress: string | null
  canonicalAddress: string | null
  addressMatchesCanonical: boolean | null
  probeOk: boolean | null
  probeDecimals: number | null
  probeError: string | null
  /** Mirrors the exact filter the hot-wallet token view uses. */
  willShowInWalletView: boolean
  verdict: TokenVerdict
  remediation: string
}

function mask(url: string): string {
  // Hide API keys embedded in RPC URLs (…/v2/<key>, ?apikey=<key>).
  return url
    .replace(/(\/v\d+\/)[A-Za-z0-9_-]{8,}/i, '$1***')
    .replace(/([?&](?:api[_-]?key|key|token)=)[^&]+/i, '$1***')
}

function isRateLimited(msg: string): boolean {
  return /\b429\b|too many requests|rate.?limit/i.test(msg)
}
function isNoCodeAtAddress(msg: string): boolean {
  // viem's signature for "no contract / wrong address": decimals returned no data (0x).
  return /returned no data|0x\b|no data|reverted|execution reverted|is not a function/i.test(msg)
}

// A throwaway owner address per family — decimals() ignores it; balanceOf just returns 0.
function fallbackOwner(family: string): string {
  switch (family) {
    case 'TRON':  return 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
    case 'APT':
    case 'APTOS': return '0x1'
    case 'SOL':   return '11111111111111111111111111111111'
    default:      return '0x000000000000000000000000000000000000dEaD'
  }
}

async function resolveHotWallet(backendChainId: string | null, chainType: string | null): Promise<string | null> {
  if (!backendChainId) return null
  if (backendChainId === 'APT' || (chainType || '').toUpperCase() === 'APTOS') {
    try {
      const { getAptosHotWalletAddress } = await import('./aptosWalletService')
      return getAptosHotWalletAddress()
    } catch { return null }
  }
  const w = await db.gasHotWallet.findFirst({
    where: { chain: backendChainId as 'TRON' | 'BSC' | 'ETH' | 'SOL' | 'MATIC' | 'ARB' | 'BASE' | 'OP' | 'AVAX' | 'TON' | 'SUI' },
  }).catch(() => null)
  return w?.address ?? null
}

/**
 * Run a full diagnostic over every configured gas chain + its non-native tokens.
 * Read-only: probes on-chain but never writes. Safe to run against production.
 */
export async function diagnoseGasTokens(): Promise<TokenDiagnostic[]> {
  const chains = await db.gasChainConfig.findMany({
    include: { tokens: { orderBy: { displayOrder: 'asc' } } },
    orderBy: { displayOrder: 'asc' },
  })

  const out: TokenDiagnostic[] = []

  for (const chain of chains) {
    const dbChain = chain.backendChainId ?? chain.slug.toUpperCase()
    const hotWallet = await resolveHotWallet(chain.backendChainId, chain.chainType)
    const canonForChain = CANONICAL_GAS_TOKENS[dbChain] ?? {}
    const rpcUrl = RPC_FOR_CHAIN[dbChain] ?? '(unknown)'

    for (const t of chain.tokens) {
      if (t.tokenType === 'native') continue // native balance is its own path

      const sym = t.symbol.toUpperCase()
      const configured = t.contractAddress?.trim() || null
      const canonical = canonForChain[sym] ?? null
      const matches =
        configured && canonical ? configured.toLowerCase() === canonical.toLowerCase() : null

      const willShow = t.isActive && configured != null

      let probeOk: boolean | null = null
      let probeDecimals: number | null = null
      let probeError: string | null = null
      let verdict: TokenVerdict
      let remediation: string

      const owner = hotWallet ?? fallbackOwner(dbChain)

      if (!configured) {
        verdict = 'ADDRESS_MISSING'
        remediation = canonical
          ? `Set contract address to the canonical ${sym}: ${canonical} (admin → Gas Chains → ${chain.slug} → ${sym}, or run the fixer).`
          : `Set the ${sym} contract address for ${chain.slug}. No canonical reference on file — verify with: npm run verify:token -- --chain ${chain.slug.toLowerCase()} --symbol ${sym}`
      } else if (UNSUPPORTED_FAMILIES.has(dbChain)) {
        verdict = 'NOT_SUPPORTED'
        remediation = `Live balance reads aren't implemented for ${dbChain} yet. Address may be correct; the wallet view will show "read failed" until a reader is added. Not a misconfiguration.`
      } else {
        // Probe on-chain.
        try {
          const r = await getHotWalletTokenBalance(dbChain, configured, owner)
          probeOk = true
          probeDecimals = r.decimals
        } catch (e) {
          probeOk = false
          probeError = e instanceof Error ? e.message.slice(0, 200) : 'probe failed'
        }

        if (probeOk) {
          if (matches === false) {
            verdict = 'WRONG_ADDRESS'
            remediation = `A token exists at the stored address, but it isn't the canonical ${sym}. Replace with ${canonical}.`
          } else {
            verdict = canonical ? 'OK' : 'CANONICAL_UNKNOWN'
            remediation = canonical
              ? 'Address verified on-chain and matches canonical. No action needed.'
              : 'Token verified on-chain (no canonical reference to compare). Looks healthy.'
          }
        } else if (probeError && isRateLimited(probeError)) {
          verdict = 'RATE_LIMITED'
          remediation =
            dbChain === 'TRON'
              ? 'RPC rate-limited (429). Set TRONGRID_API_KEY in the backend env so reads use an authenticated TronGrid endpoint.'
              : `RPC rate-limited (429) on ${rpcUrl}. Add an API key / dedicated RPC for ${dbChain}.`
        } else if (probeError && isNoCodeAtAddress(probeError)) {
          // No token at the address. If the stored address already equals canonical,
          // the address is right and the RPC/node is the problem — don't "fix" the address.
          if (matches === true) {
            verdict = 'RPC_ERROR'
            remediation = `Stored address is already canonical, yet no token responded via ${rpcUrl}. The RPC endpoint is the problem — switch ${dbChain}'s RPC to a healthy node (env ${dbChain}_RPC_URL).`
          } else if (canonical) {
            verdict = 'WRONG_ADDRESS'
            remediation = `No token contract at the stored address — it's wrong. Replace with the canonical ${sym}: ${canonical} (run the fixer or edit in Gas Chains).`
          } else {
            verdict = 'WRONG_ADDRESS'
            remediation = `No token contract at the stored address and no canonical reference on file. Verify the correct address: npm run verify:token -- --chain ${chain.slug.toLowerCase()} --symbol ${sym}`
          }
        } else {
          verdict = 'UNKNOWN_ERROR'
          remediation = `Unexpected read error via ${rpcUrl}: ${probeError ?? 'unknown'}. Check the RPC and address.`
        }
      }

      // Inactive overrides messaging about appearing in the view, but keep the
      // address verdict so an admin sees both facts.
      if (!t.isActive && (verdict === 'OK' || verdict === 'CANONICAL_UNKNOWN')) {
        verdict = 'INACTIVE'
        remediation = 'Address is healthy but the token is inactive, so it is hidden from the wallet view. Activate it in Gas Chains to show it.'
      }

      out.push({
        chainSlug: chain.slug,
        backendChainId: chain.backendChainId,
        chainType: chain.chainType,
        addressType: chain.addressType,
        rpcUrl: mask(rpcUrl),
        hotWalletAddress: hotWallet,
        symbol: t.symbol,
        name: t.name,
        tokenType: t.tokenType,
        isActive: t.isActive,
        deliveryLive: t.deliveryLive,
        configuredAddress: configured,
        canonicalAddress: canonical,
        addressMatchesCanonical: matches,
        probeOk,
        probeDecimals,
        probeError,
        willShowInWalletView: willShow,
        verdict,
        remediation,
      })
    }
  }

  return out
}

/**
 * Apply canonical address corrections to every non-native token whose stored
 * address differs from CANONICAL_GAS_TOKENS. Returns the list of changes made.
 * Only touches contractAddress — never flips isActive / deliveryLive.
 */
export async function fixGasTokenAddresses(): Promise<
  Array<{ chain: string; symbol: string; from: string | null; to: string }>
> {
  const changes: Array<{ chain: string; symbol: string; from: string | null; to: string }> = []
  const chains = await db.gasChainConfig.findMany({ include: { tokens: true } })

  for (const chain of chains) {
    const dbChain = chain.backendChainId ?? chain.slug.toUpperCase()
    const canon = CANONICAL_GAS_TOKENS[dbChain]
    if (!canon) continue
    for (const t of chain.tokens) {
      if (t.tokenType === 'native') continue
      const want = canon[t.symbol.toUpperCase()]
      if (!want) continue
      if ((t.contractAddress ?? '').toLowerCase() !== want.toLowerCase()) {
        await db.gasTokenConfig.update({ where: { id: t.id }, data: { contractAddress: want } })
        changes.push({ chain: chain.slug, symbol: t.symbol, from: t.contractAddress ?? null, to: want })
      }
    }
  }
  return changes
}
