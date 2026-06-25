'use client'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { adminApi, type AdminGasChain, type AdminGasToken } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/Button'
import { ArrowLeft, Gift, Plus, X, ChevronDown, History } from 'lucide-react'

// Admin-only tool to send fully platform-funded (free) gas deliveries. The platform
// covers base + margin; each order routes through the normal delivery worker. Runs
// only when the gas_free_grant_enabled flag is ON (else the API rejects it).
//
// Recipients are entered as individual add/remove rows; a single submission fans out to
// every address (one order per address). A collapsible history lists past free sends.
type SendResult = { address: string; ok: boolean; orderRef?: string; error?: string }
type FreeOrder = { id: string; orderRef: string; toAddress: string; chain: string; gasAmountNative: string | number; status: string; createdAt: string }

function statusColor(s: string): string {
  if (s === 'delivered') return 'text-green-700 dark:text-green-300'
  if (s === 'failed' || s === 'refunded' || s === 'cancelled') return 'text-red-600 dark:text-red-400'
  return 'text-amber-600 dark:text-amber-400'
}

export default function AdminFreeGasPage() {
  const router = useRouter()
  const isSuperAdmin = useAuthStore((s) => s.user?.role === 'super_admin')

  const [chains, setChains] = useState<AdminGasChain[]>([])
  const [chainId, setChainId] = useState('')
  const [tokens, setTokens] = useState<AdminGasToken[]>([])
  const [tokensLoading, setTokensLoading] = useState(false)
  const [tokenId, setTokenId] = useState('')
  const [amount, setAmount] = useState('')
  const [addressRows, setAddressRows] = useState<string[]>([''])
  const [userId, setUserId] = useState('')
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [results, setResults] = useState<SendResult[] | null>(null)
  const [history, setHistory] = useState<FreeOrder[]>([])
  const [showHistory, setShowHistory] = useState(false)

  useEffect(() => {
    adminApi.getGasChains()
      .then((r) => setChains(r.chains.filter((c) => !c.isArchived).sort((a, b) => a.displayOrder - b.displayOrder)))
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Failed to load chains'))
  }, [])

  const loadHistory = useCallback(async () => {
    try {
      const r = await adminApi.getGasOrders({ freeGrant: 'true', limit: 25 })
      setHistory(r.orders as FreeOrder[])
    } catch { /* non-critical */ }
  }, [])

  useEffect(() => { void loadHistory() }, [loadHistory])

  const loadTokens = useCallback(async (id: string) => {
    setChainId(id); setTokens([]); setTokenId('')
    if (!id) return
    setTokensLoading(true)
    try {
      const r = await adminApi.getGasTokens(id)
      setTokens(r.tokens.filter((t) => !t.isArchived))
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to load tokens')
    } finally {
      setTokensLoading(false)
    }
  }, [])

  // De-duplicated, non-empty addresses across all rows.
  const addresses = useMemo(
    () => Array.from(new Set(addressRows.map((a) => a.trim()).filter(Boolean))),
    [addressRows],
  )

  const selChain = chains.find((c) => c.id === chainId) ?? null
  const addrPlaceholder = selChain?.addressType === 'tron' ? 'T…' : selChain?.addressType === 'aptos' ? '0x…(Aptos)' : '0x…'

  const setRow = (i: number, v: string) => setAddressRows((rows) => rows.map((r, idx) => (idx === i ? v : r)))
  const addRow = () => setAddressRows((rows) => [...rows, ''])
  const removeRow = (i: number) => setAddressRows((rows) => (rows.length <= 1 ? [''] : rows.filter((_, idx) => idx !== i)))

  async function send() {
    if (!tokenId || !(parseFloat(amount) > 0) || addresses.length === 0) {
      toast.error('Token, amount and at least one address are required'); return
    }
    if (!window.confirm(`Send a FREE gas delivery of ${amount} to ${addresses.length} address${addresses.length === 1 ? '' : 'es'}? The platform pays the full cost (base + margin) for each. This sends real funds on-chain.`)) return
    setSending(true)
    setResults(null)
    const out: SendResult[] = []
    for (const address of addresses) {
      try {
        const res = await adminApi.freeGasDeliver({
          tokenConfigId: tokenId,
          amount: parseFloat(amount),
          toAddress: address,
          ...(userId.trim() ? { userId: userId.trim() } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        })
        out.push({ address, ok: true, orderRef: res.orderRef })
      } catch (e: unknown) {
        out.push({ address, ok: false, error: e instanceof Error ? e.message : 'Failed' })
      }
      setResults([...out])
    }
    setSending(false)
    const okCount = out.filter((r) => r.ok).length
    const failCount = out.length - okCount
    if (okCount > 0) toast.success(`Queued ${okCount} free deliver${okCount === 1 ? 'y' : 'ies'}${failCount ? `, ${failCount} failed` : ''}`)
    else toast.error('All deliveries failed')
    if (failCount === 0) { setAmount(''); setAddressRows(['']); setUserId(''); setNote('') }
    void loadHistory()
  }

  if (!isSuperAdmin) {
    return <div className="max-w-2xl mx-auto px-4 py-10 text-center text-sm text-text-muted">Super-admin access required.</div>
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={() => router.push('/admin/gas')} className="p-2 rounded-lg hover:bg-surface-alt"><ArrowLeft className="w-4 h-4" /></button>
        <div className="flex items-center gap-2">
          <Gift className="w-5 h-5 text-primary" />
          <div>
            <h1 className="text-lg font-bold text-text-primary">Free Gas Delivery</h1>
            <p className="text-xs text-text-muted">Platform-funded free gas for one or more addresses. Requires <code>gas_free_grant_enabled</code> to be ON.</p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
        This sends <b>real funds on-chain</b> at the platform&apos;s expense (base + margin) for <b>every</b> address. Use only for the curated set of users you intend to sponsor.
      </div>

      <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block text-xs font-semibold text-text-primary">Chain
            <select value={chainId} onChange={(e) => loadTokens(e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm">
              <option value="">Select chain…</option>
              {chains.map((c) => (
                <option key={c.id} value={c.id}>{c.name} ({c.networkLabel}){c.isVisibleToUsers ? '' : ' · hidden'}</option>
              ))}
            </select>
          </label>

          <label className="block text-xs font-semibold text-text-primary">Token
            <select value={tokenId} onChange={(e) => setTokenId(e.target.value)} disabled={!chainId || tokensLoading} className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm disabled:opacity-50">
              <option value="">{tokensLoading ? 'Loading…' : 'Select token…'}</option>
              {tokens.map((t) => <option key={t.id} value={t.id}>{t.symbol} — {t.name}{t.platformFeeUsdt != null ? ` (fee $${t.platformFeeUsdt})` : ''}</option>)}
            </select>
          </label>
        </div>

        <label className="block text-xs font-semibold text-text-primary">Amount per address (native)
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.5" inputMode="decimal" className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm" />
        </label>

        <div className="space-y-2">
          <p className="text-xs font-semibold text-text-primary">Recipient address(es) <span className="font-normal text-text-muted">— same amount goes to each</span></p>
          {addressRows.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                value={row}
                onChange={(e) => setRow(i, e.target.value)}
                placeholder={addrPlaceholder}
                className="flex-1 rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm font-mono"
              />
              <button
                type="button"
                onClick={() => removeRow(i)}
                disabled={addressRows.length === 1 && !row.trim()}
                className="p-2 rounded-lg text-text-muted hover:text-danger hover:bg-danger/10 disabled:opacity-30"
                aria-label="Remove address"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addRow}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
          >
            <Plus className="w-3.5 h-3.5" /> Add another address
          </button>
          {addresses.length > 0 && (
            <p className="text-xs text-text-muted">{addresses.length} unique address{addresses.length === 1 ? '' : 'es'} · {amount && parseFloat(amount) > 0 ? `${parseFloat(amount).toString()} each` : 'set an amount'}</p>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="text-xs font-semibold text-text-primary">Attribute to user ID (optional)
            <input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="user cuid" className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm font-mono" />
          </label>
          <label className="text-xs font-semibold text-text-primary">Note (optional)
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="KOL giveaway #3" className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm" />
          </label>
        </div>

        <Button size="sm" variant="primary" onClick={send} disabled={sending}>
          {sending ? 'Sending…' : addresses.length > 1 ? `Send Free Gas to ${addresses.length} addresses` : 'Send Free Gas'}
        </Button>

        {results && results.length > 0 && (
          <div className="mt-2 space-y-1.5">
            {results.map((r, i) => (
              <div key={i} className="flex items-start justify-between gap-3 text-xs rounded-lg border border-border bg-surface-alt px-3 py-2">
                <span className="font-mono break-all flex-1">{r.address}</span>
                {r.ok ? (
                  <button onClick={() => r.orderRef && router.push(`/admin/gas/orders/${r.orderRef}`)} className="shrink-0 text-green-700 dark:text-green-300 font-semibold underline">{r.orderRef}</button>
                ) : (
                  <span className="shrink-0 text-red-600 dark:text-red-400">{r.error}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Send history — past free-grant deliveries, click an entry to open the order */}
      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <button
          type="button"
          onClick={() => setShowHistory((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-alt transition-colors"
          aria-expanded={showHistory}
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <History className="w-4 h-4 text-text-muted" />
            Send history
            <span className="text-xs text-text-muted">({history.length})</span>
          </span>
          <ChevronDown className={`w-4 h-4 text-text-muted transition-transform ${showHistory ? 'rotate-180' : ''}`} />
        </button>
        {showHistory && (
          <div className="border-t border-border">
            {history.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-text-muted">No free gas has been sent yet.</p>
            ) : (
              <div className="divide-y divide-border">
                {history.map((o) => (
                  <button
                    key={o.id}
                    onClick={() => router.push(`/admin/gas/orders/${o.orderRef}`)}
                    className="w-full text-left px-4 py-2.5 hover:bg-surface-alt transition-colors flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-text-primary truncate">{o.toAddress}</p>
                      <p className="text-[11px] text-text-muted">{o.chain} · {String(o.gasAmountNative)} · {new Date(o.createdAt).toLocaleString()}</p>
                    </div>
                    <span className={`shrink-0 text-[11px] font-semibold capitalize ${statusColor(o.status)}`}>{o.status.replace(/_/g, ' ')}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
