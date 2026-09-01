import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { buildMeta } from '@/lib/metadata'
import { GasFlowClient } from '../_components/GasFlowClient'

// Static children of /gas that must never be shadowed by the [chain] segment.
// (Next resolves static routes first, so this is belt-and-braces for odd inputs.)
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

export async function generateMetadata({ params }: { params: Promise<{ chain: string }> }): Promise<Metadata> {
  const { chain } = await params
  const slug = chain.toLowerCase()
  const name = (await chainName(slug)) ?? slug.replace(/(^|[-\s])\w/g, (m) => m.toUpperCase())
  return buildMeta(
    `${name} Gas Fees — Top Up Instantly | RupChain`,
    `Buy ${name} gas fees on RupChain. Pay with JazzCash, Easypaisa, or USDT — instant delivery, no wallet connect.`,
    `/gas/${slug}`,
    { ogImage: false }, // this route ships its own opengraph-image (live gas price)
  )
}

export default async function GasChainPage({ params }: { params: Promise<{ chain: string }> }) {
  const { chain } = await params
  const slug = chain.toLowerCase()
  if (RESERVED.has(slug)) notFound()
  return <GasFlowClient initialChainSlug={slug} />
}
