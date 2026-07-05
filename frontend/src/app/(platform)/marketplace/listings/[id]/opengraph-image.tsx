import { ImageResponse } from 'next/og'
import { OG_SIZE, renderTradeCard, renderFallbackCard } from '@/lib/og/tradeCard'

export const runtime = 'edge'
export const alt = 'RupChain USDT trade'
export const size = OG_SIZE
export const contentType = 'image/png'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

function labelFor(m: { label?: string; type?: string; id?: string }): string {
  return m.label ?? m.type ?? m.id ?? ''
}

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const res = await fetch(`${API_URL}/ads/${id}`, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error('not ok')
    const json = (await res.json()) as { data?: Record<string, unknown> }
    const ad = json.data
    if (!ad) throw new Error('no ad')

    const coin = String(ad.coin ?? 'USDT')
    const price = ad.price != null ? parseFloat(String(ad.price)) : null
    const minOrder = ad.minOrder != null ? Number(ad.minOrder).toLocaleString() : null
    const maxOrder = ad.maxOrder != null ? Number(ad.maxOrder).toLocaleString() : null
    const resolved = (ad.resolvedPaymentMethods as Array<{ label?: string; type?: string; id?: string }> | undefined) ?? []
    const methods = resolved.map(labelFor).filter(Boolean)
    const user = ad.user as { fullName?: string; username?: string } | undefined
    const traderName = user?.fullName || (user?.username ? `@${user.username}` : null)

    return new ImageResponse(
      renderTradeCard({
        market: 'USDT',
        side: (ad.side === 'buy' ? 'buy' : 'sell'),
        assetName: coin,
        assetSymbol: coin,
        pricePkr: price,
        minLabel: minOrder ? `${minOrder} ${coin}` : null,
        maxLabel: maxOrder ? `${maxOrder} ${coin}` : null,
        traderName,
        paymentMethods: methods,
        networkOrType: ad.network ? String(ad.network) : null,
      }),
      { ...size },
    )
  } catch {
    return new ImageResponse(renderFallbackCard('USDT'), { ...size })
  }
}
