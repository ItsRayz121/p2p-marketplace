import { ImageResponse } from 'next/og'
import { OG_SIZE, renderGasCard, renderGasFallbackCard } from '@/lib/og/gasCard'

export const runtime = 'edge'
export const alt = 'RupChain crypto gas fees'
export const size = OG_SIZE
export const contentType = 'image/png'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

interface NetworkFee {
  model?: 'gas' | 'bandwidth'
  symbol?: string
  estimatedFeeNative?: number
  estimatedFeeUsd?: number | null
}
interface Tok { name?: string; symbol?: string; rawUsdPrice?: number; priceUsd?: number }
interface TokensData { chain?: { name?: string; symbol?: string }; tokens?: Tok[] }

export default async function Image({ params }: { params: Promise<{ chain: string; token: string }> }) {
  const { chain, token } = await params
  const slug = chain.toLowerCase()
  const want = token.toLowerCase()
  const titleCase = (s: string) => s.replace(/(^|[-\s])\w/g, (m) => m.toUpperCase())
  try {
    const [feeRes, tokRes] = await Promise.all([
      fetch(`${API_URL}/gas-fee/chains/${slug}/network-fee`, { headers: { accept: 'application/json' } }),
      fetch(`${API_URL}/gas-fee/chains/${slug}/tokens`, { headers: { accept: 'application/json' } }),
    ])
    const nf = feeRes.ok ? ((await feeRes.json()) as { data?: NetworkFee }).data ?? {} : {}
    const td = tokRes.ok ? ((await tokRes.json()) as { data?: TokensData }).data ?? {} : {}
    if (!tokRes.ok) throw new Error('chain not found')

    const t = (td.tokens ?? []).find((x) => (x.symbol ?? '').toLowerCase() === want)
    const price = t?.rawUsdPrice ?? t?.priceUsd ?? null

    return new ImageResponse(
      renderGasCard({
        chainName: td.chain?.name ?? titleCase(slug),
        chainSymbol: td.chain?.symbol ?? slug.toUpperCase(),
        tokenName: t?.name ?? token.toUpperCase(),
        tokenSymbol: t?.symbol ?? token.toUpperCase(),
        tokenPriceUsd: price,
        feeUsd: nf.estimatedFeeUsd ?? null,
        feeNative: nf.estimatedFeeNative ?? null,
        feeSymbol: nf.symbol ?? null,
        feeModel: nf.model ?? null,
      }),
      { ...size },
    )
  } catch {
    return new ImageResponse(renderGasFallbackCard(titleCase(slug)), { ...size })
  }
}
