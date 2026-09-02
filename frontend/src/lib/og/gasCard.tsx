/* Shared Open Graph "gas card" used by the /gas/<chain>[/<token>] opengraph-image
   routes. Rendered by next/og's ImageResponse (edge runtime) so a shared gas-fee
   link unfurls into a rich card that leads with the LIVE network fee — the whole
   reason someone shares "look how cheap gas is on X right now".

   Satori constraints honoured: inline styles only; any element with >1 child is
   explicitly display:flex; multi-part strings are pre-joined into a single text
   node; NO emoji (Satori resolves emoji via a network fetch that we don't want
   on the edge path). */

export const OG_SIZE = { width: 1200, height: 630 }

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://rupchain.com'

export interface GasCardProps {
  chainName: string
  chainSymbol: string
  /** Scoped to one token on the chain, when present. */
  tokenName?: string | null
  tokenSymbol?: string | null
  /** Live market price of the scoped token, USD. */
  tokenPriceUsd?: number | null
  /** Estimated cost of a standard transfer on this chain. */
  feeUsd?: number | null
  feeNative?: number | null
  feeSymbol?: string | null
  /** 'gas' (EVM) or 'bandwidth' (TRON) — tweaks the caption. */
  feeModel?: 'gas' | 'bandwidth' | null
}

const fmtUsd = (n: number) =>
  n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(4)}` : `$${n.toPrecision(2)}`

const fmtNative = (n: number) =>
  n >= 1 ? n.toFixed(3) : n.toPrecision(3)

export function renderGasCard(p: GasCardProps) {
  const scoped = !!p.tokenSymbol
  const hasFee = (p.feeUsd != null && p.feeUsd > 0) || (p.feeNative != null && p.feeNative > 0)

  const feeHeadline = p.feeUsd != null && p.feeUsd > 0
    ? `≈ ${fmtUsd(p.feeUsd)}`
    : p.feeNative != null && p.feeNative > 0
      ? `≈ ${fmtNative(p.feeNative)} ${p.feeSymbol ?? ''}`.trim()
      : 'Live rate'

  const feeCaption = hasFee
    ? `${p.feeModel === 'bandwidth' ? 'per transfer (bandwidth)' : 'per transfer'} on ${p.chainName}`
    : `network fee on ${p.chainName}`

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
          display: 'flex',
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(to right, rgba(255,255,255,0.04) 1px, transparent 1px)',
          backgroundSize: '60px 60px',
        }}
      />

      {/* Header: brand + product badge + chain */}
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
            Gas Fees
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: 24,
            fontWeight: 900,
            color: 'white',
            background: '#f59e0b',
            borderRadius: 999,
            padding: '8px 26px',
            letterSpacing: '1px',
          }}
        >
          {p.chainSymbol}
        </div>
      </div>

      {/* Chain + live fee */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 52, zIndex: 1 }}>
        <div style={{ fontSize: 40, fontWeight: 800, color: 'white', display: 'flex' }}>
          <span>{`${p.chainName} gas`}</span>
          {scoped && <span style={{ color: '#94a3b8', marginLeft: 14 }}>{`· ${p.tokenSymbol}`}</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <span
            style={{
              fontSize: 92,
              fontWeight: 900,
              lineHeight: 1,
              background: 'linear-gradient(90deg, #fbbf24, #f97316)',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            {feeHeadline}
          </span>
        </div>
        <div style={{ fontSize: 28, color: '#94a3b8', display: 'flex' }}>{feeCaption}</div>
      </div>

      {/* Meta rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 'auto', zIndex: 1 }}>
        {scoped && p.tokenPriceUsd != null && p.tokenPriceUsd > 0 && (
          <div style={{ fontSize: 26, color: '#cbd5e1', display: 'flex' }}>
            {`${p.tokenName ?? p.tokenSymbol}: $${p.tokenPriceUsd < 1 ? p.tokenPriceUsd.toFixed(4) : p.tokenPriceUsd.toFixed(2)} / ${p.tokenSymbol}`}
          </div>
        )}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {['JazzCash', 'Easypaisa', 'USDT'].map((m) => (
            <div
              key={m}
              style={{
                display: 'flex',
                fontSize: 18,
                fontWeight: 600,
                color: '#fcd34d',
                background: 'rgba(245,158,11,0.15)',
                border: '1px solid rgba(245,158,11,0.3)',
                borderRadius: 999,
                padding: '6px 18px',
              }}
            >
              {m}
            </div>
          ))}
        </div>
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
        <span style={{ fontSize: 20, color: '#fcd34d', fontWeight: 600 }}>Instant delivery · Tap to top up</span>
        <span style={{ fontSize: 20, color: 'rgba(148,163,184,0.7)', fontWeight: 600 }}>rupchain.com</span>
      </div>
    </div>
  )
}

/** Fallback card when the chain / fee can't be fetched. */
export function renderGasFallbackCard(chainName?: string) {
  return renderGasCard({
    chainName: chainName ?? 'Crypto',
    chainSymbol: 'GAS',
    feeUsd: null,
    feeNative: null,
    feeSymbol: null,
  })
}
