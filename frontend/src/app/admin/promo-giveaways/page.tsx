'use client'
import { useState, useEffect, useCallback } from 'react'
import { toast } from '@/lib/toast'
import { fmtDateTime } from '@/lib/fmt'
import { LoadingState } from '@/components/ui/LoadingState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import {
  promoGiveawayApi,
  entriesToCsv,
  downloadCsv,
  type PromoGiveaway,
  type PromoEntry,
} from '@/lib/promoGiveaway'
import { Download, ExternalLink } from 'lucide-react'

export default function AdminPromoGiveawaysPage() {
  const [rows, setRows] = useState<PromoGiveaway[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [entries, setEntries] = useState<Record<string, PromoEntry[]>>({})

  const load = useCallback(async () => {
    try {
      setRows(await promoGiveawayApi.adminList())
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to load giveaways')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function toggleActive(g: PromoGiveaway) {
    setBusyId(g.id)
    try {
      await promoGiveawayApi.adminSetActive(g.id, !g.isActive)
      toast.success(g.isActive ? 'Giveaway disabled' : 'Giveaway re-enabled')
      await load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusyId(null)
    }
  }

  async function viewEntries(g: PromoGiveaway) {
    if (expanded === g.id) { setExpanded(null); return }
    setExpanded(g.id)
    if (!entries[g.id]) {
      try {
        const list = await promoGiveawayApi.entries(g.id)
        setEntries((p) => ({ ...p, [g.id]: list }))
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : 'Failed to load entries')
      }
    }
  }

  function exportCsv(g: PromoGiveaway) {
    const list = entries[g.id]
    if (!list || list.length === 0) { toast.error('Open entries first (or no entries yet).'); return }
    downloadCsv(`giveaway-${g.code}-entries.csv`, entriesToCsv(list))
  }

  if (loading) return <LoadingState message="Loading giveaways..." />

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-black text-text-primary">Community Giveaways</h1>
        <p className="text-sm text-text-muted">Every affiliate & admin giveaway. Review entrant collection and disable anything that looks wrong.</p>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No giveaways yet" description="Affiliate and admin giveaways will appear here." />
      ) : (
        <div className="space-y-3">
          {rows.map((g) => {
            const shareUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/giveaway/${g.code}`
            return (
              <div key={g.id} className="bg-surface border border-border rounded-xl p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-text-primary truncate">{g.title}</p>
                      <Badge variant={!g.isActive ? 'danger' : g.status === 'open' ? 'success' : 'default'} size="sm">
                        {!g.isActive ? 'Disabled' : g.status === 'open' ? 'Open' : 'Closed'}
                      </Badge>
                      <Badge variant="default" size="sm">{g.createdByRole}</Badge>
                    </div>
                    <p className="text-xs text-text-muted mt-0.5">
                      Code <span className="font-mono">{g.code}</span> · by {g.createdByName ?? '—'} · {g.entryCount} entered ·{' '}
                      {g.rewardAll ? 'all win' : `${g.winnerCount} winners`} · {fmtDateTime(g.createdAt)}
                    </p>
                    <a href={shareUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline">
                      {shareUrl} <ExternalLink size={11} />
                    </a>
                  </div>
                  <div className="flex flex-col gap-1.5 flex-shrink-0">
                    <Button size="sm" variant={g.isActive ? 'ghost' : 'secondary'} onClick={() => toggleActive(g)} loading={busyId === g.id}>
                      {g.isActive ? 'Disable' : 'Enable'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => viewEntries(g)}>
                      {expanded === g.id ? 'Hide' : 'Entries'}
                    </Button>
                  </div>
                </div>

                {expanded === g.id && (
                  <div className="mt-3 border-t border-border pt-3">
                    {!entries[g.id] ? (
                      <p className="text-xs text-text-muted">Loading entries…</p>
                    ) : entries[g.id]!.length === 0 ? (
                      <p className="text-xs text-text-muted">No entries yet.</p>
                    ) : (
                      <>
                        <div className="flex justify-end mb-2">
                          <Button size="sm" variant="secondary" onClick={() => exportCsv(g)} className="inline-flex items-center gap-1"><Download size={13} /> Export CSV</Button>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead className="text-text-muted border-b border-border">
                              <tr>
                                <th className="text-left py-1.5 pr-3">User</th>
                                <th className="text-left py-1.5 pr-3">Address</th>
                                <th className="text-left py-1.5 pr-3">Email</th>
                                <th className="text-left py-1.5">Entered</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                              {entries[g.id]!.map((e) => (
                                <tr key={e.id}>
                                  <td className="py-1.5 pr-3 text-text-primary">{e.username ?? '—'}</td>
                                  <td className="py-1.5 pr-3 font-mono text-text-secondary break-all">{e.receivingAddress}</td>
                                  <td className="py-1.5 pr-3 text-text-muted break-all">{e.email ?? '—'}</td>
                                  <td className="py-1.5 text-text-muted whitespace-nowrap">{fmtDateTime(e.createdAt)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
