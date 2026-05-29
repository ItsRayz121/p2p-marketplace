'use client'
import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { adminApi, type AdminDepositToken, type TokenLookupResult } from '@/lib/api'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'

// ── Verification badge ────────────────────────────────────────────────────────

function VerBadge({ ok, label, error }: { ok: boolean; label: string; error?: string | null }) {
  return (
    <span
      title={error ?? undefined}
      className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium cursor-default ${
        ok ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'
      }`}
    >
      {ok ? '✓' : '–'} {label}
    </span>
  )
}

// ── Lookup result display ─────────────────────────────────────────────────────

function LookupDisplay({ result }: { result: TokenLookupResult }) {
  return (
    <div className="border border-slate-200 rounded-lg p-4 space-y-3 bg-slate-50">
      <div className="flex items-center gap-2 flex-wrap">
        <VerBadge ok={result.coingeckoVerified} label="CoinGecko" error={result.coingeckoError} />
        <VerBadge ok={result.onChainVerified} label="On-chain" error={result.onChainError} />
        <VerBadge ok={result.trustWalletVerified} label="TrustWallet" error={result.trustWalletError} />
      </div>
      {result.address && (
        <div className="text-xs font-mono text-slate-600 break-all">
          <span className="font-semibold">Address:</span> {result.address}
        </div>
      )}
      {result.decimals != null && (
        <div className="text-xs text-slate-600">
          <span className="font-semibold">Decimals:</span> {result.decimals}
        </div>
      )}
      {result.onChainError && (
        <div className="text-xs text-red-600">⚠ On-chain: {result.onChainError}</div>
      )}
      {result.coingeckoError && (
        <div className="text-xs text-amber-600">⚠ CoinGecko: {result.coingeckoError}</div>
      )}
      {result.trustWalletError && (
        <div className="text-xs text-slate-400">ℹ TrustWallet: {result.trustWalletError}</div>
      )}
    </div>
  )
}

// ── Add token form ────────────────────────────────────────────────────────────

interface AddTokenFormProps {
  slug: string
  onSuccess: () => void
}

function AddTokenForm({ slug, onSuccess }: AddTokenFormProps) {
  const [symbol,   setSymbol]   = useState('')
  const [address,  setAddress]  = useState('')
  const [decimals, setDecimals] = useState('')
  const [looking,  setLooking]  = useState(false)
  const [saving,   setSaving]   = useState(false)
  const [lookup,   setLookup]   = useState<TokenLookupResult | null>(null)
  const [lookupErr, setLookupErr] = useState<string | null>(null)
  const [saveErr,   setSaveErr]   = useState<string | null>(null)

  async function handleLookup() {
    if (!symbol.trim()) return
    setLooking(true)
    setLookup(null)
    setLookupErr(null)
    try {
      const result = await adminApi.lookupDepositToken(symbol.trim(), slug)
      setLookup(result)
      if (result.address) setAddress(result.address)
      if (result.decimals != null) setDecimals(String(result.decimals))
    } catch (e) {
      setLookupErr(e instanceof Error ? e.message : 'Lookup failed')
    } finally {
      setLooking(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!symbol || !decimals) return
    if (!lookup?.onChainVerified && address) {
      setSaveErr('On-chain verification must pass before adding a token with a contract address.')
      return
    }
    setSaving(true)
    setSaveErr(null)
    try {
      await adminApi.createDepositToken(slug, {
        symbol: symbol.toUpperCase(),
        address: address || null,
        decimals: parseInt(decimals, 10),
        coingeckoId: lookup ? (lookup.symbol ? undefined : undefined) : undefined,
        onChainVerified: lookup?.onChainVerified ?? false,
        trustWalletVerified: lookup?.trustWalletVerified ?? false,
      })
      setSymbol('')
      setAddress('')
      setDecimals('')
      setLookup(null)
      onSuccess()
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : 'Failed to add token')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-surface shadow-card border border-border rounded-xl p-6 space-y-4">
      <h3 className="font-semibold text-slate-800">Add Token</h3>

      <div className="flex gap-2">
        <div className="flex-1">
          <label className="block text-xs font-medium text-slate-600 mb-1">Symbol *</label>
          <Input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="USDT"
            required
          />
        </div>
        <div className="flex items-end">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!symbol || looking}
            onClick={handleLookup}
          >
            {looking ? 'Looking up…' : '🔍 Lookup from CoinGecko'}
          </Button>
        </div>
      </div>

      {lookup && <LookupDisplay result={lookup} />}
      {lookupErr && <p className="text-xs text-red-600">{lookupErr}</p>}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            Contract Address
            <span className="text-slate-400 font-normal ml-1">(auto-filled by lookup)</span>
          </label>
          <Input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="0x…"
            className="font-mono text-xs"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            Decimals *
            <span className="text-slate-400 font-normal ml-1">(auto-filled by lookup)</span>
          </label>
          <Input
            type="number"
            value={decimals}
            onChange={(e) => setDecimals(e.target.value)}
            placeholder="6"
            required
            min={0}
            max={36}
          />
        </div>
      </div>

      {saveErr && <p className="text-xs text-red-600">{saveErr}</p>}

      {address && !lookup?.onChainVerified && (
        <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          ⚠ On-chain verification has not passed. Use the Lookup button to verify the contract before saving.
        </p>
      )}

      <Button
        type="submit"
        disabled={saving || !symbol || !decimals || (!!address && !lookup?.onChainVerified)}
        className="w-full"
      >
        {saving ? 'Adding…' : 'Add Token'}
      </Button>
    </form>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ChainTokensPage() {
  const params  = useParams()
  const router  = useRouter()
  const slug    = params.slug as string

  const [tokens, setTokens]   = useState<AdminDepositToken[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await adminApi.getDepositTokens(slug)
      setTokens(data.tokens ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load tokens')
    } finally {
      setLoading(false)
    }
  }, [slug])

  useEffect(() => { void load() }, [load])

  async function toggleActive(token: AdminDepositToken) {
    setToggling(token.id)
    try {
      await adminApi.updateDepositToken(slug, token.id, { isActive: !token.isActive })
      await load()
    } finally {
      setToggling(null)
    }
  }

  if (loading) return <LoadingState message="Loading tokens…" />
  if (error)   return <ErrorState title="Failed to load tokens" description={error} onRetry={load} />

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.push('/admin/chains')}
          className="text-slate-400 hover:text-slate-600 transition-colors"
        >
          ← Deposit Chains
        </button>
        <h1 className="text-2xl font-bold text-slate-900">
          Tokens — <span className="font-mono text-slate-600">{slug}</span>
        </h1>
      </div>

      {/* Token table */}
      <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-slate-600">Symbol</th>
              <th className="px-4 py-3 text-left font-medium text-slate-600">Contract Address</th>
              <th className="px-4 py-3 text-center font-medium text-slate-600">Decimals</th>
              <th className="px-4 py-3 text-left font-medium text-slate-600">Verification</th>
              <th className="px-4 py-3 text-center font-medium text-slate-600">Status</th>
              <th className="px-4 py-3 text-center font-medium text-slate-600">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {tokens.map((token) => (
              <tr key={token.id} className="hover:bg-slate-50 transition-colors">
                <td className="px-4 py-3 font-semibold text-slate-900">{token.symbol}</td>
                <td className="px-4 py-3 font-mono text-xs text-slate-500">
                  {token.address
                    ? <span title={token.address}>{token.address.slice(0, 10)}…{token.address.slice(-6)}</span>
                    : <span className="text-slate-300">native</span>
                  }
                </td>
                <td className="px-4 py-3 text-center text-slate-600">{token.decimals}</td>
                <td className="px-4 py-3">
                  <div className="flex gap-1 flex-wrap">
                    <VerBadge ok={token.onChainVerified} label="On-chain" />
                    <VerBadge ok={token.trustWalletVerified} label="TrustWallet" />
                  </div>
                </td>
                <td className="px-4 py-3 text-center">
                  <Badge variant={token.isActive ? 'success' : 'default'}>
                    {token.isActive ? 'Active' : 'Inactive'}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-center">
                  <Button
                    size="sm"
                    variant={token.isActive ? 'danger' : 'secondary'}
                    disabled={toggling === token.id}
                    onClick={() => toggleActive(token)}
                  >
                    {toggling === token.id ? '…' : token.isActive ? 'Disable' : 'Enable'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {tokens.length === 0 && (
          <div className="px-4 py-12 text-center text-slate-400">
            No tokens on this chain yet.
          </div>
        )}
      </div>

      {/* Add token form */}
      <AddTokenForm slug={slug} onSuccess={load} />
    </div>
  )
}
