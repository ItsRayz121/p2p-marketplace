'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ctmApi } from '@/lib/api'
import { EntityLogo } from '@/components/ui/EntityLogo'

interface CtmStats {
  trades: { total: number; completed: number; active: number; disputed: number; expired: number }
  listings: { active: number }
  merchants: { active: number; pendingApproval: number; byTier: Record<string, number> }
  totalVolumePkr: string
  openDisputes: number
  topTokens: Array<{ id: string; name: string; symbol: string; logoUrl?: string; totalTrades: number; totalVolumePkr: string }>
}

const TIER_COLORS: Record<string, string> = {
  new: 'bg-gray-100 text-gray-700',
  basic: 'bg-blue-100 text-blue-700',
  verified: 'bg-green-100 text-green-700',
  elite: 'bg-purple-100 text-purple-700',
}

function StatCard({ label, value, sub, accent }: { label: string; value: string | number; sub?: string; accent?: string }) {
  return (
    <div className="bg-surface shadow-card border border-border rounded-xl p-4">
      <p className="text-xs text-text-muted mb-1">{label}</p>
      <p className={`text-2xl font-bold ${accent ?? 'text-text-primary'}`}>{value}</p>
      {sub && <p className="text-xs text-text-muted mt-0.5">{sub}</p>}
    </div>
  )
}

export default function AdminCtmDashboardPage() {
  const [stats, setStats] = useState<CtmStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ctmApi.adminGetCtmStats()
      .then((d) => setStats(d as CtmStats))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-text-primary">CTM Overview</h1>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => <div key={i} className="bg-surface shadow-card border border-border rounded-xl h-20 animate-pulse" />)}
        </div>
      </div>
    )
  }

  if (!stats) return <div className="text-center py-16 text-text-muted">Failed to load stats.</div>

  const completionRate = stats.trades.total > 0
    ? ((stats.trades.completed / stats.trades.total) * 100).toFixed(1)
    : '0'

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text-primary">CTM Overview</h1>
        <div className="flex gap-2">
          <Link href="/admin/ctm/merchants" className="text-sm border border-border px-3 py-1.5 rounded-lg hover:bg-surface">Merchants</Link>
          <Link href="/admin/ctm/trades" className="text-sm border border-border px-3 py-1.5 rounded-lg hover:bg-surface">Trades</Link>
          <Link href="/admin/ctm/disputes" className="text-sm border border-border px-3 py-1.5 rounded-lg hover:bg-surface">Disputes</Link>
        </div>
      </div>

      {/* Trade stats */}
      <div>
        <h2 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-3">Trades</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <StatCard label="Total Trades" value={stats.trades.total.toLocaleString()} />
          <StatCard label="Completed" value={stats.trades.completed.toLocaleString()} accent="text-green-600" sub={`${completionRate}% completion`} />
          <StatCard label="Active Now" value={stats.trades.active.toLocaleString()} accent="text-blue-600" />
          <StatCard label="Disputed" value={stats.trades.disputed.toLocaleString()} accent={stats.trades.disputed > 0 ? 'text-red-600' : undefined} />
          <StatCard label="Expired" value={stats.trades.expired.toLocaleString()} />
        </div>
      </div>

      {/* Volume + listings */}
      <div>
        <h2 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-3">Market</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <StatCard label="Total Volume (PKR)" value={`PKR ${Number(stats.totalVolumePkr).toLocaleString()}`} />
          <StatCard label="Active Listings" value={stats.listings.active.toLocaleString()} />
          <StatCard label="Open Disputes" value={stats.openDisputes} accent={stats.openDisputes > 0 ? 'text-red-600' : undefined} />
        </div>
      </div>

      {/* Merchants */}
      <div>
        <h2 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-3">Merchants</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard label="Active Merchants" value={stats.merchants.active.toLocaleString()} />
          <StatCard label="Pending Approval" value={stats.merchants.pendingApproval.toLocaleString()} accent={stats.merchants.pendingApproval > 0 ? 'text-yellow-600' : undefined} />
          {Object.entries(stats.merchants.byTier).map(([tier, count]) => (
            <div key={tier} className="bg-surface shadow-card border border-border rounded-xl p-4">
              <p className="text-xs text-text-muted mb-1">Tier</p>
              <div className="flex items-center gap-2">
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${TIER_COLORS[tier] ?? 'bg-gray-100 text-gray-700'}`}>{tier}</span>
                <span className="text-xl font-bold text-text-primary">{count}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Top tokens */}
      {(stats.topTokens ?? []).length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-3">Top Tokens by Volume</h2>
          <div className="bg-surface shadow-card border border-border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 text-text-muted font-medium">Token</th>
                  <th className="text-right px-4 py-3 text-text-muted font-medium">Trades</th>
                  <th className="text-right px-4 py-3 text-text-muted font-medium">Volume (PKR)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(stats.topTokens ?? []).map((t) => (
                  <tr key={t.id} className="hover:bg-surface/50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <EntityLogo type="token" slug={t.symbol} size="sm" logoUrl={t.logoUrl} />
                        <span className="font-medium text-text-primary">{t.name}</span>
                        <span className="text-text-muted text-xs">{t.symbol}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-text-primary">{t.totalTrades.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right font-medium text-text-primary">PKR {Number(t.totalVolumePkr).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Quick action links */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { href: '/admin/ctm/tokens', label: 'Manage Tokens' },
          { href: '/admin/ctm/tokens/queue', label: 'Token Queue' },
          { href: '/admin/ctm/merchants', label: 'Merchant Queue' },
          { href: '/admin/ctm/proofs', label: 'Proof Review' },
        ].map((item) => (
          <Link key={item.href} href={item.href} className="bg-surface shadow-card border border-border rounded-xl p-4 text-center text-sm font-medium text-text-primary hover:shadow-sm hover:border-primary/30 transition-all">
            {item.label}
          </Link>
        ))}
      </div>
    </div>
  )
}
