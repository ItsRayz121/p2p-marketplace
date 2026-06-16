'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { adminApi, type AdminDepositChain, type ChainSearchResult, type RpcHealthSuggestion, type TokenIdentifyResult } from '@/lib/api'
import { CHAIN_META } from '@/lib/chainTokenStandards'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { EntityLogo } from '@/components/ui/EntityLogo'

const FAMILIES = ['EVM', 'TRON', 'SOL', 'TON', 'SUI', 'BTC', 'APT'] as const
type Family = typeof FAMILIES[number]

interface ChainTemplate {
  label: string
  name: string
  slug: string
  family: Family
  nativeSymbol: string
  networkLabel: string
  minConf: number
  explorerBase: string
  rpcEnvVar: string
}

const NON_EVM_TEMPLATES: ChainTemplate[] = [
  { label: 'Solana', name: 'Solana', slug: 'solana', family: 'SOL', nativeSymbol: 'SOL', networkLabel: 'SOL', minConf: 32, explorerBase: 'https://solscan.io/tx', rpcEnvVar: 'SOL_RPC_URL' },
  { label: 'TON', name: 'TON', slug: 'ton', family: 'TON', nativeSymbol: 'TON', networkLabel: 'TON', minConf: 1, explorerBase: 'https://tonscan.org/tx', rpcEnvVar: 'TON_RPC_URL' },
  { label: 'SUI', name: 'SUI', slug: 'sui', family: 'SUI', nativeSymbol: 'SUI', networkLabel: 'SUI', minConf: 1, explorerBase: 'https://suiexplorer.com/txblock', rpcEnvVar: 'SUI_RPC_URL' },
  { label: 'TRON', name: 'TRON', slug: 'tron', family: 'TRON', nativeSymbol: 'TRX', networkLabel: 'TRC20', minConf: 20, explorerBase: 'https://tronscan.org/#/transaction', rpcEnvVar: 'TRON_RPC_URL' },
  { label: 'Aptos', name: 'Aptos', slug: 'aptos', family: 'APT', nativeSymbol: 'APT', networkLabel: 'APT', minConf: 1, explorerBase: 'https://explorer.aptoslabs.com/txn', rpcEnvVar: 'APT_RPC_URL' },
  { label: 'Bitcoin', name: 'Bitcoin', slug: 'bitcoin', family: 'BTC', nativeSymbol: 'BTC', networkLabel: 'Bitcoin', minConf: 3, explorerBase: 'https://mempool.space/tx', rpcEnvVar: 'BTC_RPC_URL' },
]

const ADDRESS_TYPE_FOR_FAMILY: Record<Family, string> = {
  EVM: 'EVM', TRON: 'TRC20', SOL: 'SOL', TON: 'TON', SUI: 'SUI', BTC: 'BTC_BECH32', APT: 'APT',
}

// Maps deposit chain family → gas chain category (used when "Also add to Gas" is checked)
const FAMILY_TO_GAS_CATEGORY: Record<Family, string> = {
  EVM: 'ethereum', TRON: 'tron', SOL: 'solana', TON: 'ton', SUI: 'sui', BTC: 'bitcoin', APT: 'aptos',
}

// ── Token Identifier ────────────────────────────────────────────────────────────
// Answers "is this its own chain, or a token on an existing chain?" before you add
// anything — so projects that brand themselves as a "network" (but are really an
// ERC-20, e.g. Billions Network) get filed under the right chain.

function TokenIdentifierPanel() {
  const router = useRouter()
  const [query,   setQuery]   = useState('')
  const [loading, setLoading] = useState(false)
  const [result,  setResult]  = useState<TokenIdentifyResult | null>(null)
  const [error,   setError]   = useState<string | null>(null)

  async function identify() {
    if (query.trim().length < 2) return
    setLoading(true)
    setResult(null)
    setError(null)
    try {
      setResult(await adminApi.identifyToken(query.trim()))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lookup failed')
    } finally {
      setLoading(false)
    }
  }

  function addUnder(slug: string, symbol: string, address: string, decimals: number | null) {
    const params = new URLSearchParams({ symbol, address, ...(decimals != null ? { decimals: String(decimals) } : {}) })
    router.push(`/admin/chains/${slug}/tokens?${params.toString()}`)
  }

  return (
    <div className="bg-surface shadow-card rounded-xl border border-border p-5 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Token Identifier</h2>
        <p className="text-sm text-text-muted">
          Check whether something is its own blockchain or a token on an existing chain — paste a symbol, name, or 0x contract.
        </p>
      </div>

      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void identify()}
          placeholder="e.g. BILL, Billions Network, or 0xb1110919…"
          className="flex-1 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <Button onClick={() => void identify()} disabled={loading || query.trim().length < 2}>
          {loading ? 'Checking…' : 'Identify'}
        </Button>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</p>}

      {result && !result.resolved && (
        <p className="text-sm text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
          {result.error ?? 'Could not resolve this token/chain.'}
        </p>
      )}

      {result && result.resolved && (
        <div className="space-y-3">
          <div className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border ${
            result.kind === 'token'        ? 'bg-blue-500/10 border-blue-500/30' :
            result.kind === 'native_chain' ? 'bg-purple-500/10 border-purple-500/30' :
                                             'bg-surface-alt border-border'
          }`}>
            {result.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={result.logoUrl} alt={result.name ?? ''} className="w-8 h-8 rounded-full border border-border-subtle bg-white flex-shrink-0" />
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-text-primary">{result.name}</span>
                <Badge variant={result.kind === 'token' ? 'default' : result.kind === 'native_chain' ? 'warning' : 'default'}>
                  {result.kind === 'token' ? 'TOKEN' : result.kind === 'native_chain' ? 'OWN CHAIN' : 'UNKNOWN'}
                </Badge>
              </div>
              <p className="text-sm text-text-secondary mt-0.5">{result.verdict}</p>
            </div>
          </div>

          {result.kind === 'token' && result.deployments && result.deployments.length > 0 && (
            <div className="border border-border-subtle rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface-alt border-b border-border-subtle">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-text-secondary">Chain</th>
                    <th className="px-3 py-2 text-left font-medium text-text-secondary">Contract</th>
                    <th className="px-3 py-2 text-center font-medium text-text-secondary">Decimals</th>
                    <th className="px-3 py-2 text-right font-medium text-text-secondary">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {result.deployments.map((d) => (
                    <tr key={d.platformId}>
                      <td className="px-3 py-2 font-medium text-text-primary">{d.chainName}</td>
                      <td className="px-3 py-2 font-mono text-xs text-text-muted" title={d.address}>
                        {d.address.slice(0, 10)}…{d.address.slice(-6)}
                      </td>
                      <td className="px-3 py-2 text-center text-text-secondary">{d.decimals ?? '—'}</td>
                      <td className="px-3 py-2 text-right">
                        {d.supported && d.mappedSlug ? (
                          <button
                            onClick={() => addUnder(d.mappedSlug!, result.symbol ?? '', d.address, d.decimals)}
                            className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                          >
                            Add under {d.chainName} →
                          </button>
                        ) : (
                          <span className="text-xs text-text-muted">Chain not in your registry</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          )}

          {result.kind === 'native_chain' && (
            <p className="text-xs text-text-muted">
              This is a real blockchain&apos;s native coin. Add it via <span className="font-medium">+ Add Blockchain</span> — and only if you&apos;ll operate deposits/delivery for it.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Add Chain Form ─────────────────────────────────────────────────────────────

function AddChainPanel({ onSuccess, onCancel }: { onSuccess: (warning?: string) => void; onCancel: () => void }) {
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
  const [rpcSuggestion, setRpcSuggestion] = useState<RpcHealthSuggestion | null>(null)
  const [rpcChecking,   setRpcChecking]   = useState(false)

  // Non-EVM chains can't be auto-discovered via chainid.network, so suggest a
  // recommended public RPC and probe the configured endpoint's live health.
  useEffect(() => {
    if (family === 'EVM' || family === 'BTC') { setRpcSuggestion(null); return }
    let cancelled = false
    setRpcChecking(true)
    setRpcSuggestion(null)
    adminApi.getRpcHealth(family)
      .then((d) => { if (!cancelled) setRpcSuggestion(d) })
      .catch(() => { if (!cancelled) setRpcSuggestion(null) })
      .finally(() => { if (!cancelled) setRpcChecking(false) })
    return () => { cancelled = true }
  }, [family])

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

  function applyTemplate(t: ChainTemplate) {
    setQuery(t.name)
    setSelected(null)
    setName(t.name)
    setSlug(t.slug)
    setFamily(t.family)
    setNativeSymbol(t.nativeSymbol)
    setNetworkLabel(t.networkLabel)
    setMinConf(String(t.minConf))
    setExplorerBase(t.explorerBase)
    setRpcEnvVar(t.rpcEnvVar)
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
    if (rpcEnvVar && !/^[A-Z][A-Z0-9_]*$/.test(rpcEnvVar)) {
      setError('RPC Env Var must be a variable NAME like APT_RPC_URL — not the URL itself. The URL goes in the server environment; leave this blank if unsure.')
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

      // The deposit chain is created at this point — a Gas-section failure below
      // must not abort the flow (retrying would hit DUPLICATE_CHAIN), so it only
      // downgrades to a warning.
      let warning: string | undefined
      if (addToGas) {
        const gasCategory = FAMILY_TO_GAS_CATEGORY[family]
        try {
          const { chains: gasChains } = await adminApi.getGasChains()
          const existingGas = gasChains.find((c) => c.category === gasCategory)
          if (existingGas) {
            warning = `Deposit chain created. Gas section already has "${existingGas.name}" (${existingGas.slug}) for this category — no duplicate was created.`
          } else {
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
        } catch (gasErr) {
          warning = `Deposit chain created, but adding it to the Gas section failed: ${gasErr instanceof Error ? gasErr.message : 'unknown error'}. Add it manually under Gas → Chains.`
        }
      }

      onSuccess(warning)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create chain')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="bg-surface shadow-card rounded-xl border border-border p-6 space-y-5">
      <h2 className="text-lg font-semibold text-text-primary">Add New Blockchain</h2>

      {/* Non-EVM quick templates */}
      <div>
        <p className="text-sm font-medium text-text-secondary mb-2">Quick templates <span className="text-text-muted font-normal">(click to pre-fill for non-EVM chains)</span></p>
        <div className="flex flex-wrap gap-2">
          {NON_EVM_TEMPLATES.map((t) => (
            <button
              key={t.slug}
              type="button"
              onClick={() => applyTemplate(t)}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-border hover:bg-blue-500/10 hover:border-blue-500/50 transition-colors"
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Chain search */}
      <div className="relative">
        <label className="block text-sm font-medium text-text-secondary mb-1">
          Search chain <span className="font-normal text-text-muted">(EVM auto-lookup — or use a quick template above / fill manually)</span>
        </label>
        <input
          type="text"
          value={query}
          onChange={e => handleQueryChange(e.target.value)}
          onFocus={() => results.length > 0 && setShowDropdown(true)}
          placeholder="e.g. ZetaChain, Linea — or type manually for SOL/TON/SUI"
          className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {searching && (
          <span className="absolute right-3 top-9 text-xs text-text-muted">Searching…</span>
        )}
        {showDropdown && (
          <ul className="absolute z-20 mt-1 w-full bg-surface border border-border rounded-lg shadow-lg max-h-56 overflow-auto text-sm">
            {results.map(r => (
              <li
                key={r.chainId}
                onMouseDown={() => applyResult(r)}
                className="px-3 py-2 cursor-pointer hover:bg-blue-500/10 flex items-center justify-between"
              >
                <span className="font-medium">{r.name}</span>
                <span className="text-xs text-text-muted">chainId {r.chainId} · {r.nativeSymbol}</span>
              </li>
            ))}
          </ul>
        )}
        {selected && (
          <p className="mt-1 text-xs text-emerald-600 dark:text-emerald-400">✓ Auto-filled from chainid.network — review fields below</p>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Name *</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="ZetaChain" required
              className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Slug * <span className="text-text-muted font-normal">(lowercase, no spaces)</span></label>
            <input value={slug} onChange={e => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} placeholder="zeta" required
              className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Family *</label>
            <select value={family} onChange={e => setFamily(e.target.value as Family)}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              {FAMILIES.map(f => <option key={f}>{f}</option>)}
            </select>
            {family !== 'EVM' && (
              <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">
                Non-EVM chain — auto-lookup is EVM-only. Fill all fields manually below.
                After creating, go to Gas → Chains to assign a Backend Chain ID and seed the hot wallet.
              </p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Native Symbol *</label>
            <input value={nativeSymbol} onChange={e => setNativeSymbol(e.target.value.toUpperCase())} placeholder="ZETA" required
              className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Network Label * <span className="text-text-muted font-normal">(shown in UI)</span></label>
            <input value={networkLabel} onChange={e => setNetworkLabel(e.target.value.toUpperCase())} placeholder="ZETA" required
              className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Min Confirmations *</label>
            <input type="number" min={1} value={minConf} onChange={e => setMinConf(e.target.value)} required
              className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1">Explorer Base URL * <span className="text-text-muted font-normal">(no trailing slash — system appends the tx hash, or /tx/hash if the URL has no tx path)</span></label>
          <input value={explorerBase} onChange={e => setExplorerBase(e.target.value)} placeholder="https://explorer.zetachain.com" required
            className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>

        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1">RPC Env Var <span className="text-text-muted font-normal">(optional — e.g. ZETA_RPC_URL)</span></label>
          <input value={rpcEnvVar} onChange={e => setRpcEnvVar(e.target.value)} placeholder="ZETA_RPC_URL"
            className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />

          {/* Recommended public RPC for non-EVM families + live health of the configured endpoint */}
          {(rpcChecking || rpcSuggestion) && (
            <div className="mt-2 rounded-lg border border-blue-500/30 bg-blue-500/10 p-3 text-xs space-y-2">
              {rpcChecking ? (
                <p className="text-blue-700 dark:text-blue-300">Checking recommended RPC + configured endpoint health…</p>
              ) : rpcSuggestion && (
                <>
                  {rpcSuggestion.recommended.length > 0 && (
                    <div className="space-y-1">
                      <p className="font-semibold text-blue-900 dark:text-blue-200">Recommended public RPC{rpcSuggestion.envVar ? ` — set ${rpcSuggestion.envVar} on the server` : ''}:</p>
                      {rpcSuggestion.recommended.map((r) => (
                        <div key={r.url} className="flex items-center gap-2">
                          <code className="font-mono text-[11px] text-blue-800 dark:text-blue-300 break-all">{r.url}</code>
                          <button type="button" onClick={() => navigator.clipboard.writeText(r.url)} className="text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap">Copy</button>
                          <span className="text-blue-500">— {r.label}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {rpcSuggestion.configuredHealth && (
                    <p className={rpcSuggestion.configuredHealth.reachable ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-600 dark:text-red-400'}>
                      Configured endpoint: {rpcSuggestion.configuredHealth.reachable
                        ? `✓ reachable (${rpcSuggestion.configuredHealth.latencyMs}ms)`
                        : `✗ unreachable${rpcSuggestion.configuredHealth.error ? ` — ${rpcSuggestion.configuredHealth.error}` : ''}`}
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <label className="flex items-center gap-3 cursor-pointer select-none">
          <input type="checkbox" checked={addToGas} onChange={e => setAddToGas(e.target.checked)}
            className="w-4 h-4 rounded border-border text-blue-600 dark:text-blue-400 focus:ring-blue-500" />
          <div>
            <span className="text-sm font-medium text-text-primary">Also add to Gas section</span>
            <p className="text-xs text-text-muted">Creates an inactive Gas chain entry so you can configure it under Gas → Chains later.</p>
          </div>
        </label>

        {error && <p className="text-sm text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</p>}

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
  const [warning,  setWarning]  = useState<string | null>(null)

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
          <h1 className="text-2xl font-bold text-text-primary">Deposit Chain Registry</h1>
          <p className="text-sm text-text-muted mt-1">
            DB-backed deposit chain and token configuration. Changes take effect immediately via Redis cache invalidation.
          </p>
        </div>
        {!adding && (
          <Button onClick={() => setAdding(true)}>+ Add Blockchain</Button>
        )}
      </div>

      {warning && (
        <div className="flex items-start justify-between gap-3 px-4 py-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-sm text-amber-800 dark:text-amber-300">
          <span>{warning}</span>
          <button onClick={() => setWarning(null)} className="shrink-0 font-medium hover:underline">Dismiss</button>
        </div>
      )}

      {!adding && <TokenIdentifierPanel />}

      {adding && (
        <AddChainPanel
          onSuccess={(w) => { setAdding(false); setWarning(w ?? null); void load() }}
          onCancel={() => setAdding(false)}
        />
      )}

      <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-alt border-b border-border-subtle">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-text-secondary">Chain</th>
              <th className="px-4 py-3 text-left font-medium text-text-secondary">Family</th>
              <th className="px-4 py-3 text-left font-medium text-text-secondary">Network Label</th>
              <th className="px-4 py-3 text-center font-medium text-text-secondary">Tokens</th>
              <th className="px-4 py-3 text-center font-medium text-text-secondary">Min Conf.</th>
              <th className="px-4 py-3 text-center font-medium text-text-secondary">Status</th>
              <th className="px-4 py-3 text-center font-medium text-text-secondary">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {chains.map((chain) => (
              <tr key={chain.slug} className="hover:bg-surface-alt transition-colors">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <EntityLogo type="chain" slug={chain.slug} size="sm" />
                    <div>
                      <div className="font-medium text-text-primary">{chain.name}</div>
                      <div className="text-xs text-text-muted">{chain.slug}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className="text-xs font-mono bg-surface-alt px-2 py-0.5 rounded">{chain.family}</span>
                </td>
                <td className="px-4 py-3">
                  <span className="text-xs font-mono">{chain.networkLabel}</span>
                </td>
                <td className="px-4 py-3 text-center">
                  <button
                    onClick={() => router.push(`/admin/chains/${chain.slug}/tokens`)}
                    className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                  >
                    {chain.activeTokens} tokens
                  </button>
                </td>
                <td className="px-4 py-3 text-center text-text-secondary">{chain.minConfirmations}</td>
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
        </div>
        {chains.length === 0 && (
          <div className="px-4 py-12 text-center text-text-muted">
            No deposit chains configured. Run the seed script to populate from the static config.
          </div>
        )}
      </div>
    </div>
  )
}
