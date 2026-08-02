'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { adminApi, type AdminGasChain, type AdminGasToken } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { toast } from '@/lib/toast'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { GasAmountConverter } from '@/components/admin/GasAmountConverter'
import { ArrowLeft, RefreshCw, Plus } from 'lucide-react'

type FreeCode = Awaited<ReturnType<typeof adminApi.getGasFreeCodes>>[number]

const blankForm = () => ({
  code: '',
  kolLabel: '',
  chainId: '',
  tokenConfigId: '',
  amountNative: '',
  slotLimit: 20,
  budgetUsdt: 20,
  perUserLimit: 1,
  expiresAt: '',
})

function fmt(n: number): string { return `$${n.toFixed(2)}` }

export default function GasFreeCodesPage() {
  const router = useRouter()
  const isSuperAdmin = useAuthStore((s) => s.user?.role === 'super_admin')

  const [codes, setCodes] = useState<FreeCode[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState(blankForm())
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const [chains, setChains] = useState<AdminGasChain[]>([])
  const [tokens, setTokens] = useState<AdminGasToken[]>([])
  const [tokensLoading, setTokensLoading] = useState(false)
  const selectedTokenObj = tokens.find((t) => t.id === form.tokenConfigId) ?? null

  // Per-user USDT value of the gift amount, reported live by GasAmountConverter.
  const [usdPerUnit, setUsdPerUnit] = useState<number | null>(null)
  // Once the admin edits the budget box directly, stop overwriting it.
  const [budgetTouched, setBudgetTouched] = useState(false)

  useEffect(() => {
    if (budgetTouched || usdPerUnit == null || !(form.slotLimit > 0)) return
    const auto = Number((usdPerUnit * form.slotLimit).toFixed(2))
    setForm((f) => (f.budgetUsdt === auto ? f : { ...f, budgetUsdt: auto }))
  }, [usdPerUnit, form.slotLimit, budgetTouched])

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      setCodes(await adminApi.getGasFreeCodes())
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load free codes')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    adminApi.getGasChains()
      .then((r) => setChains(r.chains.filter((c) => !c.isArchived).sort((a, b) => a.displayOrder - b.displayOrder)))
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Failed to load chains'))
  }, [])

  async function loadTokens(chainId: string) {
    setForm((f) => ({ ...f, chainId, tokenConfigId: '' }))
    setTokens([])
    if (!chainId) return
    setTokensLoading(true)
    try {
      const r = await adminApi.getGasTokens(chainId)
      setTokens(r.tokens.filter((t) => !t.isArchived))
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to load tokens')
    } finally {
      setTokensLoading(false)
    }
  }

  async function create() {
    if (!form.code.trim() || !form.kolLabel.trim() || !form.tokenConfigId || !(Number(form.amountNative) > 0)) {
      toast.error('Code, KOL label, a chain/token and a gift amount are required'); return
    }
    setSaving(true)
    try {
      await adminApi.createGasFreeCode({
        code: form.code.trim().toUpperCase(),
        kolLabel: form.kolLabel.trim(),
        gasTokenConfigId: form.tokenConfigId,
        amountNative: Number(form.amountNative),
        slotLimit: form.slotLimit,
        budgetUsdt: form.budgetUsdt,
        perUserLimit: form.perUserLimit,
        ...(form.expiresAt ? { expiresAt: new Date(form.expiresAt).toISOString() } : {}),
      })
      toast.success(`Free code ${form.code.toUpperCase()} created`)
      setForm(blankForm()); setShowCreate(false); setBudgetTouched(false); setUsdPerUnit(null)
      void load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to create code')
    } finally {
      setSaving(false)
    }
  }

  async function toggleActive(c: FreeCode) {
    setBusyId(c.id)
    try {
      await adminApi.updateGasFreeCode(c.id, { isActive: !c.isActive })
      toast.success(`${c.code} ${c.isActive ? 'disabled' : 'enabled'}`)
      void load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to update code')
    } finally {
      setBusyId(null)
    }
  }

  async function bumpBudget(c: FreeCode) {
    const raw = window.prompt(`New total USDT budget for ${c.code}. Currently ${fmt(c.budgetUsdt)} (spent ${fmt(c.spentUsdt)}).`, String(c.budgetUsdt))
    if (raw == null) return
    const next = Number(raw)
    if (!(next > 0)) { toast.error('Budget must be a positive number'); return }
    setBusyId(c.id)
    try {
      await adminApi.updateGasFreeCode(c.id, { budgetUsdt: next })
      toast.success(`${c.code} budget updated`)
      void load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to update budget')
    } finally {
      setBusyId(null)
    }
  }

  async function bumpAmount(c: FreeCode) {
    const raw = window.prompt(`New fixed gift amount (${c.tokenSymbol ?? 'native'}) for ${c.code}. Currently ${c.amountNative}. Only affects FUTURE redemptions.`, c.amountNative)
    if (raw == null) return
    const next = Number(raw)
    if (!(next > 0)) { toast.error('Amount must be a positive number'); return }
    setBusyId(c.id)
    try {
      await adminApi.updateGasFreeCode(c.id, { amountNative: next })
      toast.success(`${c.code} gift amount updated`)
      void load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to update amount')
    } finally {
      setBusyId(null)
    }
  }

  async function bumpSlots(c: FreeCode) {
    const raw = window.prompt(`New total slot limit for ${c.code}. Currently ${c.slotLimit} (redeemed ${c.redeemedCount}).`, String(c.slotLimit))
    if (raw == null) return
    const next = Number(raw)
    if (!(next > 0)) { toast.error('Slot limit must be a positive number'); return }
    setBusyId(c.id)
    try {
      await adminApi.updateGasFreeCode(c.id, { slotLimit: next })
      toast.success(`${c.code} slot limit updated`)
      void load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to update slot limit')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={() => router.push('/admin/gas')} className="p-2 rounded-lg hover:bg-surface-alt"><ArrowLeft className="w-4 h-4" /></button>
        <div className="flex-1">
          <h1 className="text-lg font-bold text-text-primary">KOL Free-Gas Codes</h1>
          <p className="text-xs text-text-muted">Each redeemer gets a FIXED gas amount for free (real on-chain funds), restricted to one chain/token, capped by slots + a USDT budget. Only available on a user&apos;s first-ever gas order — the code box never shows again after that. Active only when <code>gas_free_code_enabled</code> is ON.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw className="w-4 h-4" /></Button>
        {isSuperAdmin && (
          <Button size="sm" variant="primary" onClick={() => setShowCreate((v) => !v)}>
            <Plus className="w-4 h-4 mr-1" />New Code
          </Button>
        )}
      </div>

      {showCreate && isSuperAdmin && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 space-y-3">
          <p className="text-xs text-amber-700 dark:text-amber-300">⚠️ Every redemption sends real funds (base + margin) at the platform&apos;s expense. Set the budget to what you&apos;re willing to give away.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-xs font-semibold text-text-primary">Code
              <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="KOLNAME20" className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm uppercase" />
            </label>
            <label className="text-xs font-semibold text-text-primary">KOL / Campaign label
              <input value={form.kolLabel} onChange={(e) => setForm({ ...form, kolLabel: e.target.value })} placeholder="Influencer Ali — launch giveaway" className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm" />
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-xs font-semibold text-text-primary">Chain
              <select value={form.chainId} onChange={(e) => void loadTokens(e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm">
                <option value="">Select chain…</option>
                {chains.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} ({c.networkLabel})</option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-semibold text-text-primary">Token
              <select value={form.tokenConfigId} onChange={(e) => setForm({ ...form, tokenConfigId: e.target.value })} disabled={!form.chainId || tokensLoading} className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm disabled:opacity-50">
                <option value="">{tokensLoading ? 'Loading…' : 'Select token…'}</option>
                {tokens.map((t) => <option key={t.id} value={t.id}>{t.symbol} — {t.name}</option>)}
              </select>
            </label>
          </div>
          <p className="text-[11px] text-text-muted">This code will ONLY be redeemable for the exact chain + token selected above.</p>

          <GasAmountConverter
            label="Gift amount per user"
            value={form.amountNative}
            onChange={(v) => setForm({ ...form, amountNative: v })}
            priceSymbol={selectedTokenObj?.priceSymbol}
            symbol={selectedTokenObj?.symbol}
            placeholder="0.00001"
            hint="Every redeemer gets exactly this much — they don't choose an amount."
            onUsdValueChange={setUsdPerUnit}
          />

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="text-xs font-semibold text-text-primary">Slots (first N free)
              <input type="number" min={1} value={form.slotLimit} onChange={(e) => setForm({ ...form, slotLimit: Number(e.target.value) })} className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm" />
            </label>
            <label className="text-xs font-semibold text-text-primary">USDT budget
              <input type="number" min={0} value={form.budgetUsdt} onChange={(e) => { setBudgetTouched(true); setForm({ ...form, budgetUsdt: Number(e.target.value) }) }} className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm" />
              {budgetTouched && usdPerUnit != null && (
                <button type="button" onClick={() => setBudgetTouched(false)} className="mt-1 text-[11px] text-primary hover:underline">
                  Reset to auto ({fmt(Number((usdPerUnit * form.slotLimit).toFixed(2)))} for {form.slotLimit} slots)
                </button>
              )}
              {!budgetTouched && usdPerUnit != null && (
                <span className="mt-1 block text-[11px] text-text-muted">Auto = per-user USDT value × slots.</span>
              )}
            </label>
            <label className="text-xs font-semibold text-text-primary">Per-user limit
              <input type="number" min={1} value={form.perUserLimit} onChange={(e) => setForm({ ...form, perUserLimit: Number(e.target.value) })} className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm" />
            </label>
          </div>
          <label className="text-xs font-semibold text-text-primary block">Expires (optional)
            <input type="datetime-local" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} className="mt-1 w-full sm:w-64 rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm" />
          </label>

          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={create} disabled={saving}>{saving ? 'Creating…' : 'Create Code'}</Button>
            <Button size="sm" variant="ghost" onClick={() => { setShowCreate(false); setForm(blankForm()); setBudgetTouched(false); setUsdPerUnit(null) }}>Cancel</Button>
          </div>
        </div>
      )}

      {loading && <LoadingState message="Loading free codes..." />}
      {error && !loading && <ErrorState description={error} onRetry={load} />}

      {!loading && !error && codes && codes.length === 0 && (
        <div className="rounded-xl border border-border bg-surface p-8 text-center text-sm text-text-muted">No free-gas codes yet.</div>
      )}

      {!loading && !error && codes && codes.length > 0 && (
        <div className="space-y-3">
          {codes.map((c) => {
            const budgetPct = c.budgetUsdt > 0 ? Math.min(100, (c.spentUsdt / c.budgetUsdt) * 100) : 0
            const slotPct = c.slotLimit > 0 ? Math.min(100, (c.redeemedCount / c.slotLimit) * 100) : 0
            const expired = c.expiresAt ? new Date(c.expiresAt).getTime() < Date.now() : false
            const ended = c.slotsRemaining <= 0 || c.budgetRemainingUsdt <= 0
            return (
              <div key={c.id} className="rounded-xl border border-border bg-surface p-4">
                <div className="flex items-start gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono font-bold text-text-primary">{c.code}</span>
                      <Badge variant={!c.isActive ? 'default' : expired ? 'warning' : ended ? 'warning' : 'success'}>
                        {!c.isActive ? 'Disabled' : expired ? 'Expired' : ended ? 'Ended' : 'Active'}
                      </Badge>
                    </div>
                    <p className="text-xs text-text-muted mt-0.5">{c.kolLabel} · {c.amountNative} {c.tokenSymbol ?? '—'} on {c.chainName ?? '—'}</p>
                  </div>
                  {isSuperAdmin && (
                    <div className="flex gap-2 flex-wrap">
                      <Button size="sm" variant="ghost" onClick={() => bumpAmount(c)} disabled={busyId === c.id}>Edit Amount</Button>
                      <Button size="sm" variant="ghost" onClick={() => bumpSlots(c)} disabled={busyId === c.id}>Edit Slots</Button>
                      <Button size="sm" variant="ghost" onClick={() => bumpBudget(c)} disabled={busyId === c.id}>Edit Budget</Button>
                      <Button size="sm" variant={c.isActive ? 'secondary' : 'primary'} onClick={() => toggleActive(c)} disabled={busyId === c.id}>
                        {c.isActive ? 'Disable' : 'Enable'}
                      </Button>
                    </div>
                  )}
                </div>

                <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div>
                    <p className="text-text-muted">Slots used</p>
                    <p className="font-semibold text-text-primary">{c.redeemedCount} / {c.slotLimit}</p>
                    <div className="mt-1 h-1.5 rounded-full bg-surface-alt overflow-hidden">
                      <div className={`h-full ${slotPct >= 100 ? 'bg-danger' : 'bg-primary'}`} style={{ width: `${slotPct}%` }} />
                    </div>
                  </div>
                  <div>
                    <p className="text-text-muted">Budget spent</p>
                    <p className="font-semibold text-text-primary">{fmt(c.spentUsdt)} / {fmt(c.budgetUsdt)}</p>
                    <div className="mt-1 h-1.5 rounded-full bg-surface-alt overflow-hidden">
                      <div className={`h-full ${budgetPct >= 100 ? 'bg-danger' : 'bg-primary'}`} style={{ width: `${budgetPct}%` }} />
                    </div>
                  </div>
                  <div><p className="text-text-muted">Gift amount</p><p className="font-semibold text-text-primary">{c.amountNative} {c.tokenSymbol ?? ''}</p></div>
                  <div><p className="text-text-muted">Eligibility</p><p className="font-semibold text-text-primary">1st order only</p></div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
