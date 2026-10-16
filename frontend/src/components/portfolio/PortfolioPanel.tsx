'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { portfolioApi, type PortfolioAssetDto } from '@/lib/api'
import type { CustomAssetValue } from '@/lib/portfolio/customAsset'
import type { PortfolioEventInput, PortfolioSummaryResponse } from '@/lib/portfolio/types'
import { PortfolioTab } from './PortfolioTab'

/** Loads the user's tracked tokens and results, and hands them to the Portfolio tab. Only mounted while the tab is open. */
export function PortfolioPanel({ walletSection }: { walletSection?: ReactNode }) {
  const [assets, setAssets] = useState<PortfolioAssetDto[]>([])
  const [summary, setSummary] = useState<PortfolioSummaryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Totals are re-derived on the server after every change; a failed refresh keeps the last good numbers.
  const refreshSummary = useCallback(async () => {
    try { setSummary(await portfolioApi.summary()) } catch { /* keep previous summary */ }
  }, [])

  const load = useCallback(async () => {
    setError(null)
    try {
      const [list, sum] = await Promise.all([
        portfolioApi.listAssets(),
        portfolioApi.summary().catch(() => null),
      ])
      setAssets(list)
      setSummary(sum)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your tracked tokens.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const add = async (v: CustomAssetValue) => {
    const created = await portfolioApi.addAsset(v)
    setAssets((prev) => [...prev, created])
  }
  // Metadata only: the server updates display fields and nothing else, so no recalculation is needed.
  const edit = async (id: string, v: CustomAssetValue) => {
    const updated = await portfolioApi.updateAsset(id, v)
    setAssets((prev) => prev.map((a) => (a.id === id ? updated : a)))
  }
  const record = async (assetId: string, input: PortfolioEventInput) => {
    await portfolioApi.addEvent(assetId, input)
    await refreshSummary()
  }
  const remove = async (assetId: string, eventId: string) => {
    await portfolioApi.deleteEvent(assetId, eventId)
    await refreshSummary()
  }
  const setPrice = async (assetId: string, price: string) => {
    await portfolioApi.setPrice(assetId, price)
    await refreshSummary()
  }

  return (
    <PortfolioTab
      walletSection={walletSection}
      assets={assets}
      summary={summary}
      loading={loading}
      error={error}
      onRetry={load}
      onAddAsset={add}
      onEditAsset={edit}
      loadEvents={(id) => portfolioApi.listEvents(id)}
      onRecordEvent={record}
      onDeleteEvent={remove}
      onSetPrice={setPrice}
    />
  )
}
