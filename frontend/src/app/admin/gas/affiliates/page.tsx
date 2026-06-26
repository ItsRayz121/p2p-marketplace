'use client'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { adminApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { toast } from '@/lib/toast'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { ArrowLeft, RefreshCw, Search, ChevronDown, ChevronRight } from 'lucide-react'

type Affiliate = Awaited<ReturnType<typeof adminApi.getGasAffiliates>>[number]
type EarningRow = Awaited<ReturnType<typeof adminApi.getGasReferrals>>[number]

function fmt(n: number): string { return `$${n.toFixed(2)}` }

function statusVariant(s: string): 'success' | 'warning' | 'danger' | 'default' {
  if (s === 'approved') return 'success'
  if (s === 'pending') return 'warning'
  if (s === 'rejected') return 'danger'
  return 'default'
}

export default function GasAffiliatesAdminPage() {
  const router = useRouter()
  const isSuperAdmin = useAuthStore((s) => s.user?.role === 'super_admin')

  const [affiliates, setAffiliates] = useState<Affiliate[] | null>(null)
  const [earnings, setEarnings] = useState<EarningRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // Which owners' earnings groups are expanded (collapsed by default to keep the list tidy).
  const [openOwners, setOpenOwners] = useState<Set<string>>(new Set())
  // Inline editor (replaces window.prompt): which affiliate + which form is open, plus its
  // working values. `mode` is 'caps' (approve / edit caps) or 'reject' (capture a reason).
  const [edit, setEdit] = useState<{
    userId: string
    mode: 'caps' | 'reject'
    maxMarginPct: string
    minUserDiscountPct: string
    maxLinks: string
    rejectionReason: string
  } | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [a, e] = await Promise.all([adminApi.getGasAffiliates(), adminApi.getGasReferrals()])
      setAffiliates(a); setEarnings(e)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load affiliates')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  // Open the inline caps editor (approve a pending app, or edit an approved one's caps).
  function startCaps(a: Affiliate) {
    setEdit({ userId: a.userId, mode: 'caps', maxMarginPct: String(a.maxMarginPct), minUserDiscountPct: String(a.minUserDiscountPct), maxLinks: String(a.maxLinks), rejectionReason: '' })
  }
  function startReject(a: Affiliate) {
    setEdit({ userId: a.userId, mode: 'reject', maxMarginPct: String(a.maxMarginPct), minUserDiscountPct: String(a.minUserDiscountPct), maxLinks: String(a.maxLinks), rejectionReason: '' })
  }

  async function saveCaps(a: Affiliate) {
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
      toast.success(`${a.email ?? 'Affiliate'} ${a.status === 'approved' ? 'updated' : 'approved'}`)
      setEdit(null)
      void load()
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Failed to save') }
    finally { setBusyId(null) }
  }

  async function saveReject(a: Affiliate) {
    if (!edit) return
    setBusyId(a.userId)
    try {
      await adminApi.reviewGasAffiliate(a.userId, { decision: 'reject', rejectionReason: edit.rejectionReason.trim() || null })
      toast.success('Application rejected')
      setEdit(null)
      void load()
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Failed to reject') }
    finally { setBusyId(null) }
  }

  const q = query.trim().toLowerCase()
  const filteredAffiliates = useMemo(() => {
    if (!affiliates) return null
    if (!q) return affiliates
    return affiliates.filter((a) => [a.username, a.email, a.referralCode, a.applicantNote, ...Object.values(a.socials ?? {})]
      .some((v) => v?.toLowerCase().includes(q)))
  }, [affiliates, q])
  const filteredEarnings = useMemo(() => {
    if (!earnings) return null
    if (!q) return earnings
    return earnings.filter((r) => [r.code, r.owner.username, r.owner.email]
      .some((v) => v?.toLowerCase().includes(q)))
  }, [earnings, q])

  // Group earnings by owner so a KOL with many links shows as ONE collapsible card
  // (with aggregate totals) instead of one row per link. Sorted by total earned.
  const earningsByOwner = useMemo(() => {
    if (!filteredEarnings) return null
    const map = new Map<string, {
      owner: EarningRow['owner']; links: EarningRow[]
      referred: number; total: number; available: number; withdrawn: number; anyActive: boolean
    }>()
    for (const r of filteredEarnings) {
      let g = map.get(r.owner.id)
      if (!g) { g = { owner: r.owner, links: [], referred: 0, total: 0, available: 0, withdrawn: 0, anyActive: false }; map.set(r.owner.id, g) }
      g.links.push(r)
      g.referred += r.referredCount
      g.total += r.totalAccruedUsdt
      g.available += r.availableUsdt
      g.withdrawn += r.withdrawnUsdt
      g.anyActive = g.anyActive || r.isActive
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total)
  }, [filteredEarnings])

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => router.push('/admin/gas')} className="p-2 rounded-lg hover:bg-surface-alt"><ArrowLeft className="w-4 h-4" /></button>
        <div className="flex-1">
          <h1 className="text-lg font-bold text-text-primary">Gas Affiliates</h1>
          <p className="text-xs text-text-muted">Self-service affiliate applications + KOL income, paid from the platform margin only. Active only when <code>gas_affiliate_enabled</code> is ON.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw className="w-4 h-4" /></Button>
      </div>

      {/* Search across username / email / code / socials */}
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by username, email, code…"
          className="w-full rounded-lg border border-border bg-surface-alt pl-9 pr-3 py-2 text-sm"
        />
      </div>

      {loading && <LoadingState message="Loading affiliates..." />}
      {error && !loading && <ErrorState description={error} onRetry={load} />}

      {!loading && !error && (
        <>
          {/* Applications + approved affiliates */}
          <section className="space-y-3">
            <h2 className="text-sm font-bold text-text-primary">Applications</h2>
            {filteredAffiliates && filteredAffiliates.length === 0 && (
              <div className="rounded-xl border border-border bg-surface p-8 text-center text-sm text-text-muted">{q ? 'No applications match your search.' : 'No affiliate applications yet.'}</div>
            )}
            {filteredAffiliates && filteredAffiliates.map((a) => (
              <div key={a.userId} className="rounded-xl border border-border bg-surface p-4">
                <div className="flex items-start gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link href={`/admin/users/${a.userId}`} className="font-semibold text-text-primary truncate hover:text-primary hover:underline">{a.username ?? a.email ?? a.userId}</Link>
                      <Badge variant={statusVariant(a.status)}>{a.status}</Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5 text-xs text-text-muted">
                      {a.email && <span>{a.email}</span>}
                      {a.referralCode && <span>Ref code <span className="font-mono text-text-secondary">{a.referralCode}</span></span>}
                    </div>
                    {a.socials && Object.keys(a.socials).length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {Object.entries(a.socials).map(([k, v]) => (
                          <span key={k} className="text-xs bg-surface-alt rounded-full px-2.5 py-0.5 text-text-secondary"><span className="text-text-muted">{k}:</span> {v}</span>
                        ))}
                      </div>
                    )}
                    {a.applicantNote && <p className="text-xs text-text-muted mt-1.5 italic">“{a.applicantNote}”</p>}
                    {a.status === 'rejected' && a.rejectionReason && <p className="text-xs text-red-500 mt-1">Rejected: {a.rejectionReason}</p>}
                  </div>
                  {isSuperAdmin && (
                    <div className="flex gap-2">
                      <Button size="sm" variant="primary" onClick={() => startCaps(a)} disabled={busyId === a.userId}>
                        {a.status === 'approved' ? 'Edit caps' : 'Approve'}
                      </Button>
                      {a.status !== 'rejected' && (
                        <Button size="sm" variant="secondary" onClick={() => startReject(a)} disabled={busyId === a.userId}>Reject</Button>
                      )}
                    </div>
                  )}
                </div>
                {a.status === 'approved' && !(edit?.userId === a.userId && edit.mode === 'caps') && (
                  <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div><p className="text-text-muted">Margin allowance</p><p className="font-semibold text-text-primary">{a.maxMarginPct}%</p></div>
                    <div><p className="text-text-muted">Min buyer discount</p><p className="font-semibold text-text-primary">{a.minUserDiscountPct}%</p></div>
                    <div><p className="text-text-muted">Links</p><p className="font-semibold text-text-primary">{a.linkCount} / {a.maxLinks}</p></div>
                  </div>
                )}

                {/* Inline caps editor — approve a pending app or edit an approved one's caps */}
                {edit?.userId === a.userId && edit.mode === 'caps' && (
                  <div className="mt-3 rounded-lg border border-border bg-surface-alt p-3 space-y-3">
                    <p className="text-xs font-bold text-text-primary">{a.status === 'approved' ? 'Edit caps' : 'Approve affiliate'}</p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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

                {/* Inline reject — capture an optional reason shown to the applicant */}
                {edit?.userId === a.userId && edit.mode === 'reject' && (
                  <div className="mt-3 rounded-lg border border-border bg-surface-alt p-3 space-y-3">
                    <label className="block text-xs font-bold text-text-primary">Reject application</label>
                    <textarea
                      value={edit.rejectionReason}
                      onChange={(e) => setEdit({ ...edit, rejectionReason: e.target.value })}
                      rows={2}
                      placeholder="Optional reason shown to the applicant (e.g. not enough audience reach)"
                      className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                    />
                    <div className="flex gap-2">
                      <Button size="sm" variant="danger" onClick={() => saveReject(a)} disabled={busyId === a.userId}>Reject application</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEdit(null)} disabled={busyId === a.userId}>Cancel</Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </section>

          {/* Earnings — grouped by owner; one collapsible card per affiliate, aggregating
              all their links. Expand to see each link's code, commission and per-link stats. */}
          <section className="space-y-3">
            <h2 className="text-sm font-bold text-text-primary">Affiliate earnings</h2>
            {earningsByOwner && earningsByOwner.length === 0 && (
              <div className="rounded-xl border border-border bg-surface p-8 text-center text-sm text-text-muted">{q ? 'No earnings match your search.' : 'No affiliate links with activity yet.'}</div>
            )}
            {earningsByOwner && earningsByOwner.map((g) => {
              const open = openOwners.has(g.owner.id)
              return (
                <div key={g.owner.id} className="rounded-xl border border-border bg-surface overflow-hidden">
                  <button
                    onClick={() => setOpenOwners((prev) => { const n = new Set(prev); if (n.has(g.owner.id)) n.delete(g.owner.id); else n.add(g.owner.id); return n })}
                    className="w-full text-left p-4 hover:bg-surface-alt transition-colors"
                    aria-expanded={open}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      {open ? <ChevronDown className="w-4 h-4 text-text-muted shrink-0" /> : <ChevronRight className="w-4 h-4 text-text-muted shrink-0" />}
                      <span className="font-semibold text-text-primary truncate">{g.owner.username ?? g.owner.email ?? 'Unknown user'}</span>
                      <Badge variant={g.anyActive ? 'success' : 'default'}>{g.anyActive ? 'Active' : 'Disabled'}</Badge>
                      <span className="text-xs text-text-muted">{g.links.length} link{g.links.length === 1 ? '' : 's'}</span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                      <div><p className="text-text-muted">Referred</p><p className="font-semibold text-text-primary">{g.referred}</p></div>
                      <div><p className="text-text-muted">Total earned</p><p className="font-semibold text-text-primary">{fmt(g.total)}</p></div>
                      <div><p className="text-text-muted">Available</p><p className="font-semibold text-primary">{fmt(g.available)}</p></div>
                      <div><p className="text-text-muted">Withdrawn</p><p className="font-semibold text-text-primary">{fmt(g.withdrawn)}</p></div>
                    </div>
                  </button>
                  {open && (
                    <div className="border-t border-border divide-y divide-border">
                      {g.links.map((r) => (
                        <div key={r.codeId} className="px-4 py-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-sm font-bold tracking-wider text-text-primary">{r.code}</span>
                            <Badge variant={r.isActive ? 'success' : 'default'}>{r.isActive ? 'Active' : 'Disabled'}</Badge>
                            <span className="text-xs text-primary font-semibold">{r.referralPct}% commission</span>
                          </div>
                          <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                            <div><p className="text-text-muted">Referred</p><p className="font-semibold text-text-primary">{r.referredCount}</p></div>
                            <div><p className="text-text-muted">Total earned</p><p className="font-semibold text-text-primary">{fmt(r.totalAccruedUsdt)}</p></div>
                            <div><p className="text-text-muted">Available</p><p className="font-semibold text-primary">{fmt(r.availableUsdt)}</p></div>
                            <div><p className="text-text-muted">Withdrawn</p><p className="font-semibold text-text-primary">{fmt(r.withdrawnUsdt)}</p></div>
                          </div>
                          <Link href={`/admin/users/${r.owner.id}`} className="mt-1.5 inline-block text-[11px] text-primary hover:underline">View user</Link>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </section>
        </>
      )}
    </div>
  )
}

/** Compact labelled numeric input used by the inline caps editor. */
function NumberField({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-text-secondary">{label}</label>
      <input
        type="number"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
      />
      <p className="mt-0.5 text-[11px] text-text-muted">{hint}</p>
    </div>
  )
}
