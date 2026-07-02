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
import { CopyButton } from '@/components/ui/CopyButton'
import { GasAmountConverter } from '@/components/admin/GasAmountConverter'
import { ArrowLeft, RefreshCw, Plus, ChevronDown, ChevronRight, Search, Download, XCircle } from 'lucide-react'

function giveawayLink(code: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return `${origin}/gas/giveaway/${code}`
}

type Campaign = Awaited<ReturnType<typeof adminApi.getGasGiveaways>>[number]
type Entry = Awaited<ReturnType<typeof adminApi.getGasGiveawayEntries>>[number]

function deliveryVariant(s: string | null): 'success' | 'warning' | 'danger' | 'default' {
  if (s === 'delivered') return 'success'
  if (s === 'failed' || s === 'refunded' || s === 'expired') return 'danger'
  if (!s) return 'default'
  return 'warning' // payment_detected / sending / etc — in flight
}

const blankForm = () => ({ code: '', kolLabel: '', tokenConfigId: '', amountNative: '', winnerCount: '10', entryDeadline: '', requireKyc: true })

export default function GasGiveawaysAdminPage() {
  const router = useRouter()
  const isSuperAdmin = useAuthStore((s) => s.user?.role === 'super_admin')

  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState(blankForm())
  const [chains, setChains] = useState<AdminGasChain[]>([])
  const [selChain, setSelChain] = useState<AdminGasChain | null>(null)
  const [tokens, setTokens] = useState<AdminGasToken[]>([])
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [entries, setEntries] = useState<Record<string, Entry[]>>({})
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [entriesBusy, setEntriesBusy] = useState<string | null>(null)
  // Finished campaigns (sent/closed) render collapsed by default; ids here are the
  // ones the admin has manually expanded back open.
  const [expandedDone, setExpandedDone] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')

  const loadEntries = useCallback(async (campaignId: string) => {
    setEntriesBusy(campaignId)
    try {
      const e = await adminApi.getGasGiveawayEntries(campaignId)
      setEntries((prev) => ({ ...prev, [campaignId]: e }))
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Failed to load entries') }
    finally { setEntriesBusy(null) }
  }, [])

  async function toggleEntries(c: Campaign) {
    if (expandedId === c.id) { setExpandedId(null); return }
    setExpandedId(c.id)
    if (!entries[c.id]) await loadEntries(c.id)
  }

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setCampaigns(await adminApi.getGasGiveaways()) }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed to load giveaways') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])
  // Use the SAME admin chain/token source as the Free-Gas page so a KOL prize can be ANY
  // chain/token whose gas we provide (every non-archived one, including those hidden from
  // regular users), and any chain/token added later appears automatically — no hardcoding.
  useEffect(() => {
    if (showCreate && chains.length === 0) {
      adminApi.getGasChains()
        .then((r) => setChains(r.chains.filter((c) => !c.isArchived).sort((a, b) => a.displayOrder - b.displayOrder)))
        .catch(() => {})
    }
  }, [showCreate, chains.length])

  async function pickChain(c: AdminGasChain) {
    setSelChain(c); setTokens([]); setForm((f) => ({ ...f, tokenConfigId: '' }))
    try { const r = await adminApi.getGasTokens(c.id); setTokens(r.tokens.filter((t) => !t.isArchived)) } catch { /* ignore */ }
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

  // Step 1: randomly SELECT winners. No funds move — rewards are sent separately.
  async function draw(c: Campaign) {
    const remaining = c.winnerCount - c.drawnCount
    const raw = window.prompt(`Draw how many winners for ${c.code}? (${remaining} slots left, ${c.entryCount} entries). This only SELECTS winners — you'll send the rewards in the next step.`, String(remaining))
    if (raw == null) return
    const count = Number(raw)
    if (!(count > 0)) { toast.error('Enter a positive number'); return }
    setBusyId(c.id)
    try {
      const r = await adminApi.drawGasGiveaway(c.id, count)
      toast.success(`Selected ${r.selected} winner(s) — review, then Send rewards`)
      void load()
      // Refresh the winners list if it's currently loaded/open.
      if (entries[c.id] || expandedId === c.id) void loadEntries(c.id)
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Draw failed') }
    finally { setBusyId(null) }
  }

  // Step 2: deliver real free gas to every selected (but unsent) winner.
  async function send(c: Campaign) {
    if (!window.confirm(`Send free gas to ${c.selectedCount} selected winner(s) of ${c.code}? This releases REAL on-chain funds at the platform's expense.`)) return
    setBusyId(c.id)
    try {
      const r = await adminApi.sendGasGiveaway(c.id)
      const failed = r.results.filter((x) => !x.ok).length
      toast.success(`Sent ${r.sent} reward(s)${failed ? `, ${failed} failed — press Send again to retry` : ''}`)
      void load()
      if (entries[c.id] || expandedId === c.id) void loadEntries(c.id)
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Send failed') }
    finally { setBusyId(null) }
  }

  // Instantly close a campaign (stops entries, marks it done) — for wrapping up a KOL
  // campaign early after delivering the prizes you wanted, without drawing all slots.
  async function closeCampaign(c: Campaign) {
    if (!window.confirm(`Close giveaway ${c.code} now? It will stop accepting entries and be marked done. Winners already drawn are unaffected.`)) return
    setBusyId(c.id)
    try {
      await adminApi.closeGasGiveaway(c.id)
      toast.success(`Giveaway ${c.code} closed`)
      void load()
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Close failed') }
    finally { setBusyId(null) }
  }

  // Export a campaign's entries to a CSV (username/email, address, status, tx ref). Loads
  // them first if not already fetched, then triggers a client-side download.
  async function exportEntries(c: Campaign) {
    let list = entries[c.id]
    if (!list) {
      try {
        list = await adminApi.getGasGiveawayEntries(c.id)
        setEntries((prev) => ({ ...prev, [c.id]: list! }))
      } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Failed to load entries'); return }
    }
    if (!list || list.length === 0) { toast.error('No entries to export'); return }
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`
    const header = ['email', 'userId', 'receivingAddress', 'status', 'orderStatus', 'orderRef', 'enteredAt']
    const rows = list.map((e) => [e.email ?? '', e.userId, e.receivingAddress, e.status, e.orderStatus ?? '', e.orderRef ?? '', new Date(e.createdAt).toISOString()].map((x) => esc(String(x))).join(','))
    const csv = [header.join(','), ...rows].join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `giveaway-${c.code}-entries.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  // Selected token (for the min-amount hint/guard on the create form). The minimum is
  // resolved the same way the backend does it: token override → chain default → fallback.
  const selToken = tokens.find((t) => t.id === form.tokenConfigId) ?? null
  const amountNum = parseFloat(form.amountNative)
  const tokenMin = selToken ? Number(selToken.minAmount ?? selChain?.defaultMinAmount ?? 0.1) : 0
  const belowMin = !!selToken && amountNum > 0 && amountNum < tokenMin

  // Campaigns filtered by the search box (code or KOL/campaign name).
  const q = query.trim().toLowerCase()
  const visibleCampaigns = !campaigns ? null : (!q ? campaigns : campaigns.filter((c) => `${c.code} ${c.kolLabel}`.toLowerCase().includes(q)))

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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-xs font-semibold text-text-primary">Chain
              <select
                value={selChain?.id ?? ''}
                onChange={(e) => {
                  const c = chains.find((x) => x.id === e.target.value)
                  if (c) void pickChain(c)
                  else { setSelChain(null); setTokens([]); setForm((f) => ({ ...f, tokenConfigId: '' })) }
                }}
                className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm"
              >
                <option value="">Select chain…</option>
                {chains.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="text-xs font-semibold text-text-primary">Token winners receive
              <select
                value={form.tokenConfigId}
                onChange={(e) => setForm({ ...form, tokenConfigId: e.target.value })}
                disabled={!selChain}
                className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm disabled:opacity-50"
              >
                <option value="">{selChain ? 'Select token…' : 'Pick a chain first'}</option>
                {tokens.map((t) => <option key={t.id} value={t.id}>{t.symbol} — {t.name}</option>)}
              </select>
            </label>
          </div>
          <GasAmountConverter
            label="Amount per winner"
            value={form.amountNative}
            onChange={(v) => setForm({ ...form, amountNative: v })}
            priceSymbol={selToken?.priceSymbol}
            symbol={selToken?.symbol}
            invalid={belowMin}
            hint={selToken
              ? (belowMin
                ? <span className="text-danger">Minimum is {tokenMin} {selToken.symbol}</span>
                : <span className="text-text-muted">min {tokenMin} {selToken.symbol} per winner</span>)
              : null}
          />
          <div className="grid grid-cols-2 gap-3">
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
            <Button size="sm" variant="primary" onClick={create} disabled={saving || belowMin}>{saving ? 'Creating…' : 'Create Giveaway'}</Button>
            <Button size="sm" variant="ghost" onClick={() => { setShowCreate(false); setForm(blankForm()) }}>Cancel</Button>
          </div>
        </div>
      )}

      {!loading && !error && campaigns && campaigns.length > 0 && (
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by code or campaign name…"
            className="w-full rounded-lg border border-border bg-surface-alt pl-9 pr-3 py-2 text-sm"
          />
        </div>
      )}

      {loading && <LoadingState message="Loading giveaways..." />}
      {error && !loading && <ErrorState description={error} onRetry={load} />}
      {!loading && !error && campaigns && campaigns.length === 0 && (
        <div className="rounded-xl border border-border bg-surface p-8 text-center text-sm text-text-muted">No giveaways yet.</div>
      )}
      {!loading && !error && visibleCampaigns && visibleCampaigns.length === 0 && campaigns && campaigns.length > 0 && (
        <div className="rounded-xl border border-border bg-surface p-8 text-center text-sm text-text-muted">No giveaways match your search.</div>
      )}

      {!loading && !error && visibleCampaigns && visibleCampaigns.length > 0 && (
        <div className="space-y-3">
          {visibleCampaigns.map((c) => {
            // Finished campaigns (all rewards sent, or manually closed) collapse to just
            // their header to keep the list tidy; click the chevron to reopen.
            const isDone = c.status === 'sent' || c.status === 'closed'
            const collapsed = isDone && !expandedDone.has(c.id)
            return (
            <div key={c.id} className={`rounded-xl border border-border bg-surface ${collapsed ? 'p-3' : 'p-4'}`}>
              <div className="flex items-start gap-3 flex-wrap">
                {isDone && (
                  <button
                    onClick={() => setExpandedDone((prev) => { const n = new Set(prev); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n })}
                    className="p-0.5 rounded hover:bg-surface-alt text-text-muted shrink-0 mt-0.5"
                    aria-label={collapsed ? 'Expand' : 'Collapse'}
                  >
                    {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono font-bold text-text-primary">{c.code}</span>
                    <Badge variant={c.status === 'open' ? 'success' : c.status === 'drawn' ? 'warning' : c.status === 'sent' ? 'info' : 'default'}>{c.status}</Badge>
                    {collapsed && <span className="text-[11px] text-text-muted">{c.sentCount}/{c.winnerCount} delivered · {c.entryCount} entries</span>}
                  </div>
                  {!collapsed && <p className="text-xs text-text-muted mt-0.5">{c.kolLabel}</p>}
                </div>
                {isSuperAdmin && !collapsed && c.selectedCount > 0 && (
                  <Button size="sm" variant="primary" onClick={() => send(c)} disabled={busyId === c.id}>Send rewards ({c.selectedCount})</Button>
                )}
                {isSuperAdmin && !collapsed && c.drawnCount < c.winnerCount && (
                  <Button size="sm" variant={c.selectedCount > 0 ? 'secondary' : 'primary'} onClick={() => draw(c)} disabled={busyId === c.id || c.entryCount === 0}>Draw winners</Button>
                )}
                {isSuperAdmin && !collapsed && c.status !== 'sent' && c.status !== 'closed' && (
                  <Button size="sm" variant="ghost" onClick={() => closeCampaign(c)} disabled={busyId === c.id} title="Close this giveaway now">
                    <XCircle className="w-4 h-4 mr-1" />Close
                  </Button>
                )}
              </div>

              {!collapsed && <>
              {/* Shareable entry link — what the KOL posts; entrants open it to submit an address. */}
              <div className="mt-2 flex items-center gap-2 rounded-lg bg-surface-alt border border-border px-3 py-2">
                <span className="text-[11px] text-text-muted shrink-0">Entry link</span>
                <span className="text-xs font-mono text-text-secondary truncate flex-1">{giveawayLink(c.code)}</span>
                <CopyButton text={giveawayLink(c.code)} />
              </div>
              <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
                <div><p className="text-text-muted">Amount/winner</p><p className="font-semibold text-text-primary">{c.amountNative}</p></div>
                <div><p className="text-text-muted">Winners drawn</p><p className="font-semibold text-text-primary">{c.drawnCount} / {c.winnerCount}</p></div>
                <div><p className="text-text-muted">Rewards sent</p><p className="font-semibold text-text-primary">{c.sentCount}{c.selectedCount > 0 ? <span className="text-warning"> · {c.selectedCount} pending</span> : null}</p></div>
                <div><p className="text-text-muted">Entries</p><p className="font-semibold text-text-primary">{c.entryCount}</p></div>
                <div><p className="text-text-muted">KYC</p><p className="font-semibold text-text-primary">{c.requireKyc ? 'Required' : 'No'}</p></div>
              </div>

              {/* Participants + winners history */}
              <div className="mt-3 flex items-center gap-4">
                <button
                  onClick={() => toggleEntries(c)}
                  className="text-xs font-semibold text-primary hover:underline"
                >
                  {expandedId === c.id ? 'Hide participants' : `View participants & winners (${c.entryCount})`}
                </button>
                {c.entryCount > 0 && (
                  <button
                    onClick={() => void exportEntries(c)}
                    className="text-xs font-semibold text-text-muted hover:text-text-primary inline-flex items-center gap-1"
                  >
                    <Download className="w-3.5 h-3.5" /> Export CSV
                  </button>
                )}
              </div>

              {expandedId === c.id && (
                <div className="mt-2 rounded-lg border border-border bg-surface-alt/50 p-3">
                  {entriesBusy === c.id && !entries[c.id] ? (
                    <p className="text-xs text-text-muted text-center py-2">Loading participants…</p>
                  ) : !entries[c.id] || entries[c.id]!.length === 0 ? (
                    <p className="text-xs text-text-muted text-center py-2">No participants yet.</p>
                  ) : (
                    <>
                      {(() => {
                        const list = entries[c.id]!
                        const selected = list.filter((e) => e.status === 'selected')
                        const won = list.filter((e) => e.status === 'won')
                        const delivered = won.filter((e) => e.orderStatus === 'delivered')
                        return (
                          <div className="flex flex-wrap items-center gap-3 text-xs mb-3 pb-2 border-b border-border">
                            <span><span className="text-text-muted">Participants </span><span className="font-semibold text-text-primary">{list.length}</span></span>
                            <span><span className="text-text-muted">Winners </span><span className="font-semibold text-text-primary">{selected.length + won.length}</span></span>
                            {selected.length > 0 && <span><span className="text-text-muted">Awaiting send </span><span className="font-semibold text-warning">{selected.length}</span></span>}
                            <span><span className="text-text-muted">Prize delivered </span><span className="font-semibold text-success">{delivered.length}</span></span>
                            <button
                              onClick={() => { void navigator.clipboard.writeText(list.map((e) => e.receivingAddress).join('\n')); toast.success(`Copied ${list.length} address${list.length === 1 ? '' : 'es'}`) }}
                              className="ml-auto text-primary hover:underline font-semibold"
                            >
                              Copy all addresses
                            </button>
                          </div>
                        )
                      })()}
                      <div className="space-y-1.5 max-h-80 overflow-auto">
                        {entries[c.id]!.map((e) => (
                          <div key={e.id} className="flex items-center gap-2 text-xs">
                            <span className="text-text-secondary truncate flex-1 min-w-0">{e.email ?? `user ${e.userId.slice(0, 8)}`}</span>
                            <span className="font-mono text-text-muted truncate hidden sm:inline" style={{ maxWidth: 140 }}>{e.receivingAddress.slice(0, 8)}…{e.receivingAddress.slice(-6)}</span>
                            <CopyButton text={e.receivingAddress} />
                            {e.status === 'won' ? (
                              <span className="flex items-center gap-1 shrink-0">
                                <Badge variant="success">won</Badge>
                                <Badge variant={deliveryVariant(e.orderStatus)}>{e.orderStatus ?? 'pending'}</Badge>
                              </span>
                            ) : e.status === 'selected' ? (
                              <Badge variant="warning">selected · awaiting send</Badge>
                            ) : (
                              <Badge variant="default">{e.status === 'not_selected' ? 'not selected' : 'entered'}</Badge>
                            )}
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
              </>}
            </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
