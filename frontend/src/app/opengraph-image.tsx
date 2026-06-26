import { ImageResponse } from 'next/og'

export const runtime = 'edge'
export const alt = 'RupChain — Buy & Sell Crypto in Pakistan'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://rupchain.pk'

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #0f172a 0%, #1e3a5f 50%, #0f172a 100%)',
          fontFamily: 'system-ui, sans-serif',
          position: 'relative',
        }}
      >
        {/* Grid overlay */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: 'linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(to right, rgba(255,255,255,0.04) 1px, transparent 1px)',
            backgroundSize: '60px 60px',
          }}
        />

        {/* Content */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24, zIndex: 1 }}>
          {/* Logo pill */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 999,
              padding: '10px 28px',
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`${BASE_URL}/brand/icon-192.png`}
              width={44}
              height={44}
              alt="RupChain"
              style={{ borderRadius: 10 }}
            />
            <span style={{ fontSize: 28, fontWeight: 900, color: 'white', letterSpacing: '-0.5px' }}>
              RupChain
            </span>
          </div>

          {/* Headline */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <div style={{ fontSize: 72, fontWeight: 900, color: 'white', textAlign: 'center', lineHeight: 1.1 }}>
              Buy &amp; Sell Crypto
            </div>
            <div
              style={{
                fontSize: 72,
                fontWeight: 900,
                textAlign: 'center',
                lineHeight: 1.1,
                background: 'linear-gradient(90deg, #60a5fa, #22d3ee)',
                backgroundClip: 'text',
                color: 'transparent',
              }}
            >
              in Pakistan
            </div>
          </div>

          {/* Subtext */}
          <div style={{ fontSize: 24, color: 'rgba(203,213,225,0.9)', textAlign: 'center', maxWidth: 700 }}>
            P2P trading with escrow protection · JazzCash · Easypaisa · Bank Transfer
          </div>

          {/* Feature pills */}
          <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
            {['Escrow Protected', 'KYC Verified', 'Gas Fee Service', 'PKR Payments'].map((f) => (
              <div
                key={f}
                style={{
                  fontSize: 16,
                  fontWeight: 600,
                  color: '#93c5fd',
                  background: 'rgba(59,130,246,0.15)',
                  border: '1px solid rgba(59,130,246,0.3)',
                  borderRadius: 999,
                  padding: '6px 18px',
                }}
              >
                {f}
              </div>
            ))}
          </div>
        </div>

        {/* Domain watermark */}
        <div
          style={{
            position: 'absolute',
            bottom: 32,
            right: 48,
            fontSize: 18,
            color: 'rgba(148,163,184,0.6)',
            fontWeight: 600,
          }}
        >
          rupchain.pk
        </div>
      </div>
    ),
    { ...size },
  )
}
