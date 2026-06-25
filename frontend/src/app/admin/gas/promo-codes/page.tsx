'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { adminApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { toast } from '@/lib/toast'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { ArrowLeft, RefreshCw, Plus, Trash2 } from 'lucide-react'

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
})

function fmt(n: number): string { return `$${n.toFixed(2)}` }

export default function GasPromoCodesPage() {
  const router = useRouter()
  const isSuperAdmin = useAuthStore((s) => s.user?.role === 'super_admin')

  const [codes, setCodes] = useState<PromoCode[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState(blankForm())
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

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

  function setTier(i: number, patch: Partial<Tier>) {
    setForm((f) => ({ ...f, tiers: f.tiers.map((t, idx) => idx === i ? { ...t, ...patch } : t) }))
  }
  function addTier() { setForm((f) => ({ ...f, tiers: [...f.tiers, { maxRedemptions: 10, discountPct: 50 }] })) }
  function removeTier(i: number) { setForm((f) => ({ ...f, tiers: f.tiers.filter((_, idx) => idx !== i) })) }

  async function create() {
    if (!form.code.trim() || !form.ownerLabel.trim()) { toast.error('Code and owner are required'); return }
    setSaving(true)
    try {
      await adminApi.createGasPromoCode({
        code: form.code.trim().toUpperCase(),
        ownerLabel: form.ownerLabel.trim(),
        tiers: form.tiers.filter((t) => t.maxRedemptions > 0),
        defaultDiscountPct: form.defaultDiscountPct,
        marginBudgetUsdt: form.marginBudgetUsdt,
        perUserLimit: form.perUserLimit,
        minOrderUsd: form.minOrderUsd,
        ...(form.expiresAt ? { expiresAt: new Date(form.expiresAt).toISOString() } : {}),
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
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={() => router.push('/admin/gas')} className="p-2 rounded-lg hover:bg-surface-alt"><ArrowLeft className="w-4 h-4" /></button>
        <div className="flex-1">
          <h1 className="text-lg font-bold text-text-primary">Gas Promo Codes</h1>
          <p className="text-xs text-text-muted">Margin-only discounts — a code can never reduce a payment below the base gas cost. Active only when the <code>gas_promo_enabled</code> flag is ON.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw className="w-4 h-4" /></Button>
        {isSuperAdmin && (
          <Button size="sm" variant="primary" onClick={() => setShowCreate((v) => !v)}>
            <Plus className="w-4 h-4 mr-1" />New Code
          </Button>
        )}
      </div>

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
                <div key={i} className="flex items-center gap-2 text-sm">
                  <span className="text-xs text-text-muted w-12">First</span>
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

      {!loading && !error && codes && codes.length > 0 && (
        <div className="space-y-3">
          {codes.map((c) => {
            const pct = c.marginBudgetUsdt > 0 ? Math.min(100, (c.marginSpentUsdt / c.marginBudgetUsdt) * 100) : 0
            const expired = c.expiresAt ? new Date(c.expiresAt).getTime() < Date.now() : false
            return (
              <div key={c.id} className="rounded-xl border border-border bg-surface p-4">
                <div className="flex items-start gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-text-primary">{c.code}</span>
                      <Badge variant={!c.isActive ? 'default' : expired ? 'warning' : 'success'}>
                        {!c.isActive ? 'Disabled' : expired ? 'Expired' : 'Active'}
                      </Badge>
                    </div>
                    <p className="text-xs text-text-muted mt-0.5">{c.ownerLabel}</p>
                  </div>
                  {isSuperAdmin && (
                    <div className="flex gap-2">
                      <Button size="sm" variant="ghost" onClick={() => bumpBudget(c)} disabled={busyId === c.id}>Edit Budget</Button>
                      <Button size="sm" variant={c.isActive ? 'secondary' : 'primary'} onClick={() => toggleActive(c)} disabled={busyId === c.id}>
                        {c.isActive ? 'Disable' : 'Enable'}
                      </Button>
                    </div>
                  )}
                </div>

                <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div>
                    <p className="text-text-muted">Budget spent</p>
                    <p className="font-semibold text-text-primary">{fmt(c.marginSpentUsdt)} / {fmt(c.marginBudgetUsdt)}</p>
                    <div className="mt-1 h-1.5 rounded-full bg-surface-alt overflow-hidden">
                      <div className={`h-full ${pct >= 100 ? 'bg-danger' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                  <div><p className="text-text-muted">Redemptions</p><p className="font-semibold text-text-primary">{c.totalRedemptions}</p></div>
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
      )}
    </div>
  )
}
