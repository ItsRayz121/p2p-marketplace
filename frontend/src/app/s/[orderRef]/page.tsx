import type { Metadata } from 'next'
import Link from 'next/link'
import { fetchPublicShare } from '@/lib/shareCardServer'

type Props = { params: Promise<{ orderRef: string }>; searchParams: Promise<{ v?: string }> }

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://rupchain.com'

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { orderRef } = await params
  const { v } = await searchParams
  const data = await fetchPublicShare(orderRef)
  const title = data ? `${data.amount} ${data.symbol} gas topped up on RupChain` : 'Get crypto gas on RupChain'
  const description = data
    ? `Paid with ${data.paidWith} and delivered to the wallet. Use this link to get ${data.discountPct}% off on every fee.`
    : 'Pay in PKR or USDT, from an exchange or a wallet, and top up crypto gas.'
  // The unfurled card is the same graphic the sender previewed (their chosen template).
  const image = `${SITE}/s/${encodeURIComponent(orderRef)}/image?v=${encodeURIComponent((v ?? '0').slice(0, 2))}`
  return {
    title,
    description,
    // Thin, per-order pages: let people share them, but keep them out of search results.
    robots: { index: false, follow: true },
    openGraph: { title, description, type: 'website', images: [{ url: image, width: 1200, height: 675, alt: title }] },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  }
}

/** Public landing page behind a shared gas order: the preview card, and the sharer's referral link. */
export default async function SharePage({ params }: Props) {
  const { orderRef } = await params
  const data = await fetchPublicShare(orderRef)
  const cta = data?.refCode ? `/r/${data.refCode}` : '/gas'

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center gap-6 px-4 py-12 text-center">
      <div className="space-y-2">
        <h1 className="text-3xl font-black text-text-primary">
          {data ? `${data.amount} ${data.symbol} gas, paid with ${data.paidWith}` : 'Crypto gas, made simple'}
        </h1>
        <p className="text-text-muted">
          Run out of gas to move your tokens? RupChain delivers it to your wallet. Pay in PKR or USDT, from an exchange or a wallet.
        </p>
      </div>
      {data && (
        <p className="rounded-xl border border-success/40 bg-success/10 px-4 py-3 text-sm font-semibold text-success">
          Sign up with this link and get {data.discountPct}% off on every fee.
        </p>
      )}
      <Link href={cta} className="rounded-xl bg-primary px-6 py-3 text-base font-bold text-white hover:opacity-90">
        Get gas now
      </Link>
    </main>
  )
}
