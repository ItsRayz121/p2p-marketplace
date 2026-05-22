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

// ── Static CDN fallbacks ───────────────────────────────────────────────────────
// TrustWallet open-source assets CDN — used only when no DB logo exists.
// The EntityLogo component catches 404s and falls back to initials.

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
}

// ── Core resolver ─────────────────────────────────────────────────────────────
// Priority: 1. DB map  2. Static CDN map  3. null (→ initials in component)

export function resolveLogo(
  type: EntityType,
  slug: string,
  dbMap: LogoMap | null,
): string | null {
  switch (type) {
    case 'chain': {
      const key = normalizeChain(slug)
      // DB first (admin-uploaded)
      if (dbMap) {
        const url = dbMap.chain[key] ?? dbMap.chain[slug.toUpperCase()]
        if (url) return url
      }
      return CHAIN_LOGO_STATIC[key] ?? CHAIN_LOGO_STATIC[slug.toUpperCase()] ?? null
    }

    case 'token': {
      const key = normalizeToken(slug)
      if (dbMap) {
        const url = dbMap.token[key] ?? dbMap.token[slug.toUpperCase()]
        if (url) return url
      }
      return TOKEN_LOGO_STATIC[key] ?? TOKEN_LOGO_STATIC[slug.toUpperCase()] ?? null
    }

    case 'payment_method': {
      const key = normalizePaymentMethod(slug)
      if (dbMap) {
        const url = dbMap.payment_method[key] ?? dbMap.payment_method[slug.toLowerCase()]
        if (url) return url
      }
      return null
    }

    case 'bank': {
      const key = slug.toLowerCase()
      if (dbMap) {
        const url = dbMap.bank[key]
        if (url) return url
      }
      return null
    }

    case 'wallet_provider': {
      const key = slug.toLowerCase()
      if (dbMap) {
        const url = dbMap.wallet_provider[key]
        if (url) return url
      }
      return null
    }

    default: return null
  }
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
