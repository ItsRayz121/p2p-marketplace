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
        ok ? 'bg-emerald-100 text-emerald-700' : 'bg-surface-alt text-text-muted'
      }`}
    >
      {ok ? '✓' : '–'} {label}
    </span>
  )
}

// ── Lookup result display ─────────────────────────────────────────────────────

function LookupDisplay({ result }: { result: TokenLookupResult }) {
  const verifiedSource = result.coingeckoVerified ? 'CoinGecko'
    : result.trustWalletVerified ? 'TrustWallet'
    : result.onChainVerified ? 'On-chain' : null
  return (
    <div className="border border-border-subtle rounded-lg p-4 space-y-3 bg-surface-alt">
      {/* Token identity preview (name + logo) */}
      {(result.name || result.logoUrl) && (
        <div className="flex items-center gap-2">
          {result.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={result.logoUrl} alt={result.name ?? result.symbol} className="w-8 h-8 rounded-full border border-border-subtle bg-white" />
          )}
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text-primary truncate">{result.name ?? result.symbol}</p>
            <p className="text-xs text-text-muted">{result.symbol} · {result.chainName}</p>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <VerBadge ok={result.coingeckoVerified} label="CoinGecko" error={result.coingeckoError} />
        {result.onChainSupported && <VerBadge ok={result.onChainVerified} label="On-chain" error={result.onChainError} />}
        <VerBadge ok={result.trustWalletVerified} label="TrustWallet" error={result.trustWalletError} />
      </div>
      <div className="flex items-center gap-3 text-xs text-text-muted">
        {verifiedSource && <span className="text-emerald-700 font-medium">✓ Verified via {verifiedSource}</span>}
        <span>Last checked: {new Date(result.checkedAt).toLocaleString()}</span>
      </div>
      {result.address && (
        <div className="text-xs font-mono text-text-secondary break-all">
          <span className="font-semibold">Address:</span> {result.address}
        </div>
      )}
      {result.decimals != null && (
        <div className="text-xs text-text-secondary">
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
        <div className="text-xs text-text-muted">ℹ TrustWallet: {result.trustWalletError}</div>
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

  // For EVM chains we require on-chain verification of the contract; for non-EVM
  // chains (Solana/TON/SUI) on-chain verification isn't available, so a CoinGecko
  // or TrustWallet match is sufficient.
  const addressVerified = !address
    ? true
    : lookup?.onChainSupported
      ? !!lookup?.onChainVerified
      : !!(lookup?.coingeckoVerified || lookup?.trustWalletVerified)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!symbol || !decimals) return
    if (!addressVerified) {
      setSaveErr(lookup?.onChainSupported
        ? 'On-chain verification must pass before adding a token with a contract address.'
        : 'CoinGecko or TrustWallet must verify this token before adding it.')
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
      <h3 className="font-semibold text-text-primary">Add Token</h3>

      <div className="flex gap-2">
        <div className="flex-1">
          <label className="block text-xs font-medium text-text-secondary mb-1">Symbol *</label>
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
          <label className="block text-xs font-medium text-text-secondary mb-1">
            Contract Address
            <span className="text-text-muted font-normal ml-1">(auto-filled by lookup)</span>
          </label>
          <Input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="0x…"
            className="font-mono text-xs"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">
            Decimals *
            <span className="text-text-muted font-normal ml-1">(auto-filled by lookup)</span>
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

      {address && !addressVerified && (
        <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          ⚠ {lookup?.onChainSupported === false
            ? 'Not yet verified. Use Lookup so CoinGecko or TrustWallet can confirm this token before saving.'
            : 'On-chain verification has not passed. Use the Lookup button to verify the contract before saving.'}
        </p>
      )}

      <Button
        type="submit"
        disabled={saving || !symbol || !decimals || !addressVerified}
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
          className="text-text-muted hover:text-text-secondary transition-colors"
        >
          ← Deposit Chains
        </button>
        <h1 className="text-2xl font-bold text-text-primary">
          Tokens — <span className="font-mono text-text-secondary">{slug}</span>
        </h1>
      </div>

      {/* Token table */}
      <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-alt border-b border-border-subtle">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-text-secondary">Symbol</th>
              <th className="px-4 py-3 text-left font-medium text-text-secondary">Contract Address</th>
              <th className="px-4 py-3 text-center font-medium text-text-secondary">Decimals</th>
              <th className="px-4 py-3 text-left font-medium text-text-secondary">Verification</th>
              <th className="px-4 py-3 text-center font-medium text-text-secondary">Status</th>
              <th className="px-4 py-3 text-center font-medium text-text-secondary">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {tokens.map((token) => (
              <tr key={token.id} className="hover:bg-surface-alt transition-colors">
                <td className="px-4 py-3 font-semibold text-text-primary">{token.symbol}</td>
                <td className="px-4 py-3 font-mono text-xs text-text-muted">
                  {token.address
                    ? <span title={token.address}>{token.address.slice(0, 10)}…{token.address.slice(-6)}</span>
                    : <span className="text-text-muted">native</span>
                  }
                </td>
                <td className="px-4 py-3 text-center text-text-secondary">{token.decimals}</td>
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
          <div className="px-4 py-12 text-center text-text-muted">
            No tokens on this chain yet.
          </div>
        )}
      </div>

      {/* Add token form */}
      <AddTokenForm slug={slug} onSuccess={load} />
    </div>
  )
}
