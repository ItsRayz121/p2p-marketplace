'use client'
import { useState, useEffect, useCallback } from 'react'
import { toast } from '@/lib/toast'
import { fmtDateTime } from '@/lib/fmt'
import { LoadingState } from '@/components/ui/LoadingState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { promoGiveawayApi, type PromoGiveaway } from '@/lib/promoGiveaway'
import { PromoEntriesManager } from '@/components/referral/PromoEntriesManager'
import { ExternalLink } from 'lucide-react'

export default function AdminPromoGiveawaysPage() {
  const [rows, setRows] = useState<PromoGiveaway[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

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

  function viewEntries(g: PromoGiveaway) {
    setExpanded((cur) => (cur === g.id ? null : g.id))
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
                    <PromoEntriesManager giveaway={g} onChanged={load} />
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
