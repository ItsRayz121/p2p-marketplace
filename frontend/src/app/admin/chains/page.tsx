'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { adminApi, type AdminDepositChain } from '@/lib/api'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'

// ── Verification badge ────────────────────────────────────────────────────────

function VerifiedBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${
      ok ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'
    }`}>
      {ok ? '✓' : '–'} {label}
    </span>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function DepositChainsPage() {
  const router = useRouter()
  const [chains, setChains] = useState<AdminDepositChain[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)

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
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
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
