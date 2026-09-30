'use client'

import { createContext, useContext, useState, type ReactNode } from 'react'
import { api, marketsApi, marketplaceApi, ctmApi, gasApi } from '@/lib/api'
import type { MarketActivity, MarketsOverview, MarketRatesSummary } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { buildTape, type TerminalData, type TerminalTopAds } from './terminalData'

// Live state for the Terminal homepage. Seeded with the server-rendered data
// (so first paint is never empty) and refreshed client-side every 30s. One
// shared poll feeds the ticker, hero, order ticket, order book, markets board
// and tape, instead of each widget polling the same endpoints on its own.

const POLL_MS = 30_000

interface TerminalState extends TerminalData {
  /** Market shown in the hero chart; set from the selector or the markets board. */
  selected: string
  select: (slug: string) => void
  updatedAt: Date | null
}

const Ctx = createContext<TerminalState | null>(null)

export function useTerminal(): TerminalState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useTerminal must be used inside <TerminalProvider>')
  return v
}

export function TerminalProvider({ initial, children }: { initial: TerminalData; children: ReactNode }) {
  const [data, setData] = useState<TerminalData>(initial)
  const [selected, setSelected] = useState('usdt')
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)

  const refresh = async () => {
    const [overview, summary, topAds, usdtActivity, history24h, usdtTrades, ctmTrades, gasBuys] = await Promise.allSettled([
      marketsApi.getOverview(),
      marketplaceApi.getMarketRatesSummary(),
      marketplaceApi.getTopAds(),
      api.get<MarketActivity>('/markets/usdt/activity'),
      marketplaceApi.getUsdtPriceHistory('24h'),
      marketplaceApi.getRecentTrades(),
      ctmApi.getRecentTrades(),
      gasApi.getRecentPurchases(),
    ])
    const val = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === 'fulfilled' ? r.value : null)
    setData((prev) => ({
      ...prev,
      // Keep the last good value when a single read fails, so one flaky
      // endpoint never blanks a section that was already showing data.
      overview: val<MarketsOverview>(overview) ?? prev.overview,
      summary: val<MarketRatesSummary>(summary) ?? prev.summary,
      topAds: (val(topAds) as TerminalTopAds | null) ?? prev.topAds,
      usdtActivity: val(usdtActivity) ?? prev.usdtActivity,
      history24h: val(history24h) ?? prev.history24h,
      tape: usdtTrades.status === 'rejected' && ctmTrades.status === 'rejected' && gasBuys.status === 'rejected'
        ? prev.tape
        : buildTape(val(usdtTrades), val(ctmTrades), val(gasBuys)),
    }))
    setUpdatedAt(new Date())
  }

  usePolling(refresh, POLL_MS, true)

  return (
    <Ctx.Provider value={{ ...data, selected, select: setSelected, updatedAt }}>
      {children}
    </Ctx.Provider>
  )
}
