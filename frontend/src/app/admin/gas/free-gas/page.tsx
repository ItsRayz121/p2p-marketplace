'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { gasApi, adminApi, type GasChain, type GasToken } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/Button'
import { ArrowLeft, Gift } from 'lucide-react'

// Admin-only tool to send a fully platform-funded (free) gas delivery to a specific
// user/address. The platform covers base + margin; the order routes through the normal
// delivery worker. Runs only when the gas_free_grant_enabled flag is ON (else the API
// rejects it). Curated for a small set of users.
export default function AdminFreeGasPage() {
  const router = useRouter()
  const isSuperAdmin = useAuthStore((s) => s.user?.role === 'super_admin')

  const [chains, setChains] = useState<GasChain[]>([])
  const [selChain, setSelChain] = useState<GasChain | null>(null)
  const [tokens, setTokens] = useState<GasToken[]>([])
  const [tokenId, setTokenId] = useState('')
  const [amount, setAmount] = useState('')
  const [toAddress, setToAddress] = useState('')
  const [userId, setUserId] = useState('')
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [last, setLast] = useState<{ orderRef: string; fullCoverUsdt: string } | null>(null)

  useEffect(() => {
    gasApi.getChains().then(({ chains: c }) => setChains(c.filter((x) => x.isAvailable))).catch(() => {})
  }, [])

  const loadTokens = useCallback(async (chain: GasChain) => {
    setSelChain(chain); setTokens([]); setTokenId('')
    try {
      const r = await gasApi.getChainTokens(chain.slug)
      setTokens(r.tokens)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to load tokens')
    }
  }, [])

  async function send() {
    if (!tokenId || !(parseFloat(amount) > 0) || !toAddress.trim()) {
      toast.error('Token, amount and address are required'); return
    }
    if (!window.confirm(`Send a FREE gas delivery? The platform pays the full cost (base + margin). This sends real funds on-chain.`)) return
    setSending(true)
    try {
      const res = await adminApi.freeGasDeliver({
        tokenConfigId: tokenId,
        amount: parseFloat(amount),
        toAddress: toAddress.trim(),
        ...(userId.trim() ? { userId: userId.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      })
      setLast({ orderRef: res.orderRef, fullCoverUsdt: res.fullCoverUsdt })
      toast.success(`Free delivery ${res.orderRef} queued (covered $${res.fullCoverUsdt})`)
      setAmount(''); setToAddress(''); setUserId(''); setNote('')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to send free gas')
    } finally {
      setSending(false)
    }
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
            <p className="text-xs text-text-muted">Platform-funded free gas for a specific user. Requires <code>gas_free_grant_enabled</code> to be ON.</p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
        This sends <b>real funds on-chain</b> at the platform&apos;s expense (base + margin). Use only for the curated set of users you intend to sponsor.
      </div>

      <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
        <div>
          <p className="text-xs font-semibold text-text-primary mb-1.5">Chain</p>
          <div className="flex flex-wrap gap-2">
            {chains.map((c) => (
              <button key={c.id} onClick={() => loadTokens(c)}
                className={`px-3 py-1.5 rounded-lg border text-sm ${selChain?.id === c.id ? 'border-primary bg-primary/10 text-primary font-semibold' : 'border-border bg-surface-alt'}`}>
                {c.name}
              </button>
            ))}
          </div>
        </div>

        {selChain && (
          <label className="block text-xs font-semibold text-text-primary">Token
            <select value={tokenId} onChange={(e) => setTokenId(e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm">
              <option value="">Select token…</option>
              {tokens.map((t) => <option key={t.id} value={t.id}>{t.symbol} — {t.name} (fee ${t.platformFeeUsdt})</option>)}
            </select>
          </label>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="text-xs font-semibold text-text-primary">Amount (native)
            <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.5" inputMode="decimal" className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm" />
          </label>
          <label className="text-xs font-semibold text-text-primary">Recipient address
            <input value={toAddress} onChange={(e) => setToAddress(e.target.value)} placeholder="0x… / T… / 0x…(Aptos)" className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm font-mono" />
          </label>
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
          {sending ? 'Sending…' : 'Send Free Gas'}
        </Button>

        {last && (
          <p className="text-xs text-green-700 dark:text-green-300">
            Queued {last.orderRef} — platform covered ${last.fullCoverUsdt}. Track it on the <button onClick={() => router.push(`/admin/gas/orders/${last.orderRef}`)} className="underline font-semibold">order page</button>.
          </p>
        )}
      </div>
    </div>
  )
}
