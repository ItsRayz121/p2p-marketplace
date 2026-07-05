import { ImageResponse } from 'next/og'
import { OG_SIZE, renderTradeCard, renderFallbackCard } from '@/lib/og/tradeCard'

export const runtime = 'edge'
export const alt = 'RupChain community token trade'
export const size = OG_SIZE
export const contentType = 'image/png'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

function labelFor(m: { label?: string; type?: string; id?: string }): string {
  return m.label ?? m.type ?? m.id ?? ''
}

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const res = await fetch(`${API_URL}/ctm/listings/${id}`, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error('not ok')
    const json = (await res.json()) as { data?: Record<string, unknown> }
    const l = json.data
    if (!l) throw new Error('no listing')

    const token = (l.token as { name?: string; symbol?: string } | undefined) ?? {}
    const sym = String(token.symbol ?? 'CTM')
    const name = String(token.name ?? 'Community Token')
    const price = l.pricePerUnit != null ? parseFloat(String(l.pricePerUnit)) : null
    const minTok = l.minOrderTokens != null ? Number(l.minOrderTokens).toLocaleString() : null
    const maxTok = l.maxOrderTokens != null ? Number(l.maxOrderTokens).toLocaleString() : null
    const resolved = (l.resolvedPaymentMethods as Array<{ label?: string; type?: string; id?: string }> | undefined) ?? []
    const methods = resolved.map(labelFor).filter(Boolean)
    const mp = l.merchantProfile as { user?: { fullName?: string; username?: string } } | undefined
    const traderName = mp?.user?.fullName || (mp?.user?.username ? `@${mp.user.username}` : null)

    return new ImageResponse(
      renderTradeCard({
        market: 'CTM',
        side: (l.side === 'buy' ? 'buy' : 'sell'),
        assetName: name,
        assetSymbol: sym,
        pricePkr: price,
        minLabel: minTok ? `${minTok} ${sym}` : null,
        maxLabel: maxTok ? `${maxTok} ${sym}` : null,
        traderName,
        paymentMethods: methods,
      }),
      { ...size },
    )
  } catch {
    return new ImageResponse(renderFallbackCard('CTM'), { ...size })
  }
}
