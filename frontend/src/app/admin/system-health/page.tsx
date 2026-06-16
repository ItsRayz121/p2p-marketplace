'use client'
import { useCallback, useState } from 'react'
import { adminApi } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { fmtDate } from '@/lib/fmt'
import { cn } from '@/lib/utils'

// ─── Types (mirror the api.ts payloads) ─────────────────────────────────────
type Traffic = 'green' | 'yellow' | 'red'

type PollerNet = Awaited<ReturnType<typeof adminApi.getPollerHealth>>['networks'][number]
type ChainRow = Awaited<ReturnType<typeof adminApi.getChainHealth>>['chains'][number]
type SystemHealth = Awaited<ReturnType<typeof adminApi.getSystemHealth>>

// ─── Small presentational helpers ───────────────────────────────────────────
const DOT: Record<Traffic, string> = {
  green: 'bg-emerald-500',
  yellow: 'bg-amber-500',
  red: 'bg-red-500',
}

function Dot({ status }: { status: Traffic }) {
  return <span className={cn('inline-block w-2.5 h-2.5 rounded-full flex-shrink-0', DOT[status])} />
}

function Card({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="bg-surface border border-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold text-text-primary">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  )
}

function Tile({ label, ok, detail }: { label: string; ok: boolean | null; detail?: string }) {
  const status: Traffic = ok === null ? 'yellow' : ok ? 'green' : 'red'
  return (
    <div className="flex items-center gap-3 bg-surface-alt rounded-lg px-3 py-2.5">
      <Dot status={status} />
      <div className="min-w-0">
        <p className="text-xs font-semibold text-text-primary">{label}</p>
        {detail && <p className="text-[11px] text-text-muted truncate">{detail}</p>}
      </div>
    </div>
  )
}

const ago = (s: number | null) =>
  s === null ? '—' : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`

// One job-queue row with an expandable failed-job drill-down + retry/clear.
type QueueHealthRow = SystemHealth['queueHealth'][number]
function QueueRow({ q, onChanged }: { q: QueueHealthRow; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<'retry' | 'clean' | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const hasFailures = q.failed > 0

  async function retry() {
    setBusy('retry'); setMsg(null)
    try {
      const r = await adminApi.retryQueueFailed(q.name)
      setMsg(`Re-enqueued ${r.retried}/${r.total} failed job(s).`)
      onChanged()
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Retry failed') }
    finally { setBusy(null) }
  }
  async function clean() {
    setBusy('clean'); setMsg(null)
    try {
      const r = await adminApi.cleanQueueFailed(q.name)
      setMsg(`Cleared ${r.removed} failed job(s).`)
      onChanged()
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Clear failed') }
    finally { setBusy(null) }
  }

  return (
    <div className={cn('rounded-lg border', hasFailures ? 'border-red-500/30 bg-red-500/10/40' : 'border-border bg-surface-alt')}>
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          onClick={() => hasFailures && setOpen((o) => !o)}
          className={cn('text-left flex-1 min-w-0', hasFailures && 'cursor-pointer')}
          title={hasFailures ? 'Click to view failed-job errors' : undefined}
        >
          <span className="text-xs font-semibold text-text-primary">{q.name}</span>
          {q.lastError && !open && (
            <p className="text-[10px] text-red-500 truncate" title={q.lastError}>{q.lastError}</p>
          )}
        </button>
        <div className="flex items-center gap-3 text-[11px] shrink-0">
          <span className="text-text-muted" title="Queued, waiting for a worker">w <b className="text-text-secondary">{q.waiting < 0 ? '—' : q.waiting}</b></span>
          <span className="text-text-muted" title="Running now">a <b className="text-text-secondary">{q.active < 0 ? '—' : q.active}</b></span>
          <span className={cn(hasFailures ? 'text-red-500' : 'text-text-muted')} title="Failed after all retries">
            f <b>{q.failed < 0 ? '—' : q.failed}</b>
          </span>
          {hasFailures && (
            <div className="flex items-center gap-1">
              <button onClick={retry} disabled={busy !== null}
                className="px-2 py-0.5 rounded border border-amber-500/50 text-amber-700 dark:text-amber-300 text-[10px] font-bold hover:bg-amber-500/15 disabled:opacity-50">
                {busy === 'retry' ? '…' : 'Retry'}
              </button>
              <button onClick={clean} disabled={busy !== null}
                className="px-2 py-0.5 rounded border border-border text-text-muted text-[10px] font-bold hover:bg-surface disabled:opacity-50">
                {busy === 'clean' ? '…' : 'Clear'}
              </button>
            </div>
          )}
        </div>
      </div>
      {msg && <p className="px-3 pb-1.5 text-[10px] text-text-secondary">{msg}</p>}
      {open && q.failedJobs.length > 0 && (
        <div className="border-t border-red-500/30 divide-y divide-red-100">
          {q.failedJobs.map((j) => (
            <div key={j.id} className="px-3 py-1.5">
              <div className="flex items-center justify-between gap-2 text-[10px] text-text-muted">
                <span className="font-mono">#{j.id} · {j.name} · {j.attemptsMade} attempt(s)</span>
                <span>{j.failedAt ? fmtDate(j.failedAt) : '—'}</span>
              </div>
              <p className="text-[10px] text-red-600 dark:text-red-400 font-mono break-words">{j.failedReason}</p>
            </div>
          ))}
          <p className="px-3 py-1 text-[9px] text-text-muted">Showing latest {q.failedJobs.length} of {q.failed}.</p>
        </div>
      )}
    </div>
  )
}

// ─── Page ───────────────────────────────────────────────────────────────────
export default function SystemHealthPage() {
  const [poller, setPoller] = useState<PollerNet[] | null>(null)
  const [chains, setChains] = useState<ChainRow[] | null>(null)
  const [sys, setSys] = useState<SystemHealth | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null)

  const fetchAll = useCallback(async () => {
    try {
      const [p, c, s] = await Promise.all([
        adminApi.getPollerHealth(),
        adminApi.getChainHealth(),
        adminApi.getSystemHealth(),
      ])
      setPoller(p.networks)
      setChains(c.chains)
      setSys(s)
      setError(null)
      setLastRefreshed(new Date().toISOString())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load system health')
    } finally {
      setLoading(false)
    }
  }, [])

  usePolling(fetchAll, 30_000)

  if (loading && !sys) {
    return (
      <div className="flex items-center justify-center h-64 text-text-muted gap-3">
        <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        <span className="text-sm">Loading system health…</span>
      </div>
    )
  }

  if (error && !sys) {
    return (
      <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-sm text-red-700 dark:text-red-300">
        {error}
        <button onClick={() => void fetchAll()} className="ml-3 underline font-medium">Retry</button>
      </div>
    )
  }

  return (
    <div className="space-y-5 max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold text-text-primary">System Health</h1>
          <p className="text-sm text-text-muted">
            Payment pollers, RPC connectivity, hot wallets, and job queues — auto-refreshes every 30s.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastRefreshed && <span className="text-xs text-text-muted">Updated {fmtDate(lastRefreshed)}</span>}
          <button
            onClick={() => void fetchAll()}
            className="px-3 py-1.5 rounded-lg border border-border text-sm text-text-secondary hover:bg-surface-alt transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Overall status banner */}
      {sys && (
        <div
          className={cn(
            'rounded-xl p-4 border',
            sys.overallHealthy
              ? 'bg-emerald-500/10 border-emerald-500/30'
              : 'bg-red-500/10 border-red-500/30',
          )}
        >
          <div className="flex items-center gap-2.5">
            <Dot status={sys.overallHealthy ? 'green' : 'red'} />
            <span className={cn('text-sm font-bold', sys.overallHealthy ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300')}>
              {sys.overallHealthy ? 'All systems operational' : `${sys.criticalIssues.length} critical issue${sys.criticalIssues.length === 1 ? '' : 's'}`}
            </span>
          </div>
          {!sys.overallHealthy && sys.criticalIssues.length > 0 && (
            <ul className="mt-2 ml-5 list-disc text-xs text-red-700 dark:text-red-300 space-y-0.5">
              {sys.criticalIssues.map((issue, i) => <li key={i}>{issue}</li>)}
            </ul>
          )}
        </div>
      )}

      {/* Core services */}
      {sys && (
        <Card title="Core Services">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <Tile label="Redis" ok={sys.redis.ok} detail={sys.redis.error ?? 'Connected'} />
            <Tile label="Gas Mnemonic" ok={sys.mnemonic.configured} detail={sys.mnemonic.configured ? 'Configured' : 'Not configured'} />
            <Tile label="Gas Delivery" ok={!sys.globallyPaused} detail={sys.globallyPaused ? 'Globally paused' : 'Active'} />
          </div>
          {sys.staleRates.length > 0 && (
            <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
              ⚠ Stale price rates: {sys.staleRates.join(', ')}
            </p>
          )}
        </Card>
      )}

      {/* Payment detection pollers */}
      {poller && (
        <Card title="Payment Detection Pollers">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            {poller.map((n) => (
              <div key={n.network} className="bg-surface-alt rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <Dot status={n.status} />
                  <span className="text-sm font-bold text-text-primary">{n.network}</span>
                  {!n.configured && <span className="text-[10px] text-red-500 font-medium">unconfigured</span>}
                </div>
                <dl className="text-[11px] text-text-muted space-y-0.5">
                  <div className="flex justify-between"><dt>Last scan</dt><dd className="text-text-secondary">{ago(n.ageSeconds)}</dd></div>
                  <div className="flex justify-between"><dt>Last success</dt><dd className="text-text-secondary">{ago(n.successAgeSeconds)}</dd></div>
                  {n.syncedBlock !== null && (
                    <div className="flex justify-between"><dt>Block</dt><dd className="text-text-secondary">{n.syncedBlock.toLocaleString()}</dd></div>
                  )}
                </dl>
                {n.lastError && <p className="mt-1.5 text-[10px] text-red-500 line-clamp-2" title={n.lastError}>{n.lastError}</p>}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* RPC / chain connectivity */}
      {chains && (
        <Card
          title="RPC Connectivity"
          right={
            <span className="text-[11px] text-text-muted">
              {chains.filter((c) => c.status === 'green').length}/{chains.length} healthy
            </span>
          }
        >
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-text-muted text-left">
                  <th className="font-medium px-1 py-1.5">Chain</th>
                  <th className="font-medium px-1 py-1.5">Status</th>
                  <th className="font-medium px-1 py-1.5 text-right">Block</th>
                  <th className="font-medium px-1 py-1.5 text-right">Latency</th>
                  <th className="font-medium px-1 py-1.5">Delivery</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {chains.map((c) => (
                  <tr key={c.chain}>
                    <td className="px-1 py-1.5 text-text-primary font-medium">{c.name}</td>
                    <td className="px-1 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <Dot status={c.status} />
                        <span className="text-text-secondary">{c.reachable ? (c.isStale ? 'stale' : 'reachable') : 'unreachable'}</span>
                      </div>
                      {c.error && <span className="text-[10px] text-red-500 line-clamp-1" title={c.error}>{c.error}</span>}
                    </td>
                    <td className="px-1 py-1.5 text-right text-text-secondary">{c.blockNumber?.toLocaleString() ?? '—'}</td>
                    <td className="px-1 py-1.5 text-right text-text-secondary">{c.latencyMs}ms</td>
                    <td className="px-1 py-1.5">
                      <span className={cn('text-[11px]', c.deliveryImplemented ? 'text-emerald-600 dark:text-emerald-400' : 'text-text-muted')}>
                        {c.deliveryImplemented ? 'live' : 'n/a'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Hot wallet health */}
      {sys && sys.walletHealth.length > 0 && (
        <Card title="Hot Wallet Balances">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {sys.walletHealth.map((w) => {
              const status: Traffic = w.status === 'healthy' ? 'green' : w.status === 'low' ? 'yellow' : w.status === 'paused' ? 'red' : 'yellow'
              return (
                <div key={w.chain} className="flex items-center justify-between bg-surface-alt rounded-lg px-3 py-2.5">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Dot status={status} />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-text-primary">{w.chain}</p>
                      <p className="text-[11px] text-text-muted capitalize">{w.status}</p>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-sm font-medium text-text-primary">
                      {w.balance !== null ? `${w.balance.toFixed(4)} ${w.nativeSymbol}` : '—'}
                    </p>
                    {w.balanceUsd !== null && <p className="text-[11px] text-text-muted">${w.balanceUsd.toFixed(2)}</p>}
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* Job queues */}
      {sys && sys.queueHealth.length > 0 && (
        <Card title="Job Queues (BullMQ)">
          <div className="flex flex-wrap gap-x-5 gap-y-1 mb-3 text-[11px] text-text-muted">
            <span title="Jobs queued and waiting for a free worker to pick them up.">
              <b className="text-text-secondary">Waiting</b> — queued, not started
            </span>
            <span title="Jobs currently being processed by a worker right now.">
              <b className="text-text-secondary">Active</b> — running now
            </span>
            <span title="Jobs that exhausted all retry attempts and threw an error. Expand a row to see the error; use Retry to re-run them.">
              <b className="text-red-500">Failed</b> — errored after all retries
            </span>
          </div>
          <div className="space-y-1.5">
            {sys.queueHealth.map((q) => (
              <QueueRow key={q.name} q={q} onChanged={() => void fetchAll()} />
            ))}
          </div>
        </Card>
      )}

      {/* Gas delivery pipeline */}
      {sys && Object.keys(sys.deliveryHealth).length > 0 && (
        <Card title="Gas Delivery Pipeline">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {Object.entries(sys.deliveryHealth).map(([chain, d]) => (
              <div key={chain} className="flex items-center justify-between bg-surface-alt rounded-lg px-3 py-2.5">
                <span className="text-sm font-semibold text-text-primary">{chain}</span>
                <div className="flex items-center gap-3 text-[11px]">
                  <span className="text-text-muted">pending <b className="text-text-secondary">{d.pending}</b></span>
                  <span className={cn(d.failed24h > 0 ? 'text-red-500' : 'text-text-muted')}>
                    failed 24h <b>{d.failed24h}</b>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}
