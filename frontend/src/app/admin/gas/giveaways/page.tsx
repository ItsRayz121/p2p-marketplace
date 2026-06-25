'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { gasApi, adminApi, type GasChain, type GasToken } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { toast } from '@/lib/toast'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { ArrowLeft, RefreshCw, Plus } from 'lucide-react'

type Campaign = Awaited<ReturnType<typeof adminApi.getGasGiveaways>>[number]

const blankForm = () => ({ code: '', kolLabel: '', tokenConfigId: '', amountNative: '', winnerCount: '10', entryDeadline: '', requireKyc: true })

export default function GasGiveawaysAdminPage() {
  const router = useRouter()
  const isSuperAdmin = useAuthStore((s) => s.user?.role === 'super_admin')

  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState(blankForm())
  const [chains, setChains] = useState<GasChain[]>([])
  const [selChain, setSelChain] = useState<GasChain | null>(null)
  const [tokens, setTokens] = useState<GasToken[]>([])
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setCampaigns(await adminApi.getGasGiveaways()) }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed to load giveaways') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => { if (showCreate && chains.length === 0) gasApi.getChains().then(({ chains: c }) => setChains(c.filter((x) => x.isAvailable))).catch(() => {}) }, [showCreate, chains.length])

  async function pickChain(c: GasChain) {
    setSelChain(c); setTokens([]); setForm((f) => ({ ...f, tokenConfigId: '' }))
    try { const r = await gasApi.getChainTokens(c.slug); setTokens(r.tokens) } catch { /* ignore */ }
  }

  async function create() {
    if (!form.code.trim() || !form.kolLabel.trim() || !form.tokenConfigId || !(parseFloat(form.amountNative) > 0) || !(parseInt(form.winnerCount) > 0)) {
      toast.error('Fill code, KOL, token, amount and winner count'); return
    }
    setSaving(true)
    try {
      await adminApi.createGasGiveaway({
        code: form.code.trim().toUpperCase(),
        kolLabel: form.kolLabel.trim(),
        tokenConfigId: form.tokenConfigId,
        amountNative: parseFloat(form.amountNative),
        winnerCount: parseInt(form.winnerCount),
        requireKyc: form.requireKyc,
        ...(form.entryDeadline ? { entryDeadline: new Date(form.entryDeadline).toISOString() } : {}),
      })
      toast.success(`Giveaway ${form.code.toUpperCase()} created`)
      setForm(blankForm()); setShowCreate(false); setSelChain(null); setTokens([])
      void load()
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Failed to create') }
    finally { setSaving(false) }
  }

  async function draw(c: Campaign) {
    const remaining = c.winnerCount - c.drawnCount
    const raw = window.prompt(`Draw how many winners for ${c.code}? (${remaining} slots left, ${c.entryCount} entries). This sends REAL free gas to winners.`, String(remaining))
    if (raw == null) return
    const count = Number(raw)
    if (!(count > 0)) { toast.error('Enter a positive number'); return }
    setBusyId(c.id)
    try {
      const r = await adminApi.drawGasGiveaway(c.id, count)
      const failed = r.results.filter((x) => !x.ok).length
      toast.success(`Drew ${r.drawn} winner(s)${failed ? `, ${failed} failed` : ''}`)
      void load()
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Draw failed') }
    finally { setBusyId(null) }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={() => router.push('/admin/gas')} className="p-2 rounded-lg hover:bg-surface-alt"><ArrowLeft className="w-4 h-4" /></button>
        <div className="flex-1">
          <h1 className="text-lg font-bold text-text-primary">Gas Giveaways</h1>
          <p className="text-xs text-text-muted">KOL campaigns — entrants submit a receiving address; you draw winners and free gas is sent automatically. Active only when <code>gas_giveaway_enabled</code> is ON.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw className="w-4 h-4" /></Button>
        {isSuperAdmin && <Button size="sm" variant="primary" onClick={() => setShowCreate((v) => !v)}><Plus className="w-4 h-4 mr-1" />New</Button>}
      </div>

      {showCreate && isSuperAdmin && (
        <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-xs font-semibold text-text-primary">Code
              <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="ALIDROP" className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm uppercase" />
            </label>
            <label className="text-xs font-semibold text-text-primary">KOL / campaign name
              <input value={form.kolLabel} onChange={(e) => setForm({ ...form, kolLabel: e.target.value })} placeholder="Influencer Ali" className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm" />
            </label>
          </div>
          <div>
            <p className="text-xs font-semibold text-text-primary mb-1.5">Token winners receive</p>
            <div className="flex flex-wrap gap-2 mb-2">
              {chains.map((c) => (
                <button key={c.id} onClick={() => pickChain(c)} className={`px-3 py-1.5 rounded-lg border text-sm ${selChain?.id === c.id ? 'border-primary bg-primary/10 text-primary font-semibold' : 'border-border bg-surface-alt'}`}>{c.name}</button>
              ))}
            </div>
            {selChain && (
              <select value={form.tokenConfigId} onChange={(e) => setForm({ ...form, tokenConfigId: e.target.value })} className="w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm">
                <option value="">Select token…</option>
                {tokens.map((t) => <option key={t.id} value={t.id}>{t.symbol} — {t.name}</option>)}
              </select>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <label className="text-xs font-semibold text-text-primary">Amount per winner (native)
              <input value={form.amountNative} onChange={(e) => setForm({ ...form, amountNative: e.target.value })} placeholder="0.01" inputMode="decimal" className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm" />
            </label>
            <label className="text-xs font-semibold text-text-primary"># Winners
              <input value={form.winnerCount} onChange={(e) => setForm({ ...form, winnerCount: e.target.value })} inputMode="numeric" className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm" />
            </label>
            <label className="text-xs font-semibold text-text-primary">Entry deadline (optional)
              <input type="datetime-local" value={form.entryDeadline} onChange={(e) => setForm({ ...form, entryDeadline: e.target.value })} className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm" />
            </label>
          </div>
          <label className="flex items-center gap-2 text-xs font-semibold text-text-primary">
            <input type="checkbox" checked={form.requireKyc} onChange={(e) => setForm({ ...form, requireKyc: e.target.checked })} />
            Require KYC to enter (recommended)
          </label>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={create} disabled={saving}>{saving ? 'Creating…' : 'Create Giveaway'}</Button>
            <Button size="sm" variant="ghost" onClick={() => { setShowCreate(false); setForm(blankForm()) }}>Cancel</Button>
          </div>
        </div>
      )}

      {loading && <LoadingState message="Loading giveaways..." />}
      {error && !loading && <ErrorState description={error} onRetry={load} />}
      {!loading && !error && campaigns && campaigns.length === 0 && (
        <div className="rounded-xl border border-border bg-surface p-8 text-center text-sm text-text-muted">No giveaways yet.</div>
      )}

      {!loading && !error && campaigns && campaigns.length > 0 && (
        <div className="space-y-3">
          {campaigns.map((c) => (
            <div key={c.id} className="rounded-xl border border-border bg-surface p-4">
              <div className="flex items-start gap-3 flex-wrap">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-text-primary">{c.code}</span>
                    <Badge variant={c.status === 'open' ? 'success' : c.status === 'drawn' ? 'info' : 'default'}>{c.status}</Badge>
                  </div>
                  <p className="text-xs text-text-muted mt-0.5">{c.kolLabel}</p>
                </div>
                {isSuperAdmin && c.drawnCount < c.winnerCount && (
                  <Button size="sm" variant="primary" onClick={() => draw(c)} disabled={busyId === c.id || c.entryCount === 0}>Draw winners</Button>
                )}
              </div>
              <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <div><p className="text-text-muted">Amount/winner</p><p className="font-semibold text-text-primary">{c.amountNative}</p></div>
                <div><p className="text-text-muted">Winners drawn</p><p className="font-semibold text-text-primary">{c.drawnCount} / {c.winnerCount}</p></div>
                <div><p className="text-text-muted">Entries</p><p className="font-semibold text-text-primary">{c.entryCount}</p></div>
                <div><p className="text-text-muted">KYC</p><p className="font-semibold text-text-primary">{c.requireKyc ? 'Required' : 'No'}</p></div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
