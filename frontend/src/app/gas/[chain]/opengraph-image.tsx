import { ImageResponse } from 'next/og'
import { OG_SIZE, renderGasCard, renderGasFallbackCard } from '@/lib/og/gasCard'

export const runtime = 'edge'
export const alt = 'RupChain crypto gas fees'
export const size = OG_SIZE
export const contentType = 'image/png'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

interface NetworkFee {
  supported?: boolean
  model?: 'gas' | 'bandwidth'
  symbol?: string
  estimatedFeeNative?: number
  estimatedFeeUsd?: number | null
}
interface ChainMeta { name?: string; symbol?: string }

export default async function Image({ params }: { params: Promise<{ chain: string }> }) {
  const { chain } = await params
  const slug = chain.toLowerCase()
  try {
    const [feeRes, tokRes] = await Promise.all([
      fetch(`${API_URL}/gas-fee/chains/${slug}/network-fee`, { headers: { accept: 'application/json' } }),
      fetch(`${API_URL}/gas-fee/chains/${slug}/tokens`, { headers: { accept: 'application/json' } }),
    ])
    const feeJson = feeRes.ok ? ((await feeRes.json()) as { data?: NetworkFee }) : {}
    const tokJson = tokRes.ok ? ((await tokRes.json()) as { data?: { chain?: ChainMeta } }) : {}
    const nf = feeJson.data ?? {}
    const meta = tokJson.data?.chain ?? {}
    if (!meta.name && !tokRes.ok) throw new Error('chain not found')

    return new ImageResponse(
      renderGasCard({
        chainName: meta.name ?? slug.replace(/(^|[-\s])\w/g, (m) => m.toUpperCase()),
        chainSymbol: meta.symbol ?? slug.toUpperCase(),
        feeUsd: nf.estimatedFeeUsd ?? null,
        feeNative: nf.estimatedFeeNative ?? null,
        feeSymbol: nf.symbol ?? null,
        feeModel: nf.model ?? null,
      }),
      { ...size },
    )
  } catch {
    return new ImageResponse(renderGasFallbackCard(slug.replace(/(^|[-\s])\w/g, (m) => m.toUpperCase())), { ...size })
  }
}
