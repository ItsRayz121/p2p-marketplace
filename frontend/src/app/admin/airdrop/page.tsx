'use client'
import { useState, useEffect, useCallback } from 'react'
import {
  adminAirdropApi,
  fetchAirdropAllocationsCsv,
  type AdminAirdropSeason,
  type AdminAllocation,
} from '@/lib/api'
import { LoadingState } from '@/components/ui/LoadingState'
import { toast } from '@/lib/toast'

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 })

export default function AdminAirdropPage() {
  const [seasons, setSeasons] = useState<AdminAirdropSeason[]>([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [poolInputs, setPoolInputs] = useState<Record<string, string>>({})
  const [alloc, setAlloc] = useState<{ seasonId: string; rows: AdminAllocation[]; pool: number | null; totalPoints: number; truncated: boolean } | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await adminAirdropApi.listSeasons()
      setSeasons(r.seasons)
    } catch (e) {
      toast.error('Failed to load seasons', e instanceof Error ? e.message : undefined)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const createSeason = async () => {
    if (!newName.trim()) return
    setBusy(true)
    try {
      await adminAirdropApi.createSeason(newName.trim())
      toast.success('Season created')
      setNewName('')
      await load()
    } catch (e) {
      toast.error('Create failed', e instanceof Error ? e.message : undefined)
    } finally { setBusy(false) }
  }

  const savePool = async (id: string) => {
    const raw = poolInputs[id]
    const val = Number(raw)
    if (!Number.isFinite(val) || val < 0) { toast.error('Enter a valid pool amount'); return }
    setBusy(true)
    try {
      await adminAirdropApi.setPool(id, val)
      toast.success('Token pool saved')
      await load()
    } catch (e) {
      toast.error('Save failed', e instanceof Error ? e.message : undefined)
    } finally { setBusy(false) }
  }

  const closeSeason = async (id: string) => {
    if (!confirm('Close this season? Earning will move to the next active season.')) return
    setBusy(true)
    try {
      await adminAirdropApi.closeSeason(id)
      toast.success('Season closed')
      await load()
    } catch (e) {
      toast.error('Close failed', e instanceof Error ? e.message : undefined)
    } finally { setBusy(false) }
  }

  const viewAllocations = async (id: string) => {
    setBusy(true)
    try {
      const r = await adminAirdropApi.allocations(id)
      setAlloc({ seasonId: id, rows: r.allocations, pool: r.pool, totalPoints: r.totalPoints, truncated: r.truncated })
    } catch (e) {
      toast.error('Failed to compute allocations', e instanceof Error ? e.message : undefined)
    } finally { setBusy(false) }
  }

  // Downloads the COMPLETE server-generated CSV (all participants), not the capped
  // preview table shown above.
  const downloadCsv = async () => {
    if (!alloc) return
    try {
      const csv = await fetchAirdropAllocationsCsv(alloc.seasonId)
      const blob = new Blob([csv], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `airdrop-allocations-${alloc.seasonId}.csv`
      link.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      toast.error('Download failed', e instanceof Error ? e.message : undefined)
    }
  }

  if (loading) return <LoadingState />

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-6">
      <div>
        <h1 className="text-xl font-black text-text-primary">Airdrop — Seasons & TGE</h1>
        <p className="text-sm text-text-muted mt-1">
          Manage points seasons and compute the share-of-pool token allocation for the token
          generation event. Setting a pool + exporting the allocation table is the last step
          before the manual on-chain distribution — nothing here deploys a token or moves value.
        </p>
      </div>

      {/* Create season */}
      <div className="rounded-xl border border-border bg-surface p-4 flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-medium text-text-muted mb-1">New season name</label>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Season 2"
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface-alt text-sm text-text-primary"
          />
        </div>
        <button
          onClick={createSeason}
          disabled={busy || !newName.trim()}
          className="px-4 py-2 text-sm font-semibold rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-50"
        >
          Start season (closes current)
        </button>
      </div>

      {/* Seasons */}
      <div className="space-y-3">
        {seasons.map((s) => (
          <div key={s.id} className="rounded-xl border border-border bg-surface p-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-[160px]">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-text-primary">{s.name}</span>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${s.status === 'active' ? 'text-emerald-500 bg-emerald-500/10' : 'text-text-muted bg-surface-alt'}`}>
                    {s.status}
                  </span>
                </div>
                <p className="text-xs text-text-muted mt-0.5">
                  {s.participants.toLocaleString()} participants · {fmt(s.totalPoints)} points
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-text-muted mb-1">Token pool</label>
                <div className="flex items-center gap-2">
                  <input
                    defaultValue={s.tokenPool ?? ''}
                    onChange={(e) => setPoolInputs((p) => ({ ...p, [s.id]: e.target.value }))}
                    placeholder="e.g. 45000000"
                    className="w-40 px-3 py-2 rounded-lg border border-border bg-surface-alt text-sm text-text-primary"
                  />
                  <button onClick={() => savePool(s.id)} disabled={busy} className="px-3 py-2 text-xs font-semibold rounded-lg border border-border hover:bg-surface-alt disabled:opacity-50">
                    Save
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2 self-end">
                <button onClick={() => viewAllocations(s.id)} disabled={busy} className="px-3 py-2 text-xs font-semibold rounded-lg bg-fuchsia-500/10 text-fuchsia-500 hover:bg-fuchsia-500/20 disabled:opacity-50">
                  View allocations
                </button>
                {s.status === 'active' && (
                  <button onClick={() => closeSeason(s.id)} disabled={busy} className="px-3 py-2 text-xs font-semibold rounded-lg border border-border text-danger hover:bg-danger/10 disabled:opacity-50">
                    Close
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
        {seasons.length === 0 && <p className="text-sm text-text-muted text-center py-6">No seasons yet.</p>}
      </div>

      {/* Allocations */}
      {alloc && (
        <div className="rounded-xl border border-border bg-surface p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="font-bold text-text-primary">Allocations</h2>
              <p className="text-xs text-text-muted">
                {alloc.truncated ? `top ${alloc.rows.length.toLocaleString()} shown` : `${alloc.rows.length.toLocaleString()} users`} · pool {alloc.pool != null ? fmt(alloc.pool) : '— (set a pool to see token amounts)'} · {fmt(alloc.totalPoints)} total points
              </p>
            </div>
            <button onClick={downloadCsv} className="px-3 py-2 text-xs font-semibold rounded-lg bg-primary text-white hover:bg-primary-hover">
              Download CSV
            </button>
          </div>
          <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-text-muted sticky top-0 bg-surface">
                <tr>
                  <th className="py-2 pr-3">User</th>
                  <th className="py-2 pr-3 text-right">Points</th>
                  <th className="py-2 pr-3 text-right">Share %</th>
                  <th className="py-2 text-right">Token allocation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {alloc.rows.slice(0, 500).map((a) => (
                  <tr key={a.userId}>
                    <td className="py-1.5 pr-3 text-text-primary">{a.username}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(a.points)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{a.sharePct.toFixed(4)}%</td>
                    <td className="py-1.5 text-right tabular-nums">{a.tokenAllocation != null ? fmt(a.tokenAllocation) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(alloc.truncated || alloc.rows.length > 500) && (
              <p className="text-xs text-text-muted mt-2">Preview is capped — the CSV download contains every participant.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
