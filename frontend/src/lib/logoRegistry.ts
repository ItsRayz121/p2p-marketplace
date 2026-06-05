// Global logo resolution: DB-uploaded logos → static CDN fallbacks → initials avatar.
// Import this lib; use EntityLogo component or useEntityLogo hook for React usage.

export type EntityType = 'chain' | 'token' | 'payment_method' | 'bank' | 'wallet_provider'

export interface LogoMap {
  chain:           Record<string, string>
  token:           Record<string, string>
  payment_method:  Record<string, string>
  bank:            Record<string, string>
  wallet_provider: Record<string, string>
}

// ── Alias normalization ────────────────────────────────────────────────────────
// Map known name variants to the canonical slug used in GasChainConfig / DB.

const CHAIN_ALIASES: Record<string, string> = {
  // BSC / BNB variants
  'BNB':                    'BSC',
  'BINANCE':                'BSC',
  'BINANCE SMART CHAIN':    'BSC',
  'BNB CHAIN':              'BSC',
  'BNB SMART CHAIN':        'BSC',
  // Polygon / MATIC / POL variants
  'POLYGON':                'MATIC',
  'POL':                    'MATIC',
  'POLYGON POS':            'MATIC',
  // Ethereum variants
  'ETHEREUM':               'ETH',
  'ETHEREUM MAINNET':       'ETH',
  // TRON / TRX variants
  'TRX':                    'TRON',
  // Optimism variants
  'OPTIMISM':               'OP',
  'OPTIMISM MAINNET':       'OP',
  // Arbitrum variants
  'ARBITRUM':               'ARB',
  'ARBITRUM ONE':           'ARB',
  // Avalanche variants
  'AVALANCHE':              'AVAX',
  'AVALANCHE C-CHAIN':      'AVAX',
  'AVAX C-CHAIN':           'AVAX',
  // Solana
  'SOLANA':                 'SOL',
}

const TOKEN_ALIASES: Record<string, string> = {
  'USDT ERC20':    'USDT',
  'USDT BEP20':    'USDT',
  'USDT TRC20':    'USDT',
  'USDT POLYGON':  'USDT',
  'TETHER':        'USDT',
  'USDC ERC20':    'USDC',
  'USDC BEP20':    'USDC',
  'USD COIN':      'USDC',
}

export function normalizeChain(slug: string): string {
  const up = slug.toUpperCase()
  return CHAIN_ALIASES[up] ?? up
}

export function normalizeToken(symbol: string): string {
  const up = symbol.toUpperCase()
  return TOKEN_ALIASES[up] ?? up
}

export function normalizePaymentMethod(slug: string): string {
  return slug.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
}

// Map display names → canonical DB slugs for banks.
const BANK_ALIASES: Record<string, string> = {
  'allied bank':                    'allied',
  'bank alfalah':                   'bank_alfalah',
  'meezan bank':                    'meezan',
  'meezan bank (islamic)':          'meezan',
  'standard chartered':             'standard_chartered',
  'standard chartered pakistan':    'standard_chartered',
  'askari bank':                    'askari',
  'faysal bank':                    'faysal',
  'js bank':                        'js_bank',
  'bank of punjab':                 'bank_of_punjab',
  'silk bank':                      'silk_bank',
  'soneri bank':                    'soneri',
  'summit bank':                    'summit_bank',
  'national bank of pakistan (nbp)':'nbp',
  'national bank of pakistan':      'nbp',
  'habib bank limited':             'hbl',
  'muslim commercial bank':         'mcb',
  'united bank limited':            'ubl',
}

export function normalizeBank(slug: string): string {
  const lower = slug.toLowerCase()
  return BANK_ALIASES[lower] ?? lower
}

// ── Static CDN fallbacks ───────────────────────────────────────────────────────
// TrustWallet CDN for chains/tokens. PK payment methods and banks use
// icon.horse / Google gstatic / worldvectorlogo — all verified working.
// EntityLogo catches 404s and falls back to initials in all cases.

export const CHAIN_LOGO_STATIC: Record<string, string> = {
  BSC:    'https://assets.trustwallet.com/blockchains/binance/info/logo.png',
  TRON:   'https://assets.trustwallet.com/blockchains/tron/info/logo.png',
  ETH:    'https://assets.trustwallet.com/blockchains/ethereum/info/logo.png',
  MATIC:  'https://assets.trustwallet.com/blockchains/polygon/info/logo.png',
  ARB:    'https://assets.trustwallet.com/blockchains/arbitrum/info/logo.png',
  OP:     'https://assets.trustwallet.com/blockchains/optimism/info/logo.png',
  BASE:   'https://assets.trustwallet.com/blockchains/base/info/logo.png',
  AVAX:   'https://assets.trustwallet.com/blockchains/avalanchec/info/logo.png',
  SOL:    'https://assets.trustwallet.com/blockchains/solana/info/logo.png',
  TON:    'https://assets.trustwallet.com/blockchains/ton/info/logo.png',
  SUI:    'https://assets.trustwallet.com/blockchains/sui/info/logo.png',
  BTC:    'https://assets.trustwallet.com/blockchains/bitcoin/info/logo.png',
  XRP:    'https://assets.trustwallet.com/blockchains/ripple/info/logo.png',
  COSMOS: 'https://assets.trustwallet.com/blockchains/cosmos/info/logo.png',
  APTOS:  'https://assets.trustwallet.com/blockchains/aptos/info/logo.png',
}

export const TOKEN_LOGO_STATIC: Record<string, string> = {
  USDT:  'https://assets.trustwallet.com/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png',
  USDC:  'https://assets.trustwallet.com/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png',
  ETH:   'https://assets.trustwallet.com/blockchains/ethereum/info/logo.png',
  BNB:   'https://assets.trustwallet.com/blockchains/binance/info/logo.png',
  TRX:   'https://assets.trustwallet.com/blockchains/tron/info/logo.png',
  SOL:   'https://assets.trustwallet.com/blockchains/solana/info/logo.png',
  TON:   'https://assets.trustwallet.com/blockchains/ton/info/logo.png',
  SUI:   'https://assets.trustwallet.com/blockchains/sui/info/logo.png',
  AVAX:  'https://assets.trustwallet.com/blockchains/avalanchec/info/logo.png',
  POL:   'https://assets.trustwallet.com/blockchains/polygon/info/logo.png',
  MATIC: 'https://assets.trustwallet.com/blockchains/polygon/info/logo.png',
  BTC:   'https://assets.trustwallet.com/blockchains/bitcoin/info/logo.png',
  XRP:   'https://assets.trustwallet.com/blockchains/ripple/info/logo.png',
  DAI:   'https://assets.trustwallet.com/blockchains/ethereum/assets/0x6B175474E89094C44Da98b954EedeAC495271d0F/logo.png',
  WBTC:  'https://assets.trustwallet.com/blockchains/ethereum/assets/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599/logo.png',
  APT:   'https://assets.trustwallet.com/blockchains/aptos/info/logo.png',
}

// icon.horse — high-quality icon CDN by domain
// t2.gstatic.com — Google's favicon service at 128px (reliable, no auth)
// cdn.worldvectorlogo.com — vector logo CDN

export const PAYMENT_METHOD_LOGO_STATIC: Record<string, string> = {
  jazzcash:  'https://icon.horse/icon/jazzcash.com.pk',
  easypaisa: 'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://easypaisa.com.pk&size=128',
  sadapay:   'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://sadapay.pk&size=128',
  nayapay:   'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://nayapay.com&size=128',
}

export const BANK_LOGO_STATIC: Record<string, string> = {
  hbl:                'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://hbl.com&size=128',
  mcb:                'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://mcb.com.pk&size=128',
  ubl:                'https://cdn.worldvectorlogo.com/logos/ubl-united-bank-limited-pakistan.svg',
  allied:             'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://abl.com&size=128',
  bank_alfalah:       'https://icon.horse/icon/bankalfalah.com',
  meezan:             'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://meezanbank.com&size=128',
  nbp:                'https://icon.horse/icon/nbp.com.pk',
  standard_chartered: 'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://sc.com&size=128',
  askari:             'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://askaribank.com.pk&size=128',
  faysal:             'https://icon.horse/icon/faysalbank.com',
  js_bank:            'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://jsbl.com&size=128',
  bank_of_punjab:     'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://bop.com.pk&size=128',
  silk_bank:          'https://icon.horse/icon/silkbank.com.pk',
  soneri:             'https://icon.horse/icon/soneribank.com',
  // summit_bank omitted — domain defunct, falls back to initials avatar
}

// ── DB-only resolver (no static CDN fallback) ────────────────────────────────
// Used by EntityLogo to build a deduped candidate list, so each URL tier is
// tried independently rather than merged into one opaque string.

export function resolveLogoDbOnly(
  type: EntityType,
  slug: string,
  dbMap: LogoMap,
): string | null {
  switch (type) {
    case 'chain': {
      const key = normalizeChain(slug)
      return dbMap.chain[key] ?? dbMap.chain[slug.toUpperCase()] ?? null
    }
    case 'token': {
      const key = normalizeToken(slug)
      return dbMap.token[key] ?? dbMap.token[slug.toUpperCase()] ?? null
    }
    case 'payment_method': {
      const key = normalizePaymentMethod(slug)
      return dbMap.payment_method[key] ?? dbMap.payment_method[slug.toLowerCase()] ?? null
    }
    case 'bank': {
      const key = normalizeBank(slug)
      return dbMap.bank[key] ?? dbMap.bank[slug.toLowerCase()] ?? null
    }
    case 'wallet_provider': return dbMap.wallet_provider[slug.toLowerCase()] ?? null
    default: return null
  }
}

// ── Static-only resolver (no DB) ─────────────────────────────────────────────
// Returns TrustWallet CDN URL for known chains/tokens; null for everything else.

export function resolveLogoStatic(type: EntityType, slug: string): string | null {
  switch (type) {
    case 'chain': {
      const key = normalizeChain(slug)
      return CHAIN_LOGO_STATIC[key] ?? CHAIN_LOGO_STATIC[slug.toUpperCase()] ?? null
    }
    case 'token': {
      const key = normalizeToken(slug)
      return TOKEN_LOGO_STATIC[key] ?? TOKEN_LOGO_STATIC[slug.toUpperCase()] ?? null
    }
    case 'payment_method': {
      const key = normalizePaymentMethod(slug)
      return PAYMENT_METHOD_LOGO_STATIC[key] ?? PAYMENT_METHOD_LOGO_STATIC[slug.toLowerCase()] ?? null
    }
    case 'bank': {
      const key = normalizeBank(slug)
      return BANK_LOGO_STATIC[key] ?? BANK_LOGO_STATIC[slug.toLowerCase()] ?? null
    }
    default: return null
  }
}

// ── Combined resolver (DB → static) — kept for convenience ───────────────────

export function resolveLogo(
  type: EntityType,
  slug: string,
  dbMap: LogoMap | null,
): string | null {
  if (dbMap) {
    const dbUrl = resolveLogoDbOnly(type, slug, dbMap)
    if (dbUrl) return dbUrl
  }
  return resolveLogoStatic(type, slug)
}

// ── Initials avatar helpers ───────────────────────────────────────────────────

const AVATAR_COLORS = [
  'bg-blue-500',   'bg-green-500',  'bg-purple-500', 'bg-orange-500',
  'bg-red-500',    'bg-indigo-500', 'bg-pink-500',   'bg-teal-500',
  'bg-cyan-500',   'bg-amber-500',  'bg-lime-600',   'bg-rose-500',
]

export function getAvatarColor(slug: string): string {
  let hash = 0
  for (let i = 0; i < slug.length; i++) hash = (hash * 31 + slug.charCodeAt(i)) & 0xffff
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]
}

export function getInitials(slug: string): string {
  const clean = slug.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
  return clean.slice(0, 2) || '?'
}
