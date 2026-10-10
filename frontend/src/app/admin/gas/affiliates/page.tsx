'use client'
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ChevronDown, ChevronRight, Info, LayoutGrid, List, RefreshCw, Search } from 'lucide-react'
import { adminApi, type AffiliateDetail, type AffiliateOverview, type AffiliatePerf } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { toast } from '@/lib/toast'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { HBars } from '@/components/admin/charts/HBars'
import { cn } from '@/lib/utils'
import { fmtDate, fmtDateTime } from '@/lib/fmt'
import { SocialIconRow, SocialVerifyList } from '@/components/admin/SocialLinks'

type EarningRow = Awaited<ReturnType<typeof adminApi.getGasReferrals>>[number]

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'applications', label: 'Applications' },
  { key: 'affiliates', label: 'Affiliates' },
  { key: 'performance', label: 'Performance' },
  { key: 'commissions', label: 'Commissions' },
  { key: 'payouts', label: 'Payouts' },
  { key: 'settings', label: 'Program settings', superOnly: true },
] as const
type TabKey = (typeof TABS)[number]['key']

const usd = (n: number | null | undefined) => (n == null ? 'Not tracked' : `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`)
const pct = (n: number | null) => (n == null ? '—' : `${(n * 100).toFixed(1)}%`)
const nameOf = (a: Pick<AffiliatePerf, 'username' | 'email' | 'userId'>) => a.username ?? a.email ?? a.userId

function statusVariant(s: string): 'success' | 'warning' | 'danger' | 'default' {
  if (s === 'approved') return 'success'
  if (s === 'pending') return 'warning'
  if (s === 'rejected') return 'danger'
  return 'default'
}

const socialsOf = (a: Pick<AffiliatePerf, 'socials'>) => Object.keys(a.socials ?? {}).length
const verifiedOf = (a: Pick<AffiliatePerf, 'socials' | 'socialsVerified'>) => Object.keys(a.socials ?? {}).filter((k) => !!(a.socialsVerified as Record<string, unknown> | undefined)?.[k]).length

/** Progress ring (0-100) with the value in the middle. */
function Ring({ pct, size = 64, stroke = 6, label, small }: { pct: number; size?: number; stroke?: number; label?: string; small?: boolean }) {
  const p = Math.max(0, Math.min(100, pct))
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-border" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round" className="stroke-primary" strokeDasharray={`${(p / 100) * circ} ${circ}`} />
      </svg>
      <span className={cn('absolute font-bold tabular-nums text-text-primary', small ? 'text-[10px]' : 'text-sm')}>{label ?? `${Math.round(p)}%`}</span>
    </span>
  )
}

/** Donut chart of labelled slices. */
function Donut({ slices, size = 104, centerLabel, centerSub }: { slices: { label: string; value: number; color: string }[]; size?: number; centerLabel: string; centerSub: string }) {
  const stroke = 14
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const total = slices.reduce((s, x) => s + x.value, 0)
  let offset = 0
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" role="img" aria-label={slices.map((s) => `${s.label} ${s.value}`).join(', ')}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-border" />
        {total > 0 && slices.filter((s) => s.value > 0).map((s) => {
          const len = (s.value / total) * circ
          const el = <circle key={s.label} cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} stroke={s.color} strokeDasharray={`${Math.max(len - 2, 0)} ${circ}`} strokeDashoffset={-offset} />
          offset += len
          return el
        })}
      </svg>
      <span className="absolute text-center leading-tight"><span className="block text-lg font-bold tabular-nums text-text-primary">{centerLabel}</span><span className="block text-[8px] uppercase tracking-wide text-text-muted">{centerSub}</span></span>
    </span>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3.5 shadow-card">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{label}</p>
      <p className={cn('mt-1 text-xl font-bold tabular-nums text-text-primary', tone)}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] leading-snug text-text-muted">{sub}</p>}
    </div>
  )
}

export default function GasAffiliatesAdminPage() {
  return (
    <Suspense fallback={<LoadingState message="Loading affiliates..." />}>
      <Inner />
    </Suspense>
  )
}

function Inner() {
  const router = useRouter()
  const params = useSearchParams()
  const isSuperAdmin = useAuthStore((s) => s.user?.role === 'super_admin')
  const tabParam = params.get('tab') as TabKey | null
  const tab: TabKey = TABS.some((t) => t.key === tabParam && (!('superOnly' in t) || isSuperAdmin)) ? (tabParam as TabKey) : 'overview'
  const sort = (params.get('sort') ?? 'orders') as 'orders' | 'commission' | 'margin' | 'conversion'
  const statusFilter = params.get('status') ?? 'all'

  const [data, setData] = useState<AffiliateOverview | null>(null)
  const [earnings, setEarnings] = useState<EarningRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [openApps, setOpenApps] = useState<Set<string>>(new Set())
  const [appView, setAppView] = useState<'list' | 'grid'>('list')
  const [openOwners, setOpenOwners] = useState<Set<string>>(new Set())
  const [detailFor, setDetailFor] = useState<AffiliatePerf | null>(null)
  const [detail, setDetail] = useState<AffiliateDetail | null>(null)
  const [edit, setEdit] = useState<{
    userId: string; mode: 'caps' | 'reject'; maxMarginPct: string; minUserDiscountPct: string; maxLinks: string; rejectionReason: string
  } | null>(null)

  const setParam = useCallback((k: string, v: string | null) => {
    const q = new URLSearchParams(params.toString())
    if (!v || (k === 'tab' && v === 'overview') || (k === 'sort' && v === 'orders') || (k === 'status' && v === 'all')) q.delete(k)
    else q.set(k, v)
    const qs = q.toString()
    router.replace(qs ? `/admin/gas/affiliates?${qs}` : '/admin/gas/affiliates', { scroll: false })
  }, [params, router])

  const load = useCallback(async () => {
    setError(null)
    try {
      const [o, e] = await Promise.all([adminApi.getAffiliateOverview(), adminApi.getGasReferrals()])
      setData(o); setEarnings(e)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load affiliates')
    }
  }, [])
  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!detailFor) { setDetail(null); return }
    let off = false
    setDetail(null)
    adminApi.getAffiliateDetail(detailFor.userId).then((d) => { if (!off) setDetail(d) }).catch(() => { if (!off) toast.error('Could not load affiliate detail') })
    return () => { off = true }
  }, [detailFor])

  async function verifySocial(a: AffiliatePerf, platform: string, next: boolean) {
    try {
      const r = await adminApi.verifyAffiliateSocial(a.userId, platform, next)
      setData((d) => d && { ...d, affiliates: d.affiliates.map((x) => (x.userId === a.userId ? { ...x, socialsVerified: r.verified } : x)) })
      setDetailFor((d) => (d && d.userId === a.userId ? { ...d, socialsVerified: r.verified } : d))
      toast.success(next ? `${platform} verified` : `${platform} verification removed`)
    } catch (e) {
      toast.error('Could not update verification', e instanceof Error ? e.message : undefined)
    }
  }

  const q = query.trim().toLowerCase()
  const matches = useCallback((a: AffiliatePerf) => !q || [a.username, a.email, a.referralCode, a.applicantNote, ...Object.values(a.socials ?? {})].some((v) => v?.toLowerCase().includes(q)), [q])

  const startCaps = (a: AffiliatePerf) => setEdit({ userId: a.userId, mode: 'caps', maxMarginPct: String(a.maxMarginPct), minUserDiscountPct: String(a.minUserDiscountPct), maxLinks: String(a.maxLinks), rejectionReason: '' })
  const startReject = (a: AffiliatePerf) => setEdit({ userId: a.userId, mode: 'reject', maxMarginPct: String(a.maxMarginPct), minUserDiscountPct: String(a.minUserDiscountPct), maxLinks: String(a.maxLinks), rejectionReason: '' })

  async function saveCaps(a: AffiliatePerf) {
    if (!edit) return
    const maxMarginPct = Number(edit.maxMarginPct)
    const minUserDiscountPct = Number(edit.minUserDiscountPct)
    const maxLinks = Number(edit.maxLinks)
    if (!(maxMarginPct >= 0 && maxMarginPct <= 100)) { toast.error('Margin % must be 0–100'); return }
    if (!(minUserDiscountPct >= 0 && minUserDiscountPct <= maxMarginPct)) { toast.error(`Min discount must be 0–${maxMarginPct}`); return }
    if (!(Number.isInteger(maxLinks) && maxLinks >= 1 && maxLinks <= 50)) { toast.error('Max links must be 1–50'); return }
    setBusyId(a.userId)
    try {
      await adminApi.reviewGasAffiliate(a.userId, { decision: 'approve', maxMarginPct, minUserDiscountPct, maxLinks })
      toast.success(`${nameOf(a)} ${a.status === 'approved' ? 'updated' : 'approved'}`)
      setEdit(null); void load()
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Failed to save') }
    finally { setBusyId(null) }
  }

  async function saveReject(a: AffiliatePerf) {
    if (!edit) return
    setBusyId(a.userId)
    try {
      await adminApi.reviewGasAffiliate(a.userId, { decision: 'reject', rejectionReason: edit.rejectionReason.trim() || null })
      toast.success('Application rejected')
      setEdit(null); void load()
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Failed to reject') }
    finally { setBusyId(null) }
  }

  const rows = useMemo(() => (data?.affiliates ?? []).filter(matches), [data, matches])
  const approved = useMemo(() => rows.filter((r) => r.status === 'approved'), [rows])
  const ranked = useMemo(() => {
    const key = (r: AffiliatePerf) => sort === 'commission' ? r.commissionEarnedUsdt : sort === 'margin' ? r.attributableMarginUsdt : sort === 'conversion' ? (r.conversionRate ?? -1) : r.verifiedOrders
    return [...approved].sort((a, b) => key(b) - key(a))
  }, [approved, sort])

  const earningsByOwner = useMemo(() => {
    if (!earnings) return null
    const map = new Map<string, { owner: EarningRow['owner']; links: EarningRow[]; referred: number; total: number; available: number; withdrawn: number; anyActive: boolean }>()
    for (const r of earnings.filter((x) => !q || [x.code, x.owner.username, x.owner.email].some((v) => v?.toLowerCase().includes(q)))) {
      let g = map.get(r.owner.id)
      if (!g) { g = { owner: r.owner, links: [], referred: 0, total: 0, available: 0, withdrawn: 0, anyActive: false }; map.set(r.owner.id, g) }
      g.links.push(r); g.referred += r.referredCount; g.total += r.totalAccruedUsdt; g.available += r.availableUsdt; g.withdrawn += r.withdrawnUsdt; g.anyActive = g.anyActive || r.isActive
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total)
  }, [earnings, q])

  if (error && !data) return <ErrorState title={error} onRetry={load} />
  if (!data) return <LoadingState message="Loading affiliates..." />

  const c = data.counts
  const t = data.totals
  const def = data.definitions

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-text-primary">Affiliates</h1>
          <p className="mt-0.5 text-sm text-text-muted">Applications, performance and commissions. Commission is paid from platform margin only. Active only when <code>gas_affiliate_enabled</code> is ON.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()} aria-label="Refresh"><RefreshCw className="w-4 h-4" /></Button>
      </div>

      <nav aria-label="Affiliate sections" className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.filter((x) => !('superOnly' in x) || isSuperAdmin).map((x) => (
          <button
            key={x.key}
            type="button"
            aria-current={tab === x.key ? 'page' : undefined}
            onClick={() => setParam('tab', x.key)}
            className={cn('-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors', tab === x.key ? 'border-primary text-primary' : 'border-transparent text-text-muted hover:text-text-primary')}
          >
            {x.label}
            {x.key === 'applications' && c.pending > 0 && <span className="ml-1.5 rounded-full bg-danger px-1.5 text-[11px] font-bold leading-[18px] text-white">{c.pending}</span>}
          </button>
        ))}
      </nav>

      {tab !== 'overview' && tab !== 'settings' && (
        <label className="relative block max-w-md">
          <span className="sr-only">Search affiliates</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search username, email, code, socials…"
            className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
        </label>
      )}

      {/* ───────────── Overview ───────────── */}
      {tab === 'overview' && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Applications" value={String(c.applications)} sub="All time" />
            <Stat label="Pending" value={String(c.pending)} sub="Awaiting a decision" tone={c.pending > 0 ? 'text-warning' : undefined} />
            <Stat label="Approved" value={String(c.approved)} sub={`${c.active} active (order in last ${def.activeWindowDays}d)`} />
            <Stat label="Rejected" value={String(c.rejected)} />
            <Stat label="Suspended" value="Not tracked" sub="No suspended state in the affiliate model" />
            <Stat label="Verified orders" value={String(t.verifiedOrders)} sub="Delivered, paid, referred" />
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Commission earned" value={usd(t.commissionEarnedUsdt)} sub="Excludes reversed" />
            <Stat label="Pending (hold)" value={usd(t.commissionPendingUsdt)} sub={`Inside the ${def.holdHours}h fraud hold`} />
            <Stat label="Withdrawable" value={usd(t.commissionWithdrawableUsdt)} sub="Past hold, not withdrawn" />
            <Stat label="Paid" value={usd(t.commissionPaidUsdt)} sub="Withdrawn by affiliates" />
            <Stat label="Reversed" value={usd(t.commissionReversedUsdt)} />
            <Stat label="Payout liability" value={usd(t.payoutLiabilityUsdt)} sub="Pending + withdrawable" tone="text-warning" />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-xl border border-border bg-surface p-4 shadow-card">
              <h2 className="text-sm font-semibold text-text-primary">Top earners</h2>
              <p className="mb-3 text-xs text-text-muted">By commission earned, all time. New affiliates are not judged on little data.</p>
              <HBars
                data={[...data.affiliates].filter((a) => a.commissionEarnedUsdt > 0).sort((a, b) => b.commissionEarnedUsdt - a.commissionEarnedUsdt).slice(0, 6)
                  .map((a) => ({ id: a.userId, label: nameOf(a), sublabel: a.tier ?? undefined, value: a.commissionEarnedUsdt, note: `${a.verifiedOrders} verified orders` }))}
                format={usd}
                onSelect={(id) => setDetailFor(data.affiliates.find((a) => a.userId === id) ?? null)}
                emptyText="No commission earned yet."
              />
            </section>
            <section className="rounded-xl border border-border bg-surface p-4 shadow-card">
              <h2 className="text-sm font-semibold text-text-primary">Funnel</h2>
              <p className="mb-3 text-xs text-text-muted">Across all affiliates</p>
              <dl className="space-y-2 text-sm">
                {([
                  ['Link clicks', t.clicks, null],
                  ['Sign-ups (bound to an affiliate)', t.signups, t.clicks > 0 ? `${((t.signups / t.clicks) * 100).toFixed(1)}% of clicks` : null],
                  ['Verified orders', t.verifiedOrders, t.signups > 0 ? `${(t.verifiedOrders / t.signups).toFixed(2)} per sign-up` : null],
                ] as const).map(([k, v, sub]) => (
                  <div key={k} className="flex items-baseline justify-between gap-3 border-b border-border pb-2 last:border-0">
                    <dt className="text-text-secondary">{k}</dt>
                    <dd className="text-right"><span className="font-semibold tabular-nums text-text-primary">{v.toLocaleString()}</span>{sub && <span className="block text-[11px] text-text-muted">{sub}</span>}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 text-[11px] text-text-muted">Attributable margin on verified orders: <strong className="text-text-secondary">{usd(t.attributableMarginUsdt)}</strong> (realized platform margin, not payment volume).</p>
            </section>
          </div>
          <Definitions def={def} />
        </div>
      )}

      {/* ───────────── Applications ───────────── */}
      {tab === 'applications' && (() => {
        const visible = rows
          .filter((a) => statusFilter === 'all' || a.status === statusFilter)
          .sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0))
        const appr = rows.filter((r) => r.status === 'approved')
        const avgMargin = appr.length ? appr.reduce((s, r) => s + r.maxMarginPct, 0) / appr.length : 0
        const linksUsed = appr.reduce((s, r) => s + r.linkCount, 0)
        const linksCap = appr.reduce((s, r) => s + r.maxLinks, 0)
        const socialsTotal = rows.reduce((s, r) => s + socialsOf(r), 0)
        const socialsDone = rows.reduce((s, r) => s + verifiedOf(r), 0)
        const toggle = (id: string) => setOpenApps((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

        const body = (a: AffiliatePerf) => (
          <div className="space-y-3 border-t border-border bg-surface-alt/30 px-4 py-3">
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-text-muted">
              {a.email && <span>{a.email}</span>}
              {a.referralCode && <span>Ref code <span className="font-mono text-text-secondary">{a.referralCode}</span></span>}
              <button type="button" onClick={() => setDetailFor(a)} className="font-medium text-primary hover:underline">Full profile →</button>
            </div>
            <SocialVerifyList socials={a.socials} verified={a.socialsVerified} canVerify onVerify={(k, next) => verifySocial(a, k, next)} />
            {a.applicantNote && <p className="text-xs italic text-text-muted">“{a.applicantNote}”</p>}
            {a.status === 'rejected' && a.rejectionReason && <p className="text-xs text-danger">Rejected: {a.rejectionReason}</p>}
            {a.status === 'approved' && edit?.userId !== a.userId && (
              <div className="grid grid-cols-3 gap-3 text-xs">
                <div><p className="text-text-muted">Margin allowance</p><p className="font-semibold text-text-primary">{a.maxMarginPct}%</p></div>
                <div><p className="text-text-muted">Min buyer discount</p><p className="font-semibold text-text-primary">{a.minUserDiscountPct}%</p></div>
                <div><p className="text-text-muted">Links</p><p className="font-semibold text-text-primary">{a.linkCount} / {a.maxLinks}</p></div>
              </div>
            )}
            {edit?.userId === a.userId && edit.mode === 'caps' && (
              <div className="space-y-3 rounded-lg border border-border bg-surface p-3">
                <p className="text-xs font-bold text-text-primary">{a.status === 'approved' ? 'Edit caps' : 'Approve affiliate'}</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <NumberField label="Margin allowance %" hint="Total margin to split (discount + commission)" value={edit.maxMarginPct} onChange={(v) => setEdit({ ...edit, maxMarginPct: v })} />
                  <NumberField label="Min buyer discount %" hint={`0–${edit.maxMarginPct || 0}`} value={edit.minUserDiscountPct} onChange={(v) => setEdit({ ...edit, minUserDiscountPct: v })} />
                  <NumberField label="Max links" hint="1–50" value={edit.maxLinks} onChange={(v) => setEdit({ ...edit, maxLinks: v })} />
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="primary" onClick={() => saveCaps(a)} disabled={busyId === a.userId}>{a.status === 'approved' ? 'Save' : 'Approve'}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEdit(null)} disabled={busyId === a.userId}>Cancel</Button>
                </div>
              </div>
            )}
            {edit?.userId === a.userId && edit.mode === 'reject' && (
              <div className="space-y-3 rounded-lg border border-border bg-surface p-3">
                <label className="block text-xs font-bold text-text-primary" htmlFor={`rej-${a.userId}`}>Reject application</label>
                <textarea id={`rej-${a.userId}`} value={edit.rejectionReason} onChange={(e) => setEdit({ ...edit, rejectionReason: e.target.value })} rows={2}
                  placeholder="Optional reason shown to the applicant (e.g. not enough audience reach)" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm" />
                <div className="flex gap-2">
                  <Button size="sm" variant="danger" onClick={() => saveReject(a)} disabled={busyId === a.userId}>Reject application</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEdit(null)} disabled={busyId === a.userId}>Cancel</Button>
                </div>
              </div>
            )}
            {isSuperAdmin && edit?.userId !== a.userId && (
              <div className="flex gap-2">
                <Button size="sm" variant="primary" onClick={() => startCaps(a)} disabled={busyId === a.userId}>{a.status === 'approved' ? 'Edit caps' : 'Approve'}</Button>
                {a.status !== 'rejected' && <Button size="sm" variant="secondary" onClick={() => startReject(a)} disabled={busyId === a.userId}>Reject</Button>}
              </div>
            )}
          </div>
        )

        return (
          <section className="space-y-3">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
              <div className="flex items-center gap-4 rounded-xl border border-border bg-surface p-3 shadow-card">
                <Donut
                  size={80}
                  centerLabel={String(c.applications)}
                  centerSub="applications"
                  slices={[
                    { label: 'Approved', value: c.approved, color: '#10b981' },
                    { label: 'Pending', value: c.pending, color: '#d97706' },
                    { label: 'Rejected', value: c.rejected, color: '#ef4444' },
                  ]}
                />
                <ul className="flex-1 space-y-1.5 text-sm">
                  {([['Approved', c.approved, 'bg-success'], ['Pending', c.pending, 'bg-warning'], ['Rejected', c.rejected, 'bg-danger']] as const).map(([k, v, dot]) => (
                    <li key={k} className="flex items-center gap-2"><span className={cn('h-2.5 w-2.5 rounded-full', dot)} /><span className="text-text-secondary">{k}</span><span className="ml-auto font-semibold tabular-nums text-text-primary">{v}</span></li>
                  ))}
                </ul>
              </div>
              <div className="grid grid-cols-3 gap-3">
                {([
                  ['Avg margin allowance', avgMargin, undefined],
                  ['Links in use', linksCap ? (linksUsed / linksCap) * 100 : 0, `${linksUsed}/${linksCap}`],
                  ['Socials verified', socialsTotal ? (socialsDone / socialsTotal) * 100 : 0, `${socialsDone}/${socialsTotal}`],
                ] as const).map(([k, p, label]) => (
                  <div key={k} className="flex flex-col items-center justify-center gap-1 rounded-xl border border-border bg-surface p-2 text-center shadow-card sm:flex-row sm:gap-3 sm:text-left">
                    <Ring pct={p} size={56} stroke={5} label={label} small />
                    <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{k}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div role="group" aria-label="Status" className="flex flex-wrap gap-2">
                {(['all', 'pending', 'approved', 'rejected'] as const).map((s) => (
                  <button key={s} type="button" aria-pressed={statusFilter === s} onClick={() => setParam('status', s)}
                    className={cn('rounded-lg border px-3 py-1.5 text-sm font-medium capitalize', statusFilter === s ? 'border-primary bg-primary text-white' : 'border-border bg-surface text-text-secondary hover:bg-surface-alt')}>
                    {s}{s !== 'all' && <span className="ml-1 text-xs opacity-80">{c[s]}</span>}
                  </button>
                ))}
              </div>
              <div className="ml-auto flex items-center gap-3">
                <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => setOpenApps(openApps.size ? new Set() : new Set(visible.map((v) => v.userId)))}>{openApps.size ? 'Collapse all' : 'Expand all'}</button>
                <div role="group" aria-label="Layout" className="flex overflow-hidden rounded-lg border border-border">
                  {([['list', List], ['grid', LayoutGrid]] as const).map(([k, Icon]) => (
                    <button key={k} type="button" aria-pressed={appView === k} aria-label={`${k} view`} onClick={() => setAppView(k)}
                      className={cn('px-2.5 py-1.5', appView === k ? 'bg-primary text-white' : 'bg-surface text-text-muted hover:bg-surface-alt')}><Icon className="h-4 w-4" /></button>
                  ))}
                </div>
              </div>
            </div>

            {visible.length === 0 && (
              <div className="rounded-xl border border-border bg-surface p-8 text-center text-sm text-text-muted">{q ? 'No applications match your search.' : 'No applications in this view.'}</div>
            )}

            <div className={cn(appView === 'grid' ? 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3' : 'space-y-2')}>
              {visible.map((a) => {
                const open = openApps.has(a.userId)
                const n = socialsOf(a)
                return (
                  <div key={a.userId} className={cn('overflow-hidden rounded-xl border border-border bg-surface shadow-card', appView === 'grid' && open && 'sm:col-span-2 xl:col-span-3')}>
                    <button type="button" aria-expanded={open} onClick={() => toggle(a.userId)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-alt/50">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-muted text-sm font-bold uppercase text-primary">{nameOf(a).charAt(0)}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="truncate font-semibold text-text-primary">{nameOf(a)}</span>
                          <Badge variant={statusVariant(a.status)}>{a.status}</Badge>
                        </div>
                        <p className="truncate text-xs text-text-muted">Applied {fmtDate(a.appliedAt)} · {n} social{n === 1 ? '' : 's'} · {verifiedOf(a)}/{n} verified</p>
                      </div>
                      {a.status === 'approved' && <Ring pct={a.maxMarginPct} size={38} stroke={4} small />}
                      {open ? <ChevronDown className="h-4 w-4 shrink-0 text-text-muted" /> : <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />}
                    </button>
                    {open && body(a)}
                  </div>
                )
              })}
            </div>
          </section>
        )
      })()}

      {/* ───────────── Affiliates (approved roster) ───────────── */}
      {tab === 'affiliates' && (
        <section className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
          {approved.length === 0 ? <p className="p-8 text-center text-sm text-text-muted">No approved affiliates{q ? ' match your search' : ' yet'}.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs font-medium text-text-muted">
                  <tr><th className="px-4 py-2.5">Affiliate</th><th className="px-4 py-2.5">Code</th><th className="px-4 py-2.5">Tier</th><th className="px-4 py-2.5">Caps</th><th className="px-4 py-2.5">Links</th><th className="px-4 py-2.5">Last activity</th><th className="px-4 py-2.5" /></tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {approved.map((a) => (
                    <tr key={a.userId} className="hover:bg-surface-alt/40">
                      <td className="px-4 py-2.5">
                        <p className="font-medium text-text-primary">{nameOf(a)}</p>
                        <div className="mt-1"><SocialIconRow socials={a.socials} verified={a.socialsVerified} /></div>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs">{a.referralCode ?? '—'}</td>
                      <td className="px-4 py-2.5">{a.tier} <span className="text-xs text-text-muted">{a.tierPct}%</span></td>
                      <td className="px-4 py-2.5 text-xs text-text-secondary">≤{a.maxMarginPct}% margin · min {a.minUserDiscountPct}% buyer discount</td>
                      <td className="px-4 py-2.5 tabular-nums">{a.linkCount} / {a.maxLinks}</td>
                      <td className="px-4 py-2.5 text-xs text-text-secondary">{a.lastActivityAt ? fmtDate(a.lastActivityAt) : '—'}</td>
                      <td className="px-4 py-2.5 text-right"><Button size="sm" variant="ghost" onClick={() => setDetailFor(a)}>Details</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ───────────── Performance ───────────── */}
      {tab === 'performance' && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-text-muted">All-time. Conversion = buyers ÷ sign-ups; sign-up rate = sign-ups ÷ clicks. Affiliates with under {def.newAffiliateMinOrders} orders and {def.newAffiliateMinClicks} clicks are marked <strong>New</strong>, not under-performing.</p>
            <div role="group" aria-label="Rank by" className="inline-flex rounded-lg border border-border p-0.5 text-xs">
              {([['orders', 'Verified orders'], ['commission', 'Commission'], ['margin', 'Margin contribution'], ['conversion', 'Conversion']] as const).map(([k, l]) => (
                <button key={k} type="button" aria-pressed={sort === k} onClick={() => setParam('sort', k)} className={cn('rounded-md px-2.5 py-1 font-medium', sort === k ? 'bg-primary text-white' : 'text-text-secondary hover:bg-surface-alt')}>{l}</button>
              ))}
            </div>
          </div>
          <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
            {ranked.length === 0 ? <p className="p-8 text-center text-sm text-text-muted">No approved affiliates to rank.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-border text-left text-xs font-medium text-text-muted">
                    <tr>
                      <th className="px-3 py-2.5">#</th><th className="px-3 py-2.5">Affiliate / code</th><th className="px-3 py-2.5 text-right">Clicks</th><th className="px-3 py-2.5 text-right">Sign-ups</th>
                      <th className="px-3 py-2.5 text-right">Verified orders</th><th className="px-3 py-2.5 text-right">Conversion</th><th className="px-3 py-2.5 text-right">Margin</th>
                      <th className="px-3 py-2.5 text-right">Earned</th><th className="px-3 py-2.5 text-right">Paid</th><th className="px-3 py-2.5 text-right">Unpaid</th><th className="px-3 py-2.5">Tier</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {ranked.map((a, i) => (
                      <tr key={a.userId} tabIndex={0} onClick={() => setDetailFor(a)} onKeyDown={(e) => { if (e.key === 'Enter') setDetailFor(a) }} className="cursor-pointer hover:bg-surface-alt/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">
                        <td className="px-3 py-2.5 text-text-muted">{i + 1}</td>
                        <td className="px-3 py-2.5">
                          <p className="font-medium text-text-primary">{nameOf(a)}{a.isNew && <span className="ml-1.5 rounded bg-info/10 px-1.5 py-0.5 text-[10px] font-semibold text-info">New</span>}</p>
                          <p className="font-mono text-[11px] text-text-muted">{a.referralCode ?? '—'}</p>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{a.clicks}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{a.signups}{a.signupRate != null && <span className="block text-[11px] text-text-muted">{pct(a.signupRate)}</span>}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{a.verifiedOrders}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{pct(a.conversionRate)}<span className="block text-[11px] text-text-muted">{a.buyers}/{a.signups}</span></td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{usd(a.attributableMarginUsdt)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{usd(a.commissionEarnedUsdt)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{usd(a.commissionPaidUsdt)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{usd(a.unpaidUsdt)}</td>
                        <td className="px-3 py-2.5 text-xs">{a.tier} {a.tierPct}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ───────────── Commissions ───────────── */}
      {tab === 'commissions' && (
        <section className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="Earned" value={usd(t.commissionEarnedUsdt)} />
            <Stat label="Pending (hold)" value={usd(t.commissionPendingUsdt)} sub={`${def.holdHours}h fraud hold`} />
            <Stat label="Withdrawable" value={usd(t.commissionWithdrawableUsdt)} />
            <Stat label="Paid" value={usd(t.commissionPaidUsdt)} />
            <Stat label="Reversed" value={usd(t.commissionReversedUsdt)} />
          </div>
          <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
            <div className="border-b border-border px-4 py-3"><h2 className="text-sm font-semibold text-text-primary">By affiliate</h2></div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs font-medium text-text-muted">
                  <tr><th className="px-4 py-2.5">Affiliate</th><th className="px-4 py-2.5 text-right">Earned</th><th className="px-4 py-2.5 text-right">Pending</th><th className="px-4 py-2.5 text-right">Withdrawable</th><th className="px-4 py-2.5 text-right">Paid</th><th className="px-4 py-2.5 text-right">Reversed</th></tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {[...rows].filter((r) => r.commissionEarnedUsdt + r.commissionReversedUsdt > 0).sort((a, b) => b.commissionEarnedUsdt - a.commissionEarnedUsdt).map((a) => (
                    <tr key={a.userId} className="cursor-pointer hover:bg-surface-alt/40" onClick={() => setDetailFor(a)}>
                      <td className="px-4 py-2.5 font-medium text-text-primary">{nameOf(a)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{usd(a.commissionEarnedUsdt)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{usd(a.commissionPendingUsdt)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{usd(a.commissionWithdrawableUsdt)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{usd(a.commissionPaidUsdt)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{usd(a.commissionReversedUsdt)}</td>
                    </tr>
                  ))}
                  {rows.every((r) => r.commissionEarnedUsdt + r.commissionReversedUsdt === 0) && <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-text-muted">No commission recorded yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-text-primary">Every referral link</h2>
              {isSuperAdmin && <Link href="/admin/gas/referrals" className="text-xs font-medium text-primary hover:underline">Adjust a link&apos;s rate or disable it →</Link>}
            </div>
            <p className="text-xs text-text-muted">Includes regular referrers who are not approved affiliates.</p>
            {earningsByOwner && earningsByOwner.length === 0 && <div className="rounded-xl border border-border bg-surface p-6 text-center text-sm text-text-muted">No links with activity.</div>}
            {earningsByOwner?.map((g) => {
              const open = openOwners.has(g.owner.id)
              return (
                <div key={g.owner.id} className="overflow-hidden rounded-xl border border-border bg-surface">
                  <button onClick={() => setOpenOwners((prev) => { const n = new Set(prev); if (n.has(g.owner.id)) n.delete(g.owner.id); else n.add(g.owner.id); return n })} className="w-full p-4 text-left transition-colors hover:bg-surface-alt" aria-expanded={open}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="truncate font-semibold text-text-primary">{g.owner.username ?? g.owner.email ?? 'Unknown user'}</span>
                        <Badge variant={g.anyActive ? 'success' : 'default'}>{g.anyActive ? 'Active' : 'Disabled'}</Badge>
                        <span className="text-xs text-text-muted">{g.links.length} link{g.links.length === 1 ? '' : 's'}</span>
                      </div>
                      {open ? <ChevronDown className="h-4 w-4 shrink-0 text-text-muted" /> : <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />}
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                      <div><p className="text-text-muted">Referred</p><p className="font-semibold text-text-primary">{g.referred}</p></div>
                      <div><p className="text-text-muted">Total earned</p><p className="font-semibold text-text-primary">{usd(g.total)}</p></div>
                      <div><p className="text-text-muted">Available</p><p className="font-semibold text-primary">{usd(g.available)}</p></div>
                      <div><p className="text-text-muted">Withdrawn</p><p className="font-semibold text-text-primary">{usd(g.withdrawn)}</p></div>
                    </div>
                  </button>
                  {open && (
                    <div className="divide-y divide-border border-t border-border">
                      {g.links.map((r) => (
                        <div key={r.codeId} className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-sm font-bold tracking-wider text-text-primary">{r.code}</span>
                            <Badge variant={r.isActive ? 'success' : 'default'}>{r.isActive ? 'Active' : 'Disabled'}</Badge>
                            <span className="text-xs font-semibold text-primary">{r.referralPct}% commission</span>
                          </div>
                          <div className="mt-2 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                            <div><p className="text-text-muted">Referred</p><p className="font-semibold">{r.referredCount}</p></div>
                            <div><p className="text-text-muted">Total earned</p><p className="font-semibold">{usd(r.totalAccruedUsdt)}</p></div>
                            <div><p className="text-text-muted">Available</p><p className="font-semibold text-primary">{usd(r.availableUsdt)}</p></div>
                            <div><p className="text-text-muted">Withdrawn</p><p className="font-semibold">{usd(r.withdrawnUsdt)}</p></div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* ───────────── Payouts ───────────── */}
      {tab === 'payouts' && (
        <section className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Payout liability" value={usd(t.payoutLiabilityUsdt)} sub="Accrued and not yet withdrawn" tone="text-warning" />
            <Stat label="Withdrawable now" value={usd(t.commissionWithdrawableUsdt)} sub="Past the fraud hold" />
            <Stat label="In fraud hold" value={usd(t.commissionPendingUsdt)} sub={`Releases ${def.holdHours}h after each order`} />
            <Stat label="Paid out" value={usd(t.commissionPaidUsdt)} />
          </div>
          <div className="flex gap-2 rounded-xl border border-border bg-surface p-3 text-xs text-text-secondary">
            <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" aria-hidden />
            <p>Payouts are self-service: an affiliate with KYC withdraws their available commission into their internal USDT balance, and the platform records it as a completed <em>referral_reward</em> transaction. There is no manual payout step or external payout reference in the current system, so this tab reports liabilities and completed withdrawals only.</p>
          </div>
          <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs font-medium text-text-muted"><tr><th className="px-4 py-2.5">Affiliate</th><th className="px-4 py-2.5 text-right">Unpaid</th><th className="px-4 py-2.5 text-right">Withdrawable</th><th className="px-4 py-2.5 text-right">Paid</th><th className="px-4 py-2.5" /></tr></thead>
                <tbody className="divide-y divide-border">
                  {[...rows].filter((r) => r.unpaidUsdt + r.commissionPaidUsdt > 0).sort((a, b) => b.unpaidUsdt - a.unpaidUsdt).map((a) => (
                    <tr key={a.userId} className="hover:bg-surface-alt/40">
                      <td className="px-4 py-2.5 font-medium text-text-primary">{nameOf(a)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{usd(a.unpaidUsdt)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{usd(a.commissionWithdrawableUsdt)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{usd(a.commissionPaidUsdt)}</td>
                      <td className="px-4 py-2.5 text-right"><Button size="sm" variant="ghost" onClick={() => setDetailFor(a)}>History</Button></td>
                    </tr>
                  ))}
                  {rows.every((r) => r.unpaidUsdt + r.commissionPaidUsdt === 0) && <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-text-muted">No payouts or liabilities yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* ───────────── Program settings (super admin) ───────────── */}
      {tab === 'settings' && isSuperAdmin && (
        <section className="space-y-4">
          <div className="rounded-xl border border-border bg-surface p-4 shadow-card">
            <h2 className="text-sm font-semibold text-text-primary">Commission tiers</h2>
            <p className="mb-3 text-xs text-text-muted">An affiliate&apos;s tier follows their lifetime verified referred orders and is never lost. Commission always comes out of the platform margin kept after discounts.</p>
            <div className="grid gap-2 sm:grid-cols-4">
              {data.tiers.map((x) => (
                <div key={x.key} className="rounded-lg bg-surface-alt/60 p-3"><p className="text-sm font-semibold text-text-primary">{x.name}</p><p className="text-xl font-bold text-primary">{x.pct}%</p><p className="text-[11px] text-text-muted">from {x.minOrders} orders</p></div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-border bg-surface p-4 text-sm text-text-secondary shadow-card">
            <p>Fraud-hold before commission becomes withdrawable: <strong className="text-text-primary">{def.holdHours} hours</strong>.</p>
            <p className="mt-1 text-xs text-text-muted">The tier ladder (<code>gas_affiliate_tiers</code>), hold window, default rates and minimum withdrawal are platform config values. This dashboard displays them but does not change them — edit them in <Link href="/admin/config" className="text-primary hover:underline">Config</Link>. Per-affiliate caps are edited from Applications.</p>
          </div>
        </section>
      )}

      {/* ───────────── Affiliate detail ───────────── */}
      <Modal isOpen={!!detailFor} onClose={() => setDetailFor(null)} title={detailFor ? nameOf(detailFor) : ''} size="lg">
        {detailFor && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={statusVariant(detailFor.status)}>{detailFor.status}</Badge>
              {detailFor.tier && <span className="text-sm text-text-secondary">{detailFor.tier} · {detailFor.tierPct}%</span>}
              {detailFor.isNew && <span className="rounded bg-info/10 px-1.5 py-0.5 text-[10px] font-semibold text-info">New — limited data</span>}
              <Link href={`/admin/users/${detailFor.userId}`} className="ml-auto text-xs font-medium text-primary hover:underline">Open user →</Link>
            </div>
            <SocialVerifyList socials={detailFor.socials} verified={detailFor.socialsVerified} canVerify onVerify={(k, next) => verifySocial(detailFor, k, next)} />
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              {([
                ['Clicks', String(detailFor.clicks)], ['Sign-ups', String(detailFor.signups)], ['Verified orders', String(detailFor.verifiedOrders)], ['Conversion', pct(detailFor.conversionRate)],
                ['Attributable margin', usd(detailFor.attributableMarginUsdt)], ['Commission earned', usd(detailFor.commissionEarnedUsdt)], ['Paid', usd(detailFor.commissionPaidUsdt)], ['Unpaid', usd(detailFor.unpaidUsdt)],
              ] as const).map(([k, v]) => <div key={k} className="rounded-lg bg-surface-alt/60 p-2.5"><dt className="text-[11px] text-text-muted">{k}</dt><dd className="font-semibold tabular-nums text-text-primary">{v}</dd></div>)}
            </dl>
            {!detail ? <div className="flex items-center gap-2 text-xs text-text-muted"><Spinner size="sm" /> Loading history…</div> : (
              <>
                <div>
                  <h3 className="mb-1.5 text-sm font-medium text-text-primary">Links</h3>
                  <div className="space-y-1.5">
                    {detail.links.map((l) => (
                      <div key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg border border-border px-3 py-2 text-xs">
                        <span className="font-mono font-bold text-text-primary">{l.code}</span>
                        {l.label && <span className="text-text-muted">{l.label}</span>}
                        <Badge variant={l.isActive && !l.deletedAt ? 'success' : 'default'} size="sm">{l.deletedAt ? 'Deleted' : l.isActive ? 'Active' : 'Disabled'}</Badge>
                        <span className="text-text-secondary">{l.referralPct}% commission · {l.userDiscountPct}% buyer discount</span>
                        <span className="ml-auto text-text-muted">{l.clickCount} clicks · {l.signups} sign-ups</span>
                      </div>
                    ))}
                    {detail.links.length === 0 && <p className="text-xs text-text-muted">No links.</p>}
                  </div>
                </div>
                <div>
                  <h3 className="mb-1.5 text-sm font-medium text-text-primary">Recent commissions</h3>
                  {detail.recentAccruals.length === 0 ? <p className="text-xs text-text-muted">None yet.</p> : (
                    <table className="w-full text-xs">
                      <thead className="text-left text-text-muted"><tr><th className="py-1">When</th><th>Order</th><th>L</th><th className="text-right">Margin</th><th className="text-right">Commission</th><th className="pl-3">Status</th></tr></thead>
                      <tbody className="divide-y divide-border">
                        {detail.recentAccruals.map((r) => (
                          <tr key={r.id}><td className="py-1.5">{fmtDate(r.createdAt)}</td><td className="font-mono">{r.order?.orderRef ?? '—'}</td><td>{r.level}</td><td className="text-right tabular-nums">{usd(r.marginUsdt)}</td><td className="text-right tabular-nums">{usd(r.amountUsdt)}</td><td className="pl-3">{r.status}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                <div>
                  <h3 className="mb-1.5 text-sm font-medium text-text-primary">Withdrawals</h3>
                  {detail.payouts.length === 0 ? <p className="text-xs text-text-muted">No withdrawals yet.</p> : (
                    <ul className="space-y-1 text-xs">{detail.payouts.map((p) => <li key={p.id} className="flex justify-between"><span>{fmtDateTime(p.createdAt)}</span><span className="tabular-nums">{usd(p.amountUsdt)}</span></li>)}</ul>
                  )}
                </div>
                <div>
                  <h3 className="mb-1.5 text-sm font-medium text-text-primary">Decision &amp; audit history</h3>
                  {detail.auditHistory.length === 0 ? <p className="text-xs text-text-muted">No admin actions recorded.</p> : (
                    <ul className="space-y-1.5 text-xs">
                      {detail.auditHistory.map((a) => (
                        <li key={a.id} className="rounded-lg bg-surface-alt/50 px-2.5 py-1.5">
                          <span className="font-medium text-text-primary">{a.action.replace(/_/g, ' ').toLowerCase()}</span>
                          <span className="text-text-muted"> · {a.actor ?? 'admin'} · {fmtDateTime(a.createdAt)}</span>
                          {a.metadata != null && typeof a.metadata === 'object' && Object.keys(a.metadata as object).length > 0 && <p className="mt-0.5 break-words font-mono text-[11px] text-text-muted">{JSON.stringify(a.metadata)}</p>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
            {isSuperAdmin && detailFor.status !== 'rejected' && (
              <div className="flex gap-2 border-t border-border pt-3">
                <Button size="sm" variant="primary" onClick={() => { startCaps(detailFor); setDetailFor(null); setParam('tab', 'applications') }}>{detailFor.status === 'approved' ? 'Edit caps' : 'Review application'}</Button>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

function Definitions({ def }: { def: AffiliateOverview['definitions'] }) {
  return (
    <details className="rounded-xl border border-border bg-surface p-4 text-sm text-text-secondary shadow-card">
      <summary className="flex cursor-pointer items-center gap-2 font-semibold text-text-primary"><Info className="h-4 w-4 text-primary" aria-hidden /> How these numbers are defined</summary>
      <dl className="mt-3 space-y-2 text-xs leading-relaxed">
        <div><dt className="inline font-semibold text-text-primary">Active affiliate — </dt><dd className="inline">approved and at least one verified order in the last {def.activeWindowDays} days.</dd></div>
        <div><dt className="inline font-semibold text-text-primary">Verified order — </dt><dd className="inline">a delivered, paid gas order by a referred user. Failed, expired or refunded orders never count.</dd></div>
        <div><dt className="inline font-semibold text-text-primary">Sign-up rate — </dt><dd className="inline">referred sign-ups ÷ link clicks. <strong>Conversion</strong> — referred users with at least one verified order ÷ referred sign-ups.</dd></div>
        <div><dt className="inline font-semibold text-text-primary">Attributable margin — </dt><dd className="inline">the realized platform margin (after discounts) on verified orders. Customer payment volume is never counted.</dd></div>
        <div><dt className="inline font-semibold text-text-primary">Commission states — </dt><dd className="inline">pending (inside the {def.holdHours}h fraud hold) → withdrawable → paid (withdrawn) · reversed if clawed back. Payout liability = pending + withdrawable.</dd></div>
        <div><dt className="inline font-semibold text-text-primary">New affiliates — </dt><dd className="inline">fewer than {def.newAffiliateMinOrders} verified orders and {def.newAffiliateMinClicks} clicks: marked New and never described as under-performing.</dd></div>
        <div><dt className="inline font-semibold text-text-primary">Not tracked — </dt><dd className="inline">a suspended status (the model only has pending / approved / rejected) and manual payout references (payouts are self-service).</dd></div>
      </dl>
    </details>
  )
}

/** Compact labelled numeric input used by the inline caps editor. */
function NumberField({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-text-secondary">{label}
        <input type="number" inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm font-normal" />
      </label>
      <p className="mt-0.5 text-[11px] text-text-muted">{hint}</p>
    </div>
  )
}
