import type { Metadata } from 'next'
import Link from 'next/link'
import { buildMeta } from '@/lib/metadata'
import { fetchMarketsOverview } from '@/lib/marketsFetch'
import { MarketsTable } from '@/components/markets/MarketsTable'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://rupchain.com'

export const metadata: Metadata = buildMeta(
  'Live Token Prices in PKR — Markets',
  'Real-time PKR prices, 12h change, buy/sell averages and charts for USDT and every RupChain Community Token — built from real completed P2P trades, not an external feed.',
  '/markets',
)

export default async function MarketsPage() {
  const overview = await fetchMarketsOverview()

  const jsonLd = overview ? [
    {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      itemListElement: overview.rows.map((row, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        url: `${BASE_URL}/markets/${row.slug}`,
        name: `${row.name} (${row.symbol})`,
      })),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: BASE_URL },
        { '@type': 'ListItem', position: 2, name: 'Markets', item: `${BASE_URL}/markets` },
      ],
    },
  ] : []

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {jsonLd.length > 0 && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      )}

      <nav className="text-xs text-text-muted mb-3">
        <Link href="/" className="hover:text-primary">Home</Link>
        <span className="mx-1.5">/</span>
        <span className="text-text-primary">Markets</span>
      </nav>

      <h1 className="text-2xl sm:text-3xl font-bold text-text-primary">Token Markets</h1>
      <p className="mt-1.5 max-w-2xl text-sm text-text-muted">
        Live PKR prices for USDT and every Community Token traded on RupChain — sourced from real completed trades on
        this platform, updated continuously. Tap any token for its full price chart and trade history.
      </p>

      <div className="mt-6">
        {overview && overview.rows.length > 0 ? (
          <MarketsTable initial={overview} />
        ) : (
          <div className="rounded-xl border border-dashed border-border py-14 text-center text-sm text-text-muted">
            Market data is temporarily unavailable. Please check back shortly.
          </div>
        )}
      </div>
    </div>
  )
}
