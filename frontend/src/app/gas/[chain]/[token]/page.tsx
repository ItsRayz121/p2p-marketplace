import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { buildMeta } from '@/lib/metadata'
import { GasFlowClient } from '../../_components/GasFlowClient'

const RESERVED = new Set(['orders', 'giveaway', 'referral'])

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

async function chainName(slug: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_URL}/gas-fee/chains/${slug}/tokens`, {
      headers: { accept: 'application/json' },
      next: { revalidate: 300 },
    })
    if (!res.ok) return null
    const json = (await res.json()) as { data?: { chain?: { name?: string } } }
    return json.data?.chain?.name ?? null
  } catch {
    return null
  }
}

export async function generateMetadata(
  { params }: { params: Promise<{ chain: string; token: string }> },
): Promise<Metadata> {
  const { chain, token } = await params
  const slug = chain.toLowerCase()
  const sym = token.toUpperCase()
  const name = (await chainName(slug)) ?? slug.replace(/(^|[-\s])\w/g, (m) => m.toUpperCase())
  return buildMeta(
    `${sym} Gas on ${name} — Top Up Instantly | RupChain`,
    `Top up ${sym} gas on ${name} with RupChain. Pay with JazzCash, Easypaisa, or USDT — instant delivery.`,
    `/gas/${slug}/${token.toLowerCase()}`,
    { ogImage: false }, // this route ships its own opengraph-image (live gas price)
  )
}

export default async function GasChainTokenPage(
  { params }: { params: Promise<{ chain: string; token: string }> },
) {
  const { chain, token } = await params
  const slug = chain.toLowerCase()
  if (RESERVED.has(slug)) notFound()
  return <GasFlowClient initialChainSlug={slug} initialTokenSymbol={token} />
}
