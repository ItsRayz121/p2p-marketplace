/* Shared Open Graph "trade card" used by the per-listing opengraph-image routes.
   Rendered by next/og's ImageResponse (edge runtime) so a shared trade link
   unfurls into a rich card showing the trade's details on Telegram / WhatsApp /
   X / Facebook / Slack etc. — the "trade image" alongside the link. */

export const OG_SIZE = { width: 1200, height: 630 }

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://rupchain.com'

export interface TradeCardProps {
  market: 'USDT' | 'CTM'
  side: 'buy' | 'sell'
  assetName: string
  assetSymbol: string
  pricePkr: number | null
  minLabel: string | null
  maxLabel: string | null
  traderName: string | null
  paymentMethods: string[]
  networkOrType?: string | null
}

const fmtPkr = (n: number) => n.toLocaleString('en-PK', { maximumFractionDigits: n < 1 ? 4 : 2 })

export function renderTradeCard(p: TradeCardProps) {
  const isSell = p.side === 'sell'
  const sideLabel = isSell ? 'SELLING' : 'BUYING'
  const sideColor = isSell ? '#10b981' : '#3b82f6'
  const methods = p.paymentMethods.slice(0, 4)

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'linear-gradient(135deg, #0f172a 0%, #1e3a5f 55%, #0f172a 100%)',
        fontFamily: 'system-ui, sans-serif',
        position: 'relative',
        padding: 56,
      }}
    >
      {/* Grid overlay */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(to right, rgba(255,255,255,0.04) 1px, transparent 1px)',
          backgroundSize: '60px 60px',
        }}
      />

      {/* Header: brand + market + side */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', zIndex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${BASE_URL}/brand/icon-192.png`} width={52} height={52} alt="RupChain" style={{ borderRadius: 12 }} />
          <span style={{ fontSize: 32, fontWeight: 900, color: 'white', letterSpacing: '-0.5px' }}>RupChain</span>
          <span
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: '#cbd5e1',
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 999,
              padding: '4px 16px',
              marginLeft: 6,
            }}
          >
            {p.market === 'USDT' ? 'USDT Market' : 'Community Token'}
          </span>
        </div>
        <div
          style={{
            fontSize: 24,
            fontWeight: 900,
            color: 'white',
            background: sideColor,
            borderRadius: 999,
            padding: '8px 26px',
            letterSpacing: '1px',
          }}
        >
          {sideLabel}
        </div>
      </div>

      {/* Asset + price */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 54, zIndex: 1 }}>
        <div style={{ fontSize: 40, fontWeight: 800, color: 'white', display: 'flex' }}>
          {p.assetName} <span style={{ color: '#94a3b8', marginLeft: 14 }}>{p.assetSymbol}</span>
        </div>
        {p.pricePkr !== null && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
            <span
              style={{
                fontSize: 92,
                fontWeight: 900,
                lineHeight: 1,
                background: 'linear-gradient(90deg, #60a5fa, #22d3ee)',
                backgroundClip: 'text',
                color: 'transparent',
              }}
            >
              PKR {fmtPkr(p.pricePkr)}
            </span>
            <span style={{ fontSize: 30, color: '#94a3b8' }}>/ {p.assetSymbol}</span>
          </div>
        )}
      </div>

      {/* Meta rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 'auto', zIndex: 1 }}>
        {(p.minLabel || p.maxLabel) && (
          <div style={{ fontSize: 26, color: '#cbd5e1', display: 'flex' }}>
            Limit: {p.minLabel ?? '—'} – {p.maxLabel ?? '—'}
          </div>
        )}
        {p.traderName && (
          <div style={{ fontSize: 26, color: '#cbd5e1', display: 'flex' }}>Trader: {p.traderName}</div>
        )}
        {methods.length > 0 && (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {methods.map((m) => (
              <div
                key={m}
                style={{
                  fontSize: 18,
                  fontWeight: 600,
                  color: '#93c5fd',
                  background: 'rgba(59,130,246,0.15)',
                  border: '1px solid rgba(59,130,246,0.3)',
                  borderRadius: 999,
                  padding: '6px 18px',
                }}
              >
                {m}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: 28,
          zIndex: 1,
        }}
      >
        <span style={{ fontSize: 20, color: '#93c5fd', fontWeight: 600 }}>Protected P2P trade · Tap to open</span>
        <span style={{ fontSize: 20, color: 'rgba(148,163,184,0.7)', fontWeight: 600 }}>rupchain.com</span>
      </div>
    </div>
  )
}

/** Fallback card when a listing can't be fetched (expired / private / error). */
export function renderFallbackCard(market: 'USDT' | 'CTM') {
  return renderTradeCard({
    market,
    side: 'sell',
    assetName: market === 'USDT' ? 'USDT' : 'Community Tokens',
    assetSymbol: market === 'USDT' ? 'USDT' : 'CTM',
    pricePkr: null,
    minLabel: null,
    maxLabel: null,
    traderName: null,
    paymentMethods: ['JazzCash', 'Easypaisa', 'Bank Transfer'],
  })
}
