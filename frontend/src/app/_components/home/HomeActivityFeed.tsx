'use client'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ctmApi, marketplaceApi, gasApi } from '@/lib/api'
import { TickerBanner, type TickerBannerItem } from '@/components/shared/TickerBanner'
import { tradeTickerItem, gasTickerItem } from '@/components/shared/tickerItems'
import { usePolling } from '@/hooks/usePolling'

interface CombinedItem {
  id: string
  completedAt: string
  node: ReactNode
}

/** Combined CTM + USDT + Gas "recent activity" ticker for the home page —
 * pulls each market's own recent-activity feed client-side and interleaves
 * them by time, so a first-time visitor sees real, live proof of trading
 * across the whole platform rather than just one market. */
export function HomeActivityFeed() {
  const [items, setItems] = useState<TickerBannerItem[]>([])

  const fetchAll = async () => {
    const [ctmRes, usdtRes, gasRes] = await Promise.allSettled([
      ctmApi.getRecentTrades(),
      marketplaceApi.getRecentTrades(),
      gasApi.getRecentPurchases(),
    ])
    const combined: CombinedItem[] = []
    if (ctmRes.status === 'fulfilled') {
      for (const t of ctmRes.value) {
        combined.push({ id: `ctm-${t.id}`, completedAt: t.completedAt, node: tradeTickerItem(t, { amountFormat: 'grouped', collapseAfter24h: true }) })
      }
    }
    if (usdtRes.status === 'fulfilled') {
      for (const t of usdtRes.value) {
        combined.push({ id: `usdt-${t.id}`, completedAt: t.completedAt, node: tradeTickerItem(t, { amountFormat: 'fixed2', collapseAfter24h: true }) })
      }
    }
    if (gasRes.status === 'fulfilled') {
      for (const p of gasRes.value) {
        combined.push({ id: `gas-${p.id}`, completedAt: p.completedAt, node: gasTickerItem(p, { collapseAfter24h: true }) })
      }
    }
    combined.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime())
    setItems(combined.slice(0, 24).map((c) => ({ key: c.id, node: c.node })))
  }

  useEffect(() => { fetchAll() }, [])
  usePolling(fetchAll, 60_000, true)

  if (!items.length) return null

  return (
    <section className="py-6 bg-surface border-t border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <TickerBanner label="Live Activity" items={items} />
      </div>
    </section>
  )
}
