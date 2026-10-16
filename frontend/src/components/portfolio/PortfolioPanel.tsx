'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { isNetworkError, portfolioApi, type PortfolioAssetDto } from '@/lib/api'
import type { PortfolioApiLike } from '@/lib/portfolio/apiTypes'
import type { CustomAssetValue } from '@/lib/portfolio/customAsset'
import { claimCacheOwner, loadSnapshot, saveSnapshot } from '@/lib/portfolio/offline/cache'
import { useOfflineSync } from '@/lib/portfolio/offline/useOfflineSync'
import type { Currency, ImportReport, PortfolioEventInput, PortfolioSummaryResponse } from '@/lib/portfolio/types'
import { OfflineBanner } from './OfflineBanner'
import { PortfolioTab } from './PortfolioTab'

interface Props {
  walletSection?: ReactNode
  /** Which backend to use. Defaults to the signed-in account; the local-only tracker passes its own. */
  api?: PortfolioApiLike
  /** The signed-in user. Enables the saved offline copy and queued entries (never for the local tracker). */
  userId?: string
}

/** Loads the user's tracked tokens and results, and hands them to the Portfolio tab. Only mounted while the tab is open. */
export function PortfolioPanel({ walletSection, api = portfolioApi, userId }: Props) {
  // Hold the backend in a ref so callbacks stay stable while the screens use whichever one was given.
  const apiRef = useRef<PortfolioApiLike>(api)
  apiRef.current = api
  // Offline support is for the signed-in account only: the local tracker already lives on the device.
  const offlineOn = Boolean(userId) && Boolean(api.importCtm)

  const [assets, setAssets] = useState<PortfolioAssetDto[]>([])
  const [summary, setSummary] = useState<PortfolioSummaryResponse | null>(null)
  const [currency, setCurrency] = useState<Currency>('PKR')
  const currencyRef = useRef<Currency>('PKR')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** Set when what is on screen is a saved copy (the live data could not be reached). */
  const [cachedAt, setCachedAt] = useState<string | null>(null)

  const [importReport, setImportReport] = useState<ImportReport | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)

  // Totals are re-derived on the server after every change; a failed refresh keeps the last good numbers.
  const refreshSummary = useCallback(async (c: Currency = currencyRef.current) => {
    try {
      const s = await apiRef.current.summary(c)
      if (currencyRef.current === c) { setSummary(s); setCachedAt(null) } // ignore a slow reply for a currency the user has left
    } catch { /* keep previous summary */ }
  }, [])

  const refreshAll = useCallback(async () => {
    const [list, sum] = await Promise.all([
      apiRef.current.listAssets(true), // archived tokens included so names in warnings and history still resolve
      apiRef.current.summary(currencyRef.current).catch(() => null),
    ])
    setAssets(list)
    if (sum) setSummary(sum)
    setCachedAt(null)
  }, [])

  const sync = useOfflineSync({ enabled: offlineOn, userId, api, onSynced: () => { void refreshAll() } })

  // RupChain trades: preview first. Someone who has already added trades once is kept in sync
  // automatically; anyone else is asked before anything is added. Problems here never block the tracker.
  const syncTrades = useCallback(async () => {
    const importCtm = apiRef.current.importCtm?.bind(apiRef.current)
    if (!importCtm) return // the local-only tracker has no RupChain trades to read
    try {
      const dry = await importCtm(true)
      if (dry.hasImportedBefore && dry.created + dry.restored + dry.voided > 0) {
        const done = await importCtm(false)
        await refreshAll()
        setImportReport({ ...done, created: 0, restored: 0, preview: [] })
        return
      }
      setImportReport(dry)
    } catch {
      setImportReport(null)
    }
  }, [refreshAll])

  const load = useCallback(async () => {
    setError(null)
    try {
      await refreshAll()
    } catch (e) {
      // No connection: fall back to the copy saved on this device, clearly labelled as such.
      const snap = offlineOn && userId && isNetworkError(e) ? (await claimCacheOwner(userId), await loadSnapshot(userId)) : undefined
      if (snap) {
        currencyRef.current = snap.currency
        setCurrency(snap.currency)
        setAssets(snap.assets)
        setSummary(snap.summary)
        setCachedAt(snap.savedAt)
      } else {
        setError(e instanceof Error ? e.message : 'Could not load your tracked tokens.')
      }
    } finally {
      setLoading(false)
    }
    void syncTrades()
  }, [refreshAll, syncTrades, offlineOn, userId])

  useEffect(() => { void load() }, [load])

  // Keep a saved copy of the last live view (never overwritten by a copy that is itself cached).
  useEffect(() => {
    if (!offlineOn || !userId || loading || cachedAt || error) return
    void saveSnapshot(userId, { savedAt: new Date().toISOString(), currency, assets, summary })
  }, [offlineOn, userId, loading, cachedAt, error, currency, assets, summary])

  const addTrades = async () => {
    setImportBusy(true)
    setImportError(null)
    try {
      const done = await apiRef.current.importCtm!(false)
      await refreshAll()
      setImportReport({ ...done, created: 0, restored: 0, preview: [] })
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Could not add your trades. Please try again.')
    } finally {
      setImportBusy(false)
    }
  }

  const changeCurrency = (c: Currency) => {
    currencyRef.current = c
    setCurrency(c)
    void refreshSummary(c)
  }

  const add = async (v: CustomAssetValue) => {
    const created = await apiRef.current.addAsset(v)
    setAssets((prev) => [...prev, created])
  }
  // Metadata only: the server updates display fields and nothing else, so no recalculation is needed.
  const edit = async (id: string, v: CustomAssetValue) => {
    const updated = await apiRef.current.updateAsset(id, v)
    // A changed network/contract withdraws any listing suggestion made for the old one (server side).
    const identityChanged = (a: { network: string | null; contractAddress: string | null }) => a.network !== updated.network || a.contractAddress !== updated.contractAddress
    setAssets((prev) => prev.map((a) => (a.id === id ? { ...a, ...updated, linkedToRupChainToken: a.linkedToRupChainToken, listingInterest: identityChanged(a) ? false : a.listingInterest } : a)))
  }
  const record = async (assetId: string, input: PortfolioEventInput) => {
    if (offlineOn) {
      const name = assets.find((a) => a.id === assetId)?.name ?? 'Token'
      // Offline (or the connection drops mid-save): keep the entry on this device and send it later.
      // Its request id makes a repeat harmless, even if the first attempt did reach the server.
      if (!sync.online) { await sync.enqueue(assetId, name, input); return }
      try {
        await apiRef.current.addEvent(assetId, input)
      } catch (e) {
        if (isNetworkError(e)) { await sync.enqueue(assetId, name, input); return }
        throw e
      }
    } else {
      await apiRef.current.addEvent(assetId, input)
    }
    await refreshSummary()
  }
  const remove = async (assetId: string, eventId: string) => {
    await apiRef.current.deleteEvent(assetId, eventId)
    await refreshSummary()
  }
  // Archiving only hides the token; its records still count, so totals need no recalculation.
  const archive = async (id: string) => {
    await apiRef.current.archiveAsset(id)
    setAssets((prev) => prev.map((a) => (a.id === id ? { ...a, archivedAt: new Date().toISOString() } : a)))
  }
  const unarchive = async (id: string) => {
    await apiRef.current.unarchiveAsset(id)
    setAssets((prev) => prev.map((a) => (a.id === id ? { ...a, archivedAt: null } : a)))
  }
  const deleteAsset = async (id: string) => {
    await apiRef.current.deleteAsset(id)
    setAssets((prev) => prev.filter((a) => a.id !== id))
    await refreshSummary()
  }
  // Optional, withdrawable suggestion that RupChain lists a token (anonymous aggregate for admins).
  const suggest = async (id: string) => {
    await apiRef.current.suggestListing!(id)
    setAssets((prev) => prev.map((a) => (a.id === id ? { ...a, listingInterest: true } : a)))
  }
  const withdrawSuggestion = async (id: string) => {
    await apiRef.current.withdrawListingSuggestion!(id)
    setAssets((prev) => prev.map((a) => (a.id === id ? { ...a, listingInterest: false } : a)))
  }
  const setPrice = async (assetId: string, price: string, quote: Currency) => {
    // A price is stamped with the time it is saved, so it cannot be queued for later without lying about when it was seen.
    if (offlineOn && !sync.online) throw new Error('Prices need a connection. Please try again when you are back online.')
    await apiRef.current.setPrice(assetId, price, quote)
    await refreshSummary()
  }

  return (
    <PortfolioTab
      walletSection={walletSection}
      notice={offlineOn ? (
        <OfflineBanner
          online={sync.online} cachedAt={cachedAt} queue={sync.queue} syncing={sync.syncing}
          onSync={() => { void sync.syncNow() }} onRetryFailed={() => { void sync.retryFailed() }} onDiscard={(id) => { void sync.discard(id) }}
        />
      ) : undefined}
      assets={assets}
      summary={summary}
      currency={currency}
      onCurrencyChange={changeCurrency}
      loading={loading}
      error={error}
      onRetry={load}
      onAddAsset={add}
      onEditAsset={edit}
      loadEvents={(id) => apiRef.current.listEvents(id)}
      onRecordEvent={record}
      onDeleteEvent={remove}
      onSetPrice={setPrice}
      loadPerformance={(r) => apiRef.current.performance(r)}
      onArchive={archive}
      onUnarchive={unarchive}
      onDeleteAsset={deleteAsset}
      loadExport={() => apiRef.current.exportAll()}
      onSuggestListing={api.suggestListing ? suggest : undefined}
      onWithdrawListing={api.withdrawListingSuggestion ? withdrawSuggestion : undefined}
      importReport={importReport}
      importBusy={importBusy}
      importError={importError}
      onImportTrades={addTrades}
      onDismissImport={() => setImportReport((r) => (r ? { ...r, created: 0, restored: 0, preview: [] } : r))}
    />
  )
}
