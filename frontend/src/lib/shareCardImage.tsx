import { ImageResponse } from 'next/og'
import type { PublicShareData } from './shareCardServer'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://rupchain.com'

export const shareCardSize = { width: 1200, height: 630 }

/** Does the optional custom background (public/brand/share-bg.png) exist? */
async function hasCustomBackground(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/brand/share-bg.png`, { method: 'HEAD' })
    return res.ok
  } catch {
    return false
  }
}

/**
 * The branded card X shows when the share link is posted: fixed RupChain logo + name, one short
 * headline about the order, and the site address. Same look as the downloadable image.
 */
export async function renderShareCard(data: PublicShareData | null): Promise<ImageResponse> {
  const custom = await hasCustomBackground()
  const headline = data ? `I just bought ${data.amount} ${data.symbol} gas` : 'Get crypto gas in minutes'
  const sub = data ? `Paid in ${data.paidWith}. Delivered in minutes.` : 'Pay in PKR or USDT, from an exchange or a wallet.'

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: 64,
          background: 'linear-gradient(135deg, #0D1B2A 0%, #0b5563 100%)',
          fontFamily: 'system-ui, sans-serif',
          position: 'relative',
        }}
      >
        {custom && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`${BASE_URL}/brand/share-bg.png`} width={1200} height={630} alt="" style={{ position: 'absolute', top: 0, left: 0, width: 1200, height: 630 }} />
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, zIndex: 1 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${BASE_URL}/brand/icon-512.png`} width={84} height={84} alt="RupChain" style={{ borderRadius: 19 }} />
          <span style={{ fontSize: 44, fontWeight: 700, color: '#ffffff' }}>RupChain</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, zIndex: 1 }}>
          <span style={{ fontSize: 78, fontWeight: 800, color: '#ffffff', lineHeight: 1.1 }}>{headline}</span>
          <span style={{ fontSize: 36, fontWeight: 500, color: 'rgba(255,255,255,0.8)' }}>{sub}</span>
        </div>
        <div style={{ display: 'flex', zIndex: 1 }}>
          <span style={{ fontSize: 40, fontWeight: 700, color: '#67e8f9' }}>rupchain.com/gas</span>
        </div>
      </div>
    ),
    { ...shareCardSize },
  )
}
