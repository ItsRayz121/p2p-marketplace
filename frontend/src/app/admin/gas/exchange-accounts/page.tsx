'use client'
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { adminApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { toast } from '@/lib/toast'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { ArrowLeft, RefreshCw, Plus, Trash2 } from 'lucide-react'

type Account = Awaited<ReturnType<typeof adminApi.listGasExchangeAccounts>>['accounts'][number]

// Slugs that already have a logo. Any other slug still works, it just shows the
// generic fallback icon until a logo is uploaded in the logo registry.
const PRESETS: Array<{ exchange: string; displayName: string }> = [
  { exchange: 'binance', displayName: 'Binance' },
  { exchange: 'bybit', displayName: 'Bybit' },
  { exchange: 'okx', displayName: 'OKX' },
  { exchange: 'bitget', displayName: 'Bitget' },
  { exchange: 'gate', displayName: 'Gate.io' },
  { exchange: 'mexc', displayName: 'MEXC' },
  { exchange: 'kucoin', displayName: 'KuCoin' },
  { exchange: 'htx', displayName: 'HTX' },
]

const blankForm = () => ({ exchange: 'binance', displayName: 'Binance', accountUid: '', note: '' })

export default function GasExchangeAccountsPage() {
  const isSuperAdmin = useAuthStore((s) => s.user?.role === 'super_admin')

  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState(blankForm())
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editUid, setEditUid] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      setAccounts((await adminApi.listGasExchangeAccounts()).accounts)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load exchange accounts')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  async function handleCreate() {
    if (!form.accountUid.trim()) { toast.error('Enter the account UID customers should pay into'); return }
    setSaving(true)
    try {
      await adminApi.createGasExchangeAccount({
        exchange: form.exchange, displayName: form.displayName.trim(), accountUid: form.accountUid.trim(),
        note: form.note.trim() || null, sortOrder: (accounts?.length ?? 0),
      })
      toast.success('Exchange account added')
      setForm(blankForm()); setShowCreate(false)
      await load()
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Failed to add') }
    finally { setSaving(false) }
  }

  async function toggleActive(a: Account) {
    setBusyId(a.id)
    try {
      await adminApi.updateGasExchangeAccount(a.id, { isActive: !a.isActive })
      await load()
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Failed to update') }
    finally { setBusyId(null) }
  }

  async function saveUid(a: Account) {
    if (!editUid.trim()) return
    setBusyId(a.id)
    try {
      await adminApi.updateGasExchangeAccount(a.id, { accountUid: editUid.trim() })
      toast.success('UID updated. New orders will show it; open orders keep the UID they were given.')
      setEditingId(null)
      await load()
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Failed to update') }
    finally { setBusyId(null) }
  }

  async function remove(a: Account) {
    if (!window.confirm(`Delete ${a.displayName} (${a.accountUid})? Customers will no longer see it. Existing orders are not affected.`)) return
    setBusyId(a.id)
    try {
      await adminApi.deleteGasExchangeAccount(a.id)
      await load()
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Failed to delete') }
    finally { setBusyId(null) }
  }

  if (loading && !accounts) return <LoadingState message="Loading exchange accounts..." />
  if (error) return <ErrorState title={error} onRetry={load} />

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <Link href="/admin/gas" className="text-text-muted hover:text-text-primary" aria-label="Back to gas orders"><ArrowLeft size={18} /></Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-text-primary">Exchange Accounts</h1>
          <p className="text-xs text-text-muted">The exchange UIDs customers send USDT to when they pick &ldquo;Exchange transfer&rdquo; on the gas page. Only active rows are shown to customers.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void load()}><RefreshCw size={14} className="mr-1" />Refresh</Button>
        {isSuperAdmin && <Button size="sm" onClick={() => setShowCreate((v) => !v)}><Plus size={14} className="mr-1" />Add</Button>}
      </div>

      {!isSuperAdmin && (
        <p className="text-xs text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2">
          Read only. Only a super admin can add or change these accounts, because customers send money to them.
        </p>
      )}

      {showCreate && isSuperAdmin && (
        <div className="bg-surface shadow-card rounded-xl border border-border p-4 space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="ea-ex" className="text-xs font-semibold text-text-secondary">Exchange</label>
              <select
                id="ea-ex" value={form.exchange}
                onChange={(e) => {
                  const p = PRESETS.find((x) => x.exchange === e.target.value)
                  setForm((f) => ({ ...f, exchange: e.target.value, displayName: p?.displayName ?? f.displayName }))
                }}
                className="mt-1 w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-text-primary"
              >
                {PRESETS.map((p) => <option key={p.exchange} value={p.exchange}>{p.displayName}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="ea-uid" className="text-xs font-semibold text-text-secondary">Our account UID</label>
              <input id="ea-uid" value={form.accountUid} onChange={(e) => setForm((f) => ({ ...f, accountUid: e.target.value }))}
                autoComplete="off" placeholder="e.g. 512884097"
                className="mt-1 w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-text-primary font-mono" />
            </div>
          </div>
          <div>
            <label htmlFor="ea-note" className="text-xs font-semibold text-text-secondary">Note for staff (optional, not shown to customers)</label>
            <input id="ea-note" value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              className="mt-1 w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-text-primary" />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" size="sm" onClick={() => { setShowCreate(false); setForm(blankForm()) }}>Cancel</Button>
            <Button size="sm" loading={saving} disabled={saving} onClick={handleCreate}>Add account</Button>
          </div>
        </div>
      )}

      {accounts && accounts.length === 0 ? (
        <div className="bg-surface shadow-card rounded-xl border border-border p-6 text-center text-sm text-text-muted">
          No exchange accounts yet. Until you add one, the &ldquo;Exchange transfer&rdquo; option stays hidden from customers.
        </div>
      ) : (
        <div className="bg-surface shadow-card rounded-xl border border-border divide-y divide-border">
          {(accounts ?? []).map((a) => (
            <div key={a.id} className="p-4 flex items-center gap-3 flex-wrap">
              <EntityLogo type="exchange" slug={a.exchange} size="lg" className="w-9 h-9 rounded-lg flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-bold text-text-primary">{a.displayName}</p>
                  <Badge variant={a.isActive ? 'success' : 'default'} size="sm">{a.isActive ? 'Active' : 'Hidden'}</Badge>
                </div>
                {editingId === a.id ? (
                  <div className="flex items-center gap-2 mt-1.5">
                    <input value={editUid} onChange={(e) => setEditUid(e.target.value)} aria-label="New account UID"
                      className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm font-mono text-text-primary w-44" />
                    <Button size="sm" loading={busyId === a.id} onClick={() => void saveUid(a)}>Save</Button>
                    <Button size="sm" variant="secondary" onClick={() => setEditingId(null)}>Cancel</Button>
                  </div>
                ) : (
                  <p className="text-xs font-mono text-text-secondary mt-0.5 break-all">UID {a.accountUid}</p>
                )}
                {a.note && <p className="text-xs text-text-muted mt-0.5">{a.note}</p>}
              </div>
              {isSuperAdmin && editingId !== a.id && (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={() => { setEditingId(a.id); setEditUid(a.accountUid) }}>Edit UID</Button>
                  <Button size="sm" variant="secondary" loading={busyId === a.id} onClick={() => void toggleActive(a)}>{a.isActive ? 'Hide' : 'Show'}</Button>
                  <Button size="sm" variant="ghost" onClick={() => void remove(a)} aria-label={`Delete ${a.displayName}`}><Trash2 size={14} /></Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
