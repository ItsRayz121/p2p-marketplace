'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { adminApi, type AdminDepositChain, type ChainSearchResult } from '@/lib/api'
import { CHAIN_META } from '@/lib/chainTokenStandards'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'

const FAMILIES = ['EVM', 'TRON', 'SOL', 'TON', 'SUI', 'BTC'] as const
type Family = typeof FAMILIES[number]

const ADDRESS_TYPE_FOR_FAMILY: Record<Family, string> = {
  EVM: 'EVM', TRON: 'TRC20', SOL: 'SOL', TON: 'TON', SUI: 'SUI', BTC: 'BTC_BECH32',
}

// Maps deposit chain family → gas chain category (used when "Also add to Gas" is checked)
const FAMILY_TO_GAS_CATEGORY: Record<Family, string> = {
  EVM: 'ethereum', TRON: 'tron', SOL: 'solana', TON: 'ton', SUI: 'sui', BTC: 'bitcoin',
}

// ── Add Chain Form ─────────────────────────────────────────────────────────────

function AddChainPanel({ onSuccess, onCancel }: { onSuccess: () => void; onCancel: () => void }) {
  const [query,         setQuery]         = useState('')
  const [results,       setResults]       = useState<ChainSearchResult[]>([])
  const [searching,     setSearching]     = useState(false)
  const [selected,      setSelected]      = useState<ChainSearchResult | null>(null)
  const [showDropdown,  setShowDropdown]  = useState(false)

  const [name,          setName]          = useState('')
  const [slug,          setSlug]          = useState('')
  const [family,        setFamily]        = useState<Family>('EVM')
  const [nativeSymbol,  setNativeSymbol]  = useState('')
  const [networkLabel,  setNetworkLabel]  = useState('')
  const [minConf,       setMinConf]       = useState('12')
  const [explorerBase,  setExplorerBase]  = useState('')
  const [rpcEnvVar,     setRpcEnvVar]     = useState('')
  const [addToGas,      setAddToGas]      = useState(true)

  const [submitting,    setSubmitting]    = useState(false)
  const [error,         setError]         = useState<string | null>(null)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function applyResult(r: ChainSearchResult) {
    setSelected(r)
    setQuery(r.name)
    setShowDropdown(false)
    setName(r.name)
    setSlug(r.slug)
    setNativeSymbol(r.nativeSymbol)
    setNetworkLabel(r.networkLabel)
    setExplorerBase(r.explorerBase ?? '')
    if (r.publicRpc) setRpcEnvVar('')
  }

  function handleQueryChange(v: string) {
    setQuery(v)
    setSelected(null)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (v.trim().length < 2) { setResults([]); setShowDropdown(false); return }
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const data = await adminApi.searchChains(v.trim())
        setResults(data.chains)
        setShowDropdown(data.chains.length > 0)
      } catch { setResults([]) }
      finally { setSearching(false) }
    }, 350)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!name || !slug || !nativeSymbol || !networkLabel || !explorerBase) {
      setError('Name, slug, native symbol, network label, and explorer URL are required.')
      return
    }
    setSubmitting(true)
    try {
      await adminApi.createDepositChain({
        slug, name, family, nativeSymbol, networkLabel,
        minConfirmations: parseInt(minConf, 10) || 12,
        explorerBase,
        rpcEnvVar: rpcEnvVar || undefined,
        isActive: true,
      } as Parameters<typeof adminApi.createDepositChain>[0])

      if (addToGas) {
        const gasCategory = FAMILY_TO_GAS_CATEGORY[family]
        // Prefer CHAIN_META networkLabel if available (e.g. 'ERC20' for ethereum), else use form value
        const gasNetworkLabel = CHAIN_META[gasCategory]?.networkLabel || networkLabel
        // Strip any trailing /tx/ path that may have come from chainid.network auto-fill
        const gasExplorerBase = explorerBase.replace(/\/tx\/?$/, '').replace(/\/$/, '') || null
        await adminApi.createGasChain({
          name,
          slug:            slug.toUpperCase(),
          symbol:          nativeSymbol,
          category:        gasCategory,
          networkLabel:    gasNetworkLabel,
          addressType:     ADDRESS_TYPE_FOR_FAMILY[family],
          explorerBase:    gasExplorerBase,
          backendChainId:  null,
          isActive:        false,
          readinessState:  'inactive',
          displayOrder:    999,
          platformFeeUsdt: 0.25,
        })
      }

      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create chain')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="bg-surface shadow-card rounded-xl border border-border p-6 space-y-5">
      <h2 className="text-lg font-semibold text-slate-900">Add New Blockchain</h2>

      {/* Chain search */}
      <div className="relative">
        <label className="block text-sm font-medium text-slate-700 mb-1">Search chain (EVM auto-lookup)</label>
        <input
          type="text"
          value={query}
          onChange={e => handleQueryChange(e.target.value)}
          onFocus={() => results.length > 0 && setShowDropdown(true)}
          placeholder="e.g. ZetaChain, Linea, Scroll…"
          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {searching && (
          <span className="absolute right-3 top-9 text-xs text-slate-400">Searching…</span>
        )}
        {showDropdown && (
          <ul className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-56 overflow-auto text-sm">
            {results.map(r => (
              <li
                key={r.chainId}
                onMouseDown={() => applyResult(r)}
                className="px-3 py-2 cursor-pointer hover:bg-blue-50 flex items-center justify-between"
              >
                <span className="font-medium">{r.name}</span>
                <span className="text-xs text-slate-400">chainId {r.chainId} · {r.nativeSymbol}</span>
              </li>
            ))}
          </ul>
        )}
        {selected && (
          <p className="mt-1 text-xs text-emerald-600">✓ Auto-filled from chainid.network — review fields below</p>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Name *</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="ZetaChain" required
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Slug * <span className="text-slate-400 font-normal">(lowercase, no spaces)</span></label>
            <input value={slug} onChange={e => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} placeholder="zeta" required
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Family *</label>
            <select value={family} onChange={e => setFamily(e.target.value as Family)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              {FAMILIES.map(f => <option key={f}>{f}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Native Symbol *</label>
            <input value={nativeSymbol} onChange={e => setNativeSymbol(e.target.value.toUpperCase())} placeholder="ZETA" required
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Network Label * <span className="text-slate-400 font-normal">(shown in UI)</span></label>
            <input value={networkLabel} onChange={e => setNetworkLabel(e.target.value.toUpperCase())} placeholder="ZETA" required
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Min Confirmations *</label>
            <input type="number" min={1} value={minConf} onChange={e => setMinConf(e.target.value)} required
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Explorer Base URL * <span className="text-slate-400 font-normal">(no trailing slash — system appends /tx/hash)</span></label>
          <input value={explorerBase} onChange={e => setExplorerBase(e.target.value)} placeholder="https://explorer.zetachain.com" required
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">RPC Env Var <span className="text-slate-400 font-normal">(optional — e.g. ZETA_RPC_URL)</span></label>
          <input value={rpcEnvVar} onChange={e => setRpcEnvVar(e.target.value)} placeholder="ZETA_RPC_URL"
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>

        <label className="flex items-center gap-3 cursor-pointer select-none">
          <input type="checkbox" checked={addToGas} onChange={e => setAddToGas(e.target.checked)}
            className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
          <div>
            <span className="text-sm font-medium text-slate-800">Also add to Gas section</span>
            <p className="text-xs text-slate-500">Creates an inactive Gas chain entry so you can configure it under Gas → Chains later.</p>
          </div>
        </label>

        {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

        <div className="flex gap-3 pt-1">
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Adding…' : 'Add Blockchain'}
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function DepositChainsPage() {
  const router = useRouter()
  const [chains,   setChains]   = useState<AdminDepositChain[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)
  const [adding,   setAdding]   = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await adminApi.getDepositChains()
      setChains(Array.isArray(data) ? data : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load chains')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function toggleActive(chain: AdminDepositChain) {
    setToggling(chain.slug)
    try {
      await adminApi.updateDepositChain(chain.slug, { isActive: !chain.isActive })
      await load()
    } finally {
      setToggling(null)
    }
  }

  if (loading) return <LoadingState message="Loading deposit chains…" />
  if (error)   return <ErrorState title="Failed to load chains" description={error} onRetry={load} />

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Deposit Chain Registry</h1>
          <p className="text-sm text-slate-500 mt-1">
            DB-backed deposit chain and token configuration. Changes take effect immediately via Redis cache invalidation.
          </p>
        </div>
        {!adding && (
          <Button onClick={() => setAdding(true)}>+ Add Blockchain</Button>
        )}
      </div>

      {adding && (
        <AddChainPanel
          onSuccess={() => { setAdding(false); void load() }}
          onCancel={() => setAdding(false)}
        />
      )}

      <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-slate-600">Chain</th>
              <th className="px-4 py-3 text-left font-medium text-slate-600">Family</th>
              <th className="px-4 py-3 text-left font-medium text-slate-600">Network Label</th>
              <th className="px-4 py-3 text-center font-medium text-slate-600">Tokens</th>
              <th className="px-4 py-3 text-center font-medium text-slate-600">Min Conf.</th>
              <th className="px-4 py-3 text-center font-medium text-slate-600">Status</th>
              <th className="px-4 py-3 text-center font-medium text-slate-600">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {chains.map((chain) => (
              <tr key={chain.slug} className="hover:bg-slate-50 transition-colors">
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-900">{chain.name}</div>
                  <div className="text-xs text-slate-400">{chain.slug}</div>
                </td>
                <td className="px-4 py-3">
                  <span className="text-xs font-mono bg-slate-100 px-2 py-0.5 rounded">{chain.family}</span>
                </td>
                <td className="px-4 py-3">
                  <span className="text-xs font-mono">{chain.networkLabel}</span>
                </td>
                <td className="px-4 py-3 text-center">
                  <button
                    onClick={() => router.push(`/admin/chains/${chain.slug}/tokens`)}
                    className="text-blue-600 hover:underline font-medium"
                  >
                    {chain.activeTokens} tokens
                  </button>
                </td>
                <td className="px-4 py-3 text-center text-slate-600">{chain.minConfirmations}</td>
                <td className="px-4 py-3 text-center">
                  <Badge variant={chain.isActive ? 'success' : 'default'}>
                    {chain.isActive ? 'Active' : 'Inactive'}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-center">
                  <div className="flex items-center justify-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => router.push(`/admin/chains/${chain.slug}/tokens`)}
                    >
                      Tokens
                    </Button>
                    <Button
                      size="sm"
                      variant={chain.isActive ? 'danger' : 'secondary'}
                      disabled={toggling === chain.slug}
                      onClick={() => toggleActive(chain)}
                    >
                      {toggling === chain.slug ? '…' : chain.isActive ? 'Disable' : 'Enable'}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {chains.length === 0 && (
          <div className="px-4 py-12 text-center text-slate-400">
            No deposit chains configured. Run the seed script to populate from the static config.
          </div>
        )}
      </div>
    </div>
  )
}
