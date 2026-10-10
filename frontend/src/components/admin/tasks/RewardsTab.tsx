'use client'
import { useCallback, useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { adminPlatformTaskApi, type RewardsPage, type RewardRow } from '@/lib/platformTasks'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { fmtDateTime } from '@/lib/fmt'
import { copyText } from '@/components/chat/richText'
import { PaymentPill, Pager, inputCls, memberName } from './shared'

const STATES = [
  { key: '', label: 'All' },
  { key: 'awaiting_payment', label: 'Awaiting payment' },
  { key: 'paid', label: 'Paid' },
  { key: 'credited', label: 'Credited' },
] as const

const amountOf = (r: RewardRow) => (r.rewardType === 'points' ? `${(r.amount ?? 0).toLocaleString()} pts` : `$${(r.amount ?? 0).toFixed(2)} USDT`)

export function RewardsTab({ state, type, q, setFilter, onChanged }: {
  state: string; type: string; q: string
  setFilter: (patch: Record<string, string>) => void
  onChanged: () => void
}) {
  const [page, setPage] = useState(1)
  const [data, setData] = useState<RewardsPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hashes, setHashes] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [search, setSearch] = useState(q)

  const load = useCallback(async () => {
    try { setData(await adminPlatformTaskApi.rewards({ state: state || undefined, type: type || undefined, q: q || undefined, page })); setError(null) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load rewards') }
  }, [state, type, q, page])
  useEffect(() => { void load() }, [load])
  useEffect(() => { setPage(1) }, [state, type, q])
  useEffect(() => { setSearch(q) }, [q])
  useEffect(() => {
    if (search === q) return
    const t = setTimeout(() => setFilter({ rq: search }), 350)
    return () => clearTimeout(t)
  }, [search, q, setFilter])

  async function act(id: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(id)
    try { await fn(); toast.success(ok); await load(); onChanged() }
    catch (e) { toast.error('Action failed', e instanceof Error ? e.message : undefined) }
    finally { setBusy(null) }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-surface p-4 shadow-card"><p className="text-xs font-semibold text-text-secondary">Points credited</p><p className="mt-1 text-2xl font-bold tabular-nums text-text-primary">{(data?.totals.pointsCredited ?? 0).toLocaleString()}</p><p className="text-[11px] text-text-muted">All time</p></div>
        <div className="rounded-xl border border-border bg-surface p-4 shadow-card"><p className="text-xs font-semibold text-text-secondary">USDT awaiting payment</p><p className="mt-1 text-2xl font-bold tabular-nums text-warning">${(data?.totals.usdtAwaitingPayment ?? 0).toFixed(2)}</p><p className="text-[11px] text-text-muted">Unpaid balance, right now</p></div>
        <div className="rounded-xl border border-border bg-surface p-4 shadow-card"><p className="text-xs font-semibold text-text-secondary">USDT paid or credited</p><p className="mt-1 text-2xl font-bold tabular-nums text-text-primary">${(data?.totals.usdtSettled ?? 0).toFixed(2)}</p><p className="text-[11px] text-text-muted">All time</p></div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Payment state">
          {STATES.map((s) => (
            <button key={s.key} type="button" aria-pressed={state === s.key} onClick={() => setFilter({ state: s.key })}
              className={cn('rounded-lg border px-3 py-1.5 text-sm font-medium', state === s.key ? 'border-primary bg-primary text-white' : 'border-border bg-surface text-text-secondary hover:bg-surface-alt')}>{s.label}</button>
          ))}
        </div>
        <select aria-label="Reward type" value={type} onChange={(e) => setFilter({ type: e.target.value })} className={cn(inputCls, 'w-auto')}>
          <option value="">Points &amp; USDT</option><option value="points">Points</option><option value="usdt">USDT</option>
        </select>
        <label className="relative min-w-[200px] flex-1">
          <span className="sr-only">Search rewards</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" aria-hidden />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Member, task, claim ID or tx hash…" className={cn(inputCls, 'pl-9')} />
        </label>
      </div>

      {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
        {!data ? <div className="h-32 animate-pulse" /> : data.items.length === 0 ? (
          <p className="p-8 text-center text-sm text-text-muted">No rewards match these filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs font-semibold text-text-secondary">
                <tr><th className="px-4 py-2.5">Member</th><th className="px-3 py-2.5">Task</th><th className="px-3 py-2.5">Claim</th><th className="px-3 py-2.5 text-right">Amount</th><th className="px-3 py-2.5">Approved</th><th className="px-3 py-2.5">Payment</th><th className="px-3 py-2.5">Payout details</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.items.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="px-4 py-3 font-medium text-text-primary">{memberName(r.user)}</td>
                    <td className="px-3 py-3 text-text-secondary">{r.taskTitle}</td>
                    <td className="px-3 py-3 font-mono text-[11px] text-text-muted">{r.id.slice(0, 10)}…</td>
                    <td className="px-3 py-3 text-right font-semibold tabular-nums text-text-primary whitespace-nowrap">{amountOf(r)}</td>
                    <td className="px-3 py-3 text-xs text-text-secondary whitespace-nowrap">{fmtDateTime(r.approvedAt)}</td>
                    <td className="px-3 py-3"><PaymentPill state={r.state} /></td>
                    <td className="px-3 py-3 min-w-[240px]">
                      {r.state === 'awaiting_payment' ? (
                        <div className="space-y-2">
                          <div className="flex items-start gap-2"><p className="break-all font-mono text-[11px] text-text-primary">{r.payoutNetwork}: {r.payoutAddress}</p>
                            <button type="button" onClick={async () => { if (r.payoutAddress && await copyText(r.payoutAddress)) toast.success('Address copied') }} className="flex-shrink-0 text-[11px] font-semibold text-primary">Copy</button></div>
                          <div className="flex gap-1.5">
                            <input aria-label="Transaction hash" className={cn(inputCls, 'py-1.5 text-xs')} placeholder="Transaction hash" value={hashes[r.id] ?? ''} onChange={(e) => setHashes((m) => ({ ...m, [r.id]: e.target.value }))} />
                            <button type="button" disabled={busy === r.id || !(hashes[r.id] ?? '').trim()} onClick={() => void act(r.id, () => adminPlatformTaskApi.pay(r.id, hashes[r.id]!.trim()), 'Payment recorded')} className="flex-shrink-0 rounded-md bg-success px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Mark paid</button>
                            <button type="button" disabled={busy === r.id} onClick={() => { const why = window.prompt('Why is this payout being cancelled? (the member will see this)'); if (why && why.trim().length >= 5) void act(r.id, () => adminPlatformTaskApi.cancelPayout(r.id, why.trim()), 'Payout cancelled') }} className="flex-shrink-0 rounded-md border border-danger px-2.5 py-1.5 text-xs font-semibold text-danger disabled:opacity-50">Cancel</button>
                          </div>
                          <p className="text-[11px] text-text-muted">Send the USDT yourself, then paste the real transaction hash. It can be used only once.</p>
                        </div>
                      ) : r.txHash ? (
                        <div className="text-[11px]"><p className="break-all font-mono text-text-primary">{r.txHash}</p>{r.paidAt && <p className="text-text-muted">Paid {fmtDateTime(r.paidAt)}</p>}</div>
                      ) : r.rewardType === 'usdt' ? <span className="text-xs text-text-muted">Credited to the member&apos;s RupChain wallet</span>
                        : <span className="text-xs text-text-muted">Added to the member&apos;s points</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {data && <Pager page={data.page} total={data.total} limit={data.limit} onPage={setPage} />}
    </div>
  )
}
