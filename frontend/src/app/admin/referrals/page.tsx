'use client'
import { useState, useCallback, useEffect } from 'react'
import { adminApi } from '@/lib/api'
import { fmtDate } from '@/lib/fmt'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Users } from 'lucide-react'

interface ReferredUser {
  id: string
  username: string
  email: string
  createdAt: string
  kycStatus: string
  kycLevel: number
  referralCode: string
  liveTradeCount: number
  referredBy?: { id: string; username: string; email: string }
  tradeStats?: { completedTrades: number; totalVolumePKR: string }
  _count: { referrals: number }
}

interface TopInviter {
  id: string
  username: string
  email: string
  kycStatus: string
  referralCode: string
  _count: { referrals: number }
}

interface ReferralChain {
  id: string; username: string; email: string; createdAt: string; kycStatus: string; referralCode: string
  referredBy?: { id: string; username: string; email: string; referredBy?: { id: string; username: string; email: string } }
  referrals: Array<{
    id: string; username: string; email: string; createdAt: string; kycStatus: string
    _count: { trades: number; sellTrades: number; ctmBuyTrades: number; ctmSellTrades: number }
    referrals: Array<{ id: string; username: string; email: string; createdAt: string }>
  }>
}

type Tab = 'referred' | 'inviters'

export default function ReferralsPage() {
  const [tab, setTab] = useState<Tab>('referred')
  const [referrals, setReferrals] = useState<ReferredUser[]>([])
  const [inviters, setInviters] = useState<TopInviter[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [chainUser, setChainUser] = useState<ReferralChain | null>(null)
  const [chainLoading, setChainLoading] = useState(false)
  const limit = 20

  const fetchReferrals = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, string | number> = { page, limit }
      if (search.trim()) params.search = search.trim()
      const data = await adminApi.getReferrals(params) as { referrals: ReferredUser[]; total: number }
      setReferrals(data.referrals ?? [])
      setTotal(data.total ?? 0)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load referrals')
    } finally {
      setLoading(false)
    }
  }, [page, search])

  const fetchInviters = useCallback(async () => {
    setLoading(true)
    try {
      const data = await adminApi.getTopInviters() as TopInviter[]
      setInviters(data ?? [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load inviters')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (tab === 'referred') fetchReferrals()
    else fetchInviters()
  }, [tab, fetchReferrals, fetchInviters])

  async function viewChain(userId: string) {
    setChainLoading(true)
    try {
      const data = await adminApi.getReferralChain(userId) as ReferralChain
      setChainUser(data)
    } finally {
      setChainLoading(false)
    }
  }

  const totalPages = Math.ceil(total / limit)

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Referrals</h1>
        <p className="text-text-muted text-sm mt-0.5">Track who invited whom and referral activity</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        {(['referred', 'inviters'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); setPage(1) }}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors border ${
              tab === t ? 'bg-primary text-white border-primary' : 'bg-white border-border text-text-secondary hover:bg-surface'
            }`}
          >
            {t === 'referred' ? 'Referred Users' : 'Top Inviters'}
          </button>
        ))}
      </div>

      {tab === 'referred' && (
        <div className="flex gap-3">
          <div className="w-64">
            <Input
              placeholder="Search username, email, referrer…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            />
          </div>
          {search && (
            <Button size="sm" variant="ghost" onClick={() => { setSearch(''); setPage(1) }}>Clear</Button>
          )}
        </div>
      )}

      {loading ? (
        <LoadingState message="Loading referrals…" />
      ) : error ? (
        <ErrorState title={error} onRetry={tab === 'referred' ? fetchReferrals : fetchInviters} />
      ) : tab === 'referred' ? (
        referrals.length === 0 ? (
          <EmptyState icon={Users} title="No referred users" description="No users have signed up via a referral link yet." />
        ) : (
          <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface border-b border-border">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-text-muted">Referred User</th>
                    <th className="text-left px-4 py-3 font-medium text-text-muted">Referred By</th>
                    <th className="text-left px-4 py-3 font-medium text-text-muted">Joined</th>
                    <th className="text-left px-4 py-3 font-medium text-text-muted">KYC</th>
                    <th className="text-left px-4 py-3 font-medium text-text-muted">Trades</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {referrals.map((u) => (
                    <tr key={u.id} className="hover:bg-surface/50 transition-colors">
                      <td className="px-4 py-3">
                        <p className="font-medium text-text-primary">{u.username}</p>
                        <p className="text-xs text-text-muted">{u.email}</p>
                      </td>
                      <td className="px-4 py-3">
                        {u.referredBy ? (
                          <>
                            <p className="text-text-primary">{u.referredBy.username}</p>
                            <p className="text-xs text-text-muted">{u.referredBy.email}</p>
                          </>
                        ) : <span className="text-text-muted">—</span>}
                      </td>
                      <td className="px-4 py-3 text-text-secondary">{fmtDate(u.createdAt)}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-medium ${u.kycStatus === 'approved' ? 'text-success' : u.kycStatus === 'rejected' ? 'text-danger' : 'text-warning'}`}>
                          {u.kycStatus} (L{u.kycLevel ?? 0})
                        </span>
                      </td>
                      <td className="px-4 py-3 text-text-secondary">{u.liveTradeCount}</td>
                      <td className="px-4 py-3 text-right">
                        <Button size="sm" variant="ghost" onClick={() => void viewChain(u.id)}>
                          Chain
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-border">
                <p className="text-text-muted text-sm">Page {page} of {totalPages} ({total} total)</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
                  <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
                </div>
              </div>
            )}
          </div>
        )
      ) : (
        inviters.length === 0 ? (
          <EmptyState icon={Users} title="No inviters yet" description="No users have referred others yet." />
        ) : (
          <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">#</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Inviter</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">KYC</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Referral Code</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Invited</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {inviters.map((u, i) => (
                  <tr key={u.id} className="hover:bg-surface/50 transition-colors">
                    <td className="px-4 py-3 text-text-muted font-medium">{i + 1}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-text-primary">{u.username}</p>
                      <p className="text-xs text-text-muted">{u.email}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-medium ${u.kycStatus === 'approved' ? 'text-success' : 'text-warning'}`}>{u.kycStatus}</span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-text-secondary">{u.referralCode}</td>
                    <td className="px-4 py-3 font-bold text-text-primary">{u._count.referrals}</td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => void viewChain(u.id)}>Chain</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* Referral chain modal */}
      <Modal isOpen={!!chainUser || chainLoading} onClose={() => setChainUser(null)} title="Referral Chain" size="lg">
        {chainLoading ? (
          <LoadingState message="Loading chain…" />
        ) : chainUser ? (
          <div className="space-y-4 text-sm">
            {/* Ancestor chain */}
            <div>
              <p className="text-text-muted font-medium mb-2">Chain (oldest ancestor → this user)</p>
              <div className="flex items-center gap-2 flex-wrap text-xs font-mono">
                {chainUser.referredBy?.referredBy && (
                  <>
                    <span className="bg-surface border border-border rounded px-2 py-1">{chainUser.referredBy.referredBy.username}</span>
                    <span className="text-text-muted">→</span>
                  </>
                )}
                {chainUser.referredBy && (
                  <>
                    <span className="bg-surface border border-border rounded px-2 py-1">{chainUser.referredBy.username}</span>
                    <span className="text-text-muted">→</span>
                  </>
                )}
                <span className="bg-primary/10 text-primary border border-primary/20 rounded px-2 py-1 font-bold">{chainUser.username}</span>
              </div>
            </div>

            {/* Their referrals */}
            {chainUser.referrals.length > 0 && (
              <div>
                <p className="text-text-muted font-medium mb-2">Users invited by {chainUser.username} ({chainUser.referrals.length})</p>
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {chainUser.referrals.map((r) => {
                    const rtrades = (r._count.trades ?? 0) + (r._count.sellTrades ?? 0) + (r._count.ctmBuyTrades ?? 0) + (r._count.ctmSellTrades ?? 0)
                    return (
                      <div key={r.id} className="border border-border rounded-lg p-3">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="font-medium text-text-primary">{r.username}</p>
                            <p className="text-xs text-text-muted">{r.email} · Joined {fmtDate(r.createdAt)} · KYC: {r.kycStatus}</p>
                          </div>
                          <div className="text-right text-xs">
                            <p className="text-text-primary font-medium">{rtrades} trades</p>
                            {r.referrals.length > 0 && <p className="text-text-muted">+{r.referrals.length} invited</p>}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
