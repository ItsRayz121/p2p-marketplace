'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { adminApi, type DisputeInsights, type DisputeMarket, type DisputeParticipantStats } from '@/lib/api'
import { fmtDateTime } from '@/lib/fmt'
import { Spinner } from '@/components/ui/Spinner'
import { disputeOutcomeLabel, tradeStatusLabel } from './disputeLabels'

/** One participant's lifetime dispute record (both marketplaces), broken down by outcome. */
export function ParticipantDisputeCard({
  role, id, username, stats,
}: { role: string; id: string; username: string | null; stats: DisputeParticipantStats }) {
  const cells: Array<[string, number, string]> = [
    ['Open', stats.open, 'text-warning'],
    ['Won', stats.won, 'text-success'],
    ['Lost', stats.lost, 'text-danger'],
    ['Split', stats.split, 'text-text-primary'],
    ['No fault', stats.closedNoFault, 'text-text-primary'],
  ]
  if (stats.resolvedOther > 0) cells.push(['Other', stats.resolvedOther, 'text-text-primary'])
  return (
    <div className="rounded-xl border border-border bg-surface-alt/50 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{role}</p>
          <Link href={`/admin/users/${id}`} className="block truncate text-sm font-semibold text-text-primary hover:text-primary hover:underline">
            {username ?? 'Unknown'}
          </Link>
        </div>
        <div className="text-right">
          <p className="text-xl font-bold leading-none text-text-primary tabular-nums">{stats.total}</p>
          <p className="text-[10px] uppercase tracking-wide text-text-muted">total disputes</p>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-5 gap-1 text-center">
        {cells.map(([label, n, tone]) => (
          <div key={label} className="rounded-lg bg-surface py-1.5">
            <dd className={`text-sm font-bold tabular-nums ${n > 0 ? tone : 'text-text-muted'}`}>{n}</dd>
            <dt className="text-[10px] text-text-muted">{label}</dt>
          </div>
        ))}
      </dl>
    </div>
  )
}

const KIND_DOT: Record<string, string> = {
  opened: 'bg-danger', escalated: 'bg-warning', message: 'bg-primary', resolved: 'bg-success', audit: 'bg-text-muted',
}
const KIND_LABEL: Record<string, string> = {
  opened: 'Opened', escalated: 'Escalated', message: 'Message / evidence', resolved: 'Outcome', audit: 'Admin action',
}

/** Participants' dispute history + the case's full timeline (opening, evidence, escalation, outcome, audit trail). */
export function DisputeInsightsPanel({ market, disputeId }: { market: DisputeMarket; disputeId: string }) {
  const [data, setData] = useState<DisputeInsights | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setData(null); setError(null)
    adminApi.getDisputeInsights(market, disputeId)
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load case history') })
    return () => { cancelled = true }
  }, [market, disputeId])

  if (error) return <p className="text-xs text-danger" role="alert">{error}</p>
  if (!data) return <div className="flex items-center gap-2 text-xs text-text-muted"><Spinner size="sm" /> Loading case history…</div>

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
        <span>Dispute: <strong className="text-text-primary">{disputeOutcomeLabel(data.disputeStatus, data.resolutionType, data.winner)}</strong></span>
        <span>Trade: <strong className="text-text-primary">{tradeStatusLabel(data.tradeStatus)}</strong></span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {data.participants.map((p) => (
          <ParticipantDisputeCard key={p.role} role={p.role} id={p.id} username={p.username} stats={p.stats} />
        ))}
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-text-primary">Timeline</p>
        <ol className="relative space-y-3 border-l border-border pl-4">
          {data.timeline.map((e, i) => (
            <li key={i} className="relative">
              <span className={`absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface ${KIND_DOT[e.kind] ?? 'bg-text-muted'}`} aria-hidden />
              <p className="text-[11px] text-text-muted">
                {fmtDateTime(e.at)} · {KIND_LABEL[e.kind] ?? e.kind}{e.actor ? ` · ${e.actor}` : ''}
              </p>
              <p className="whitespace-pre-wrap break-words text-sm text-text-secondary">{e.text}</p>
              {e.evidenceUrl && (
                <a href={e.evidenceUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">View evidence ↗</a>
              )}
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
