'use client'
import { useState, useEffect, useCallback } from 'react'
import { adminApi, type PromoCampaignRow, type PromotionsOverview } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { toast } from '@/lib/toast'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { RefreshCw, Plus, Trash2 } from 'lucide-react'
import { PromotionsNav } from '@/components/admin/promotions/PromotionsNav'
import { HBars } from '@/components/admin/charts/HBars'
import { BudgetBar } from '@/components/admin/charts/BudgetBar'

type PromoCode = Awaited<ReturnType<typeof adminApi.getGasPromoCodes>>[number]
type Tier = { maxRedemptions: number; discountPct: number }

const blankForm = () => ({
  code: '',
  ownerLabel: '',
  tiers: [{ maxRedemptions: 10, discountPct: 90 }] as Tier[],
  defaultDiscountPct: 10,
  marginBudgetUsdt: 50,
  perUserLimit: 1,
  minOrderUsd: 0,
  expiresAt: '',
  allowedUser: '',
})

function fmt(n: number): string { return `$${n.toFixed(2)}` }
const usd = (n: number | null | undefined) => (n == null ? 'Not tracked' : `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`)
type SortKey = 'newest' | 'redemptions' | 'net' | 'budget'
type Redemption = Awaited<ReturnType<typeof adminApi.getGasPromoRedemptions>>[number]

export default function GasPromoCodesPage() {
  const isSuperAdmin = useAuthStore((s) => s.user?.role === 'super_admin')

  const [codes, setCodes] = useState<PromoCode[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState(blankForm())
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [overview, setOverview] = useState<PromotionsOverview | null>(null)
  const [days, setDays] = useState<7 | 30 | 90 | 'all'>(30)
  const [sort, setSort] = useState<SortKey>('newest')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'expired' | 'disabled'>('all')
  const [query, setQuery] = useState('')
  const [drill, setDrill] = useState<{ code: string; rows: Redemption[] | null } | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      setCodes(await adminApi.getGasPromoCodes())
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load promo codes')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Performance numbers come from the shared promotions report (read-only).
  useEffect(() => {
    let off = false
    adminApi.getPromotionsOverview(days).then((o) => { if (!off) setOverview(o) }).catch(() => { if (!off) setOverview(null) })
    return () => { off = true }
  }, [days])

  async function openRedemptions(c: PromoCode) {
    setDrill({ code: c.code, rows: null })
    try { setDrill({ code: c.code, rows: await adminApi.getGasPromoRedemptions(c.id) }) }
    catch { setDrill({ code: c.code, rows: [] }); toast.error('Could not load redemptions') }
  }

  function setTier(i: number, patch: Partial<Tier>) {
    setForm((f) => ({ ...f, tiers: f.tiers.map((t, idx) => idx === i ? { ...t, ...patch } : t) }))
  }
  function addTier() { setForm((f) => ({ ...f, tiers: [...f.tiers, { maxRedemptions: 10, discountPct: 50 }] })) }
  function removeTier(i: number) { setForm((f) => ({ ...f, tiers: f.tiers.filter((_, idx) => idx !== i) })) }

  async function create() {
    if (!form.code.trim() || !form.ownerLabel.trim()) { toast.error('Code and owner are required'); return }
    if (form.code.trim().length < 2) { toast.error('Code must be at least 2 characters'); return }
    // Number inputs can be blank / fractional on mobile keyboards — validate before the API does.
    const tiers = form.tiers.filter((t) => Number(t.maxRedemptions) > 0)
    if (tiers.some((t) => !Number.isInteger(Number(t.maxRedemptions)) || !(Number(t.discountPct) >= 0 && Number(t.discountPct) <= 100))) {
      toast.error('Tier users must be a whole number and discount between 0 and 100'); return
    }
    if (!(Number(form.marginBudgetUsdt) > 0)) { toast.error('Margin budget must be greater than 0'); return }
    if (!Number.isInteger(Number(form.perUserLimit)) || Number(form.perUserLimit) < 1) { toast.error('Per-user limit must be a whole number, 1 or more'); return }
    const expires = form.expiresAt ? new Date(form.expiresAt) : null
    if (expires && Number.isNaN(expires.getTime())) { toast.error('Pick a complete expiry date and time, or clear it'); return }
    setSaving(true)
    try {
      await adminApi.createGasPromoCode({
        code: form.code.trim().toUpperCase(),
        ownerLabel: form.ownerLabel.trim(),
        tiers: tiers.map((t) => ({ maxRedemptions: Number(t.maxRedemptions), discountPct: Number(t.discountPct) })),
        defaultDiscountPct: Number(form.defaultDiscountPct) || 0,
        marginBudgetUsdt: Number(form.marginBudgetUsdt),
        perUserLimit: Number(form.perUserLimit),
        minOrderUsd: Number(form.minOrderUsd) || 0,
        ...(expires ? { expiresAt: expires.toISOString() } : {}),
        ...(form.allowedUser.trim() ? { allowedUser: form.allowedUser.trim() } : {}),
      })
      toast.success(`Promo code ${form.code.toUpperCase()} created`)
      setForm(blankForm()); setShowCreate(false)
      void load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to create code')
    } finally {
      setSaving(false)
    }
  }

  async function toggleActive(c: PromoCode) {
    setBusyId(c.id)
    try {
      await adminApi.updateGasPromoCode(c.id, { isActive: !c.isActive })
      toast.success(`${c.code} ${c.isActive ? 'disabled' : 'enabled'}`)
      void load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to update code')
    } finally {
      setBusyId(null)
    }
  }

  async function bumpBudget(c: PromoCode) {
    const raw = window.prompt(`New total margin budget (USDT) for ${c.code}. Currently ${fmt(c.marginBudgetUsdt)} (spent ${fmt(c.marginSpentUsdt)}).`, String(c.marginBudgetUsdt))
    if (raw == null) return
    const next = Number(raw)
    if (!(next > 0)) { toast.error('Budget must be a positive number'); return }
    setBusyId(c.id)
    try {
      await adminApi.updateGasPromoCode(c.id, { marginBudgetUsdt: next })
      toast.success(`${c.code} budget updated`)
      void load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to update budget')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-text-primary">Promo Codes</h1>
          <p className="mt-0.5 text-sm text-text-muted">Promo codes give a margin-only discount — a code can never reduce a payment below the base gas cost. Active only when the <code>gas_promo_enabled</code> flag is ON.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()} aria-label="Refresh"><RefreshCw className="w-4 h-4" /></Button>
        {isSuperAdmin && (
          <Button size="sm" variant="primary" onClick={() => setShowCreate((v) => !v)}>
            <Plus className="w-4 h-4 mr-1" />New Code
          </Button>
        )}
      </div>

      <PromotionsNav active="promo" />

      {/* Dashboard strip — read-only reporting over the same records */}
      {overview && (() => {
        const pr = overview.programs.promo_code
        const rows = overview.campaigns.filter((c) => c.program === 'promo_code')
        const ranked = rows.filter((c) => !c.insufficientData && c.netContributionUsdt != null).sort((a, b) => (b.netContributionUsdt ?? 0) - (a.netContributionUsdt ?? 0))
        const lowData = rows.filter((c) => c.insufficientData).length
        return (
          <section className="space-y-4" aria-label="Promo code performance">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-text-primary">Performance</h2>
              <div role="group" aria-label="Date range" className="inline-flex rounded-lg border border-border p-0.5 text-xs">
                {([7, 30, 90, 'all'] as const).map((d) => (
                  <button key={String(d)} type="button" aria-pressed={days === d} onClick={() => setDays(d)}
                    className={`rounded-md px-2.5 py-1 font-medium ${days === d ? 'bg-primary text-white' : 'text-text-secondary hover:bg-surface-alt'}`}>
                    {d === 'all' ? 'All time' : `${d}d`}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              {([
                ['Codes generated', String(pr.total), `${pr.active} active · ${pr.expired} expired · ${pr.disabled} disabled`],
                ['Redemptions', String(pr.redemptions), `${pr.uniqueRedeemers ?? 0} unique redeemers`],
                ['Completed orders', String(pr.completedOrders), `${pr.refundedOrders} refunded / reversed`],
                ['Reward cost', usd(pr.rewardCostUsdt), 'Discount given on delivered orders'],
                ['Gross margin', usd(pr.grossMarginUsdt), 'Before discount · payment volume excluded'],
                ['Net contribution', usd(pr.netContributionUsdt), 'Margin − discount − affiliate commission'],
              ] as const).map(([k, v, sub]) => (
                <div key={k} className="rounded-xl border border-border bg-surface p-3.5 shadow-card">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{k}</p>
                  <p className="mt-1 text-xl font-bold tabular-nums text-text-primary">{v}</p>
                  <p className="mt-0.5 text-[11px] text-text-muted">{sub}</p>
                </div>
              ))}
            </div>
            <div className="rounded-xl border border-border bg-surface p-4 shadow-card">
              <h3 className="text-sm font-semibold text-text-primary">Who performed best and least</h3>
              <p className="mb-3 text-xs text-text-muted">Ranked by net contribution (USD) · {days === 'all' ? 'all time' : `last ${days} days`}. Codes under {overview.minSample} redemptions are not ranked{lowData ? ` (${lowData} code${lowData === 1 ? '' : 's'} have low data)` : ''}. Attribution shows use of a code, not that it caused the sale.</p>
              <HBars
                data={ranked.map((c: PromoCampaignRow) => ({ id: c.id, label: c.name, sublabel: c.label ?? undefined, value: c.netContributionUsdt, note: `${c.redemptions} redemptions · ${c.completedOrders} completed orders` }))}
                format={usd}
                onSelect={(id) => { const c = codes?.find((x) => x.id === id); if (c) void openRedemptions(c) }}
                emptyText="Not enough data yet to rank codes in this period."
              />
            </div>
          </section>
        )
      })()}

      {showCreate && isSuperAdmin && (
        <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-xs font-semibold text-text-primary">Code
              <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="ALI90" className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm uppercase" />
            </label>
            <label className="text-xs font-semibold text-text-primary">Owner / Campaign
              <input value={form.ownerLabel} onChange={(e) => setForm({ ...form, ownerLabel: e.target.value })} placeholder="Influencer Ali" className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm" />
            </label>
          </div>

          <div>
            <p className="text-xs font-semibold text-text-primary mb-1">Discount tiers (consumed first-come)</p>
            <div className="space-y-2">
              {form.tiers.map((t, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-xs text-text-muted">First</span>
                  <input type="number" min={1} value={t.maxRedemptions} onChange={(e) => setTier(i, { maxRedemptions: Number(e.target.value) })} className="w-20 rounded-lg border border-border bg-surface-alt px-2 py-1.5" />
                  <span className="text-xs text-text-muted">users get</span>
                  <input type="number" min={0} max={100} value={t.discountPct} onChange={(e) => setTier(i, { discountPct: Number(e.target.value) })} className="w-20 rounded-lg border border-border bg-surface-alt px-2 py-1.5" />
                  <span className="text-xs text-text-muted">% off fee</span>
                  <button onClick={() => removeTier(i)} className="ml-auto p-1.5 rounded hover:bg-danger/10 text-danger"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              ))}
            </div>
            <button onClick={addTier} className="mt-2 text-xs font-semibold text-primary">+ Add tier</button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <label className="text-xs font-semibold text-text-primary">Everyone else %
              <input type="number" min={0} max={100} value={form.defaultDiscountPct} onChange={(e) => setForm({ ...form, defaultDiscountPct: Number(e.target.value) })} className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm" />
            </label>
            <label className="text-xs font-semibold text-text-primary">Margin budget $
              <input type="number" min={0} value={form.marginBudgetUsdt} onChange={(e) => setForm({ ...form, marginBudgetUsdt: Number(e.target.value) })} className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm" />
            </label>
            <label className="text-xs font-semibold text-text-primary">Per-user limit
              <input type="number" min={1} value={form.perUserLimit} onChange={(e) => setForm({ ...form, perUserLimit: Number(e.target.value) })} className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm" />
            </label>
            <label className="text-xs font-semibold text-text-primary">Min order $
              <input type="number" min={0} value={form.minOrderUsd} onChange={(e) => setForm({ ...form, minOrderUsd: Number(e.target.value) })} className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm" />
            </label>
          </div>
          <label className="text-xs font-semibold text-text-primary block">Expires (optional)
            <input type="datetime-local" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} className="mt-1 w-full sm:w-64 rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm" />
          </label>

          <label className="text-xs font-semibold text-text-primary block">Restrict to one user (optional)
            <input value={form.allowedUser} onChange={(e) => setForm({ ...form, allowedUser: e.target.value })} placeholder="Email, username or user ID" autoCapitalize="none" autoCorrect="off"
              className="mt-1 w-full sm:w-80 rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm" />
            <span className="mt-1 block font-normal text-text-muted">Only this user can redeem the code. Use per-user limit for 1 or 2 uses, and Expires for the deadline.</span>
          </label>

          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={create} disabled={saving}>{saving ? 'Creating…' : 'Create Code'}</Button>
            <Button size="sm" variant="ghost" onClick={() => { setShowCreate(false); setForm(blankForm()) }}>Cancel</Button>
          </div>
        </div>
      )}

      {loading && <LoadingState message="Loading promo codes..." />}
      {error && !loading && <ErrorState description={error} onRetry={load} />}

      {!loading && !error && codes && codes.length === 0 && (
        <div className="rounded-xl border border-border bg-surface p-8 text-center text-sm text-text-muted">No promo codes yet.</div>
      )}

      {!loading && !error && codes && codes.length > 0 && (() => {
        const stats = new Map((overview?.campaigns ?? []).filter((c) => c.program === 'promo_code').map((c) => [c.id, c]))
        const stateOf = (c: PromoCode) => (!c.isActive ? 'disabled' : c.expiresAt && new Date(c.expiresAt).getTime() < Date.now() ? 'expired' : 'active')
        const shown = codes
          .filter((c) => (statusFilter === 'all' || stateOf(c) === statusFilter) && (!query || c.code.includes(query.toUpperCase()) || c.ownerLabel.toLowerCase().includes(query.toLowerCase())))
          .sort((a, b) =>
            sort === 'redemptions' ? (stats.get(b.id)?.redemptions ?? 0) - (stats.get(a.id)?.redemptions ?? 0)
            : sort === 'net' ? (stats.get(b.id)?.netContributionUsdt ?? -Infinity) - (stats.get(a.id)?.netContributionUsdt ?? -Infinity)
            : sort === 'budget' ? (b.marginSpentUsdt / (b.marginBudgetUsdt || 1)) - (a.marginSpentUsdt / (a.marginBudgetUsdt || 1))
            : 0)
        return (
        <>
        <div className="flex flex-wrap items-center gap-2">
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search code or owner…" aria-label="Search codes"
            className="w-full sm:w-60 rounded-lg border border-border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} aria-label="Status"
            className="rounded-lg border border-border bg-surface px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary">
            <option value="all">All statuses</option><option value="active">Active</option><option value="expired">Expired</option><option value="disabled">Disabled</option>
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort"
            className="rounded-lg border border-border bg-surface px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary">
            <option value="newest">Newest first</option><option value="redemptions">Most redemptions</option><option value="net">Highest net contribution</option><option value="budget">Most budget used</option>
          </select>
          <span className="text-xs text-text-muted">{shown.length} of {codes.length}</span>
        </div>
        <div className="space-y-3">
          {shown.map((c) => {
            const st = stats.get(c.id)
            const expired = c.expiresAt ? new Date(c.expiresAt).getTime() < Date.now() : false
            return (
              <div key={c.id} className="rounded-xl border border-border bg-surface p-4 shadow-card">
                <div className="flex items-start gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-text-primary">{c.code}</span>
                      <Badge variant={!c.isActive ? 'default' : expired ? 'warning' : 'success'}>
                        {!c.isActive ? 'Disabled' : expired ? 'Expired' : 'Active'}
                      </Badge>
                      {c.allowedUserId && <Badge variant="default">Only: {c.allowedUserLabel}</Badge>}
                      {st?.insufficientData && <span className="text-[10px] text-text-muted" title="Fewer redemptions than needed to rank this code">low data</span>}
                    </div>
                    <p className="text-xs text-text-muted mt-0.5">{c.ownerLabel}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => void openRedemptions(c)}>Redemptions</Button>
                    {isSuperAdmin && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => bumpBudget(c)} disabled={busyId === c.id}>Edit Budget</Button>
                        <Button size="sm" variant={c.isActive ? 'secondary' : 'primary'} onClick={() => toggleActive(c)} disabled={busyId === c.id}>
                          {c.isActive ? 'Disable' : 'Enable'}
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 text-xs">
                  <div className="col-span-2 sm:col-span-1">
                    <p className="text-text-muted mb-0.5">Budget spent</p>
                    <BudgetBar spent={c.marginSpentUsdt} budget={c.marginBudgetUsdt} format={fmt} />
                  </div>
                  <div><p className="text-text-muted">Redemptions</p><p className="font-semibold text-text-primary">{c.totalRedemptions}{st ? <span className="font-normal text-text-muted"> ({st.uniqueRedeemers} unique)</span> : null}</p></div>
                  <div><p className="text-text-muted">Completed orders</p><p className="font-semibold text-text-primary">{st ? st.completedOrders : '—'}</p></div>
                  <div><p className="text-text-muted">Net contribution</p><p className={`font-semibold ${(st?.netContributionUsdt ?? 0) < 0 ? 'text-danger' : 'text-text-primary'}`}>{st ? usd(st.netContributionUsdt) : '—'}</p></div>
                  <div><p className="text-text-muted">Per-user limit</p><p className="font-semibold text-text-primary">{c.perUserLimit}</p></div>
                  <div><p className="text-text-muted">Min order</p><p className="font-semibold text-text-primary">{c.minOrderUsd > 0 ? fmt(c.minOrderUsd) : '—'}</p></div>
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
                  {(c.tiers ?? []).map((t, i) => (
                    <span key={i} className="bg-primary/10 text-primary rounded-full px-2.5 py-0.5">First {t.maxRedemptions} → {t.discountPct}%</span>
                  ))}
                  <span className="bg-surface-alt text-text-muted rounded-full px-2.5 py-0.5">then {c.defaultDiscountPct}%</span>
                </div>
              </div>
            )
          })}
        </div>
        </>
        )
      })()}

      <Modal isOpen={!!drill} onClose={() => setDrill(null)} title={drill ? `Redemptions — ${drill.code}` : ''} size="lg">
        {!drill?.rows ? (
          <LoadingState message="Loading redemptions..." />
        ) : drill.rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-text-muted">No redemptions yet.</p>
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-text-muted"><tr><th className="py-2 pr-3">When</th><th className="pr-3">Order</th><th className="pr-3">Status</th><th className="pr-3 text-right">Discount</th><th className="text-right">Margin</th></tr></thead>
              <tbody className="divide-y divide-border">
                {drill.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2 pr-3 whitespace-nowrap">{new Date(r.createdAt).toLocaleString()}</td>
                    <td className="pr-3 font-mono">{r.order?.orderRef ?? '—'}</td>
                    <td className="pr-3">{r.order?.status.replace(/_/g, ' ') ?? '—'}</td>
                    <td className="pr-3 text-right tabular-nums">{fmt(Number(r.discountUsdt))}</td>
                    <td className="text-right tabular-nums">{fmt(Number(r.marginUsdt))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] text-text-muted">Latest 200 redemptions. Statuses other than delivered are not counted as reward cost.</p>
          </div>
        )}
      </Modal>
    </div>
  )
}
