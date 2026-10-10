'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ExternalLink, RefreshCw } from 'lucide-react'
import { adminApi } from '@/lib/api'
import { fmtDate } from '@/lib/fmt'
import { buildForest, newIds, pathTo, type NetNode } from '@/lib/referralNetwork'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { cn } from '@/lib/utils'
import { BubbleMapView, type FissionEvent } from './BubbleMapView'
import { BranchView } from './BranchView'
import { NETWORK_REFRESH_MS, enabledViews, type NetworkView } from './config'

type Countries = { countries: Array<{ country: string; countryCode: string | null; count: number }>; total: number }

// 2-letter ISO country code → flag emoji (regional indicator letters).
function flagEmoji(cc: string | null): string {
  if (!cc || cc.length !== 2) return '🏳️'
  const A = 0x1f1e6
  return String.fromCodePoint(A + (cc.toUpperCase().charCodeAt(0) - 65), A + (cc.toUpperCase().charCodeAt(1) - 65))
}

const VIEW_LABEL: Record<NetworkView, string> = { bubble: 'Bubble Map', branch: 'Referral Branch' }

export function ReferralNetwork() {
  const views = useMemo(() => enabledViews(), [])
  const [view, setView] = useState<NetworkView>(views[0])
  const [nodes, setNodes] = useState<NetNode[] | null>(null)
  const [meta, setMeta] = useState<{ total: number; truncated: boolean }>({ total: 0, truncated: false })
  const [countries, setCountries] = useState<Countries | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [fission, setFission] = useState<{ events: FissionEvent[]; token: number }>({ events: [], token: 0 })
  const [showCountries, setShowCountries] = useState(false)

  const prevIds = useRef<Set<string> | null>(null)
  const inFlight = useRef(false)
  const lastFetch = useRef(0)

  const load = useCallback(async (initial: boolean) => {
    if (inFlight.current) return
    inFlight.current = true
    if (!initial) setRefreshing(true)
    try {
      const [graph, byCountry] = await Promise.all([adminApi.getReferralGraph(), adminApi.getReferralsByCountry()])
      const list = (graph.nodes ?? []) as NetNode[]
      // Genuinely new referrals only: never on the first load, never for users we already had.
      const added = newIds(prevIds.current, list.map((n) => n.id))
      prevIds.current = new Set(list.map((n) => n.id))
      setNodes(list)
      setMeta({ total: graph.total ?? list.length, truncated: !!graph.truncated })
      setCountries(byCountry)
      if (added.length) {
        const byId = new Map(list.map((n) => [n.id, n]))
        setFission((f) => ({ events: added.map((id) => ({ id, parentId: byId.get(id)?.referredById ?? null })), token: f.token + 1 }))
      }
      setUpdatedAt(new Date())
      setError(null)
      setRefreshError(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load referral network'
      if (initial || !prevIds.current) setError(msg)
      else setRefreshError(msg)
    } finally {
      inFlight.current = false
      lastFetch.current = Date.now()
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { void load(true) }, [load])

  // Periodic refresh while the page is visible. This is polling, not a live push.
  useEffect(() => {
    const tick = () => { if (!document.hidden) void load(false) }
    const id = window.setInterval(tick, NETWORK_REFRESH_MS)
    const onVis = () => { if (!document.hidden && Date.now() - lastFetch.current > NETWORK_REFRESH_MS) void load(false) }
    document.addEventListener('visibilitychange', onVis)
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', onVis) }
  }, [load])

  const forest = useMemo(() => buildForest(nodes ?? []), [nodes])

  // Drop a selection that no longer exists (e.g. data changed under us).
  useEffect(() => { if (selectedId && !forest.byId.has(selectedId)) setSelectedId(null) }, [forest, selectedId])

  if (error && !nodes) return <ErrorState title={error} onRetry={() => void load(true)} />
  if (!nodes) return <LoadingState message="Loading referral network…" />

  const sel = selectedId ? forest.byId.get(selectedId) ?? null : null
  const inviter = sel?.referredById ? forest.byId.get(sel.referredById) ?? null : null
  const path = selectedId ? pathTo(forest, selectedId) : []

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {views.length > 1 && (
          <div role="tablist" aria-label="Network view" className="flex overflow-hidden rounded-lg border border-border">
            {views.map((v) => (
              <button key={v} role="tab" aria-selected={view === v} type="button" onClick={() => setView(v)}
                className={cn('px-3 py-1.5 text-sm font-medium', view === v ? 'bg-primary text-white' : 'bg-surface text-text-secondary hover:bg-surface-alt')}>
                {VIEW_LABEL[v]}
              </button>
            ))}
          </div>
        )}
        <p className="text-xs text-text-muted">
          {forest.byId.size.toLocaleString()} users · {forest.roots.length.toLocaleString()} top-level inviters
          {meta.truncated && <span className="text-warning"> · showing the oldest {forest.byId.size.toLocaleString()} of {meta.total.toLocaleString()}</span>}
        </p>
        <div className="ml-auto flex items-center gap-2 text-[11px] text-text-muted">
          {refreshError && <span className="text-danger">Refresh failed: {refreshError}</span>}
          {updatedAt && <span>Updated {updatedAt.toLocaleTimeString()} · refreshes every {NETWORK_REFRESH_MS / 1000}s</span>}
          <button type="button" onClick={() => void load(false)} disabled={refreshing} aria-label="Refresh now" className="rounded-md border border-border bg-surface p-1.5 text-text-secondary hover:bg-surface-alt disabled:opacity-50">
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
          </button>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div>
          {/* Both views stay mounted so zoom, position and expansion survive switching. */}
          {views.includes('bubble') && (
            <div className={view === 'bubble' ? '' : 'hidden'}>
              <BubbleMapView forest={forest} selectedId={selectedId} onSelect={setSelectedId} active={view === 'bubble'} fission={fission.events} fissionToken={fission.token} />
            </div>
          )}
          {views.includes('branch') && (
            <div className={view === 'branch' ? '' : 'hidden'}>
              <BranchView forest={forest} selectedId={selectedId} onSelect={setSelectedId} active={view === 'branch'} />
            </div>
          )}
        </div>

        <aside className="space-y-3">
          <div className="rounded-xl border border-border bg-surface p-4 shadow-card">
            {sel ? (
              <div className="space-y-3 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-base font-bold text-text-primary">{sel.username}</p>
                    <p className="text-xs text-text-muted">{sel.createdAt ? `Joined ${fmtDate(sel.createdAt)}` : 'Join date unavailable'}</p>
                  </div>
                  <button type="button" onClick={() => setSelectedId(null)} className="text-xs text-text-muted hover:text-text-primary">Clear</button>
                </div>
                <dl className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-lg bg-surface-alt p-2"><dt className="text-text-muted">Direct referrals</dt><dd className="text-base font-bold text-text-primary">{sel.referrals.toLocaleString()}</dd></div>
                  <div className="rounded-lg bg-surface-alt p-2"><dt className="text-text-muted">Whole network</dt><dd className="text-base font-bold text-text-primary">{(forest.descendants.get(sel.id) ?? 0).toLocaleString()}</dd></div>
                  <div className="rounded-lg bg-surface-alt p-2"><dt className="text-text-muted">KYC</dt><dd className="font-semibold text-text-primary">{sel.kycStatus}</dd></div>
                  <div className="rounded-lg bg-surface-alt p-2"><dt className="text-text-muted">Active</dt><dd className="font-semibold text-text-primary">{sel.active == null ? 'Unknown' : sel.active ? 'Yes' : 'No'}</dd></div>
                </dl>
                <p className="text-[11px] text-text-muted">Direct = people they invited. Network = everyone beneath them in the loaded data. Active = has completed at least one trade.</p>
                <div className="text-xs">
                  <span className="text-text-muted">Invited by </span>
                  {inviter ? <button type="button" onClick={() => setSelectedId(inviter.id)} className="font-semibold text-primary hover:underline">{inviter.username}</button> : <span className="text-text-secondary">{sel.referredById ? 'an inviter outside the loaded data' : 'no one (top level)'}</span>}
                </div>
                {path.length > 1 && <p className="text-[11px] text-text-muted">Path: {path.map((id) => forest.byId.get(id)?.username).join(' → ')}</p>}
                <Link href={`/admin/users/${sel.id}`} className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
                  Open user profile <ExternalLink className="h-3 w-3" />
                </Link>
              </div>
            ) : (
              <p className="text-sm text-text-muted">Select a person in either view to see their details. The selection stays when you switch views.</p>
            )}
          </div>

          {/* Country breakdown: secondary, collapsed by default. */}
          <div className="rounded-xl border border-border bg-surface shadow-card">
            <button type="button" onClick={() => setShowCountries((s) => !s)} aria-expanded={showCountries} className="flex w-full items-center justify-between px-4 py-3 text-left">
              <span className="text-sm font-bold text-text-primary">Users by country</span>
              <span className="flex items-center gap-2 text-xs text-text-muted">{countries?.total ?? 0} total <ChevronDown className={cn('h-4 w-4 transition-transform', showCountries && 'rotate-180')} /></span>
            </button>
            {showCountries && (
              <div className="border-t border-border p-4">
                <p className="mb-2 text-[11px] text-text-muted">Covers all users with a detected country, not only people in the referral network above.</p>
                {!countries || countries.countries.length === 0 ? (
                  <p className="text-xs text-text-muted">No country data yet.</p>
                ) : (
                  <div className="max-h-[320px] space-y-2 overflow-y-auto pr-1">
                    {countries.countries.map((c) => {
                      const pct = countries.total > 0 ? Math.round((c.count / countries.total) * 100) : 0
                      return (
                        <div key={`${c.countryCode}-${c.country}`}>
                          <div className="flex items-center justify-between text-sm">
                            <span className="flex items-center gap-2 text-text-primary"><span className="text-base leading-none">{flagEmoji(c.countryCode)}</span>{c.country}</span>
                            <span className="text-xs text-text-muted">{c.count} · {pct}%</span>
                          </div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-alt"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(2, pct)}%` }} /></div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
