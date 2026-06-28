'use client'
import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { adminApi } from '@/lib/api'
import { fmtDate } from '@/lib/fmt'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { ReferralBubbleMap, type GraphNode, type GraphEdge } from '@/components/admin/ReferralBubbleMap'
import { Users, AlertTriangle, Download, Share2 } from 'lucide-react'

interface ReferredUser {
  id: string
  username: string
  email: string
  createdAt: string
  kycStatus: string
  kycLevel: string
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

interface SuspiciousGroup {
  ip: string
  userIds: string[]
  usernames: string[]
  emails: string[]
  createdAts: string[]
  referredByIds: (string | null)[]
}

type Tab = 'referred' | 'inviters' | 'suspicious' | 'network'

// 2-letter ISO country code → flag emoji (regional indicator letters).
function flagEmoji(cc: string | null): string {
  if (!cc || cc.length !== 2) return '🏳️'
  const A = 0x1f1e6
  return String.fromCodePoint(A + (cc.toUpperCase().charCodeAt(0) - 65), A + (cc.toUpperCase().charCodeAt(1) - 65))
}

export default function ReferralsPage() {
  const router = useRouter()
  const [tab, setTab] = useState<Tab>('referred')
  const [referrals, setReferrals] = useState<ReferredUser[]>([])
  const [inviters, setInviters] = useState<TopInviter[]>([])
  const [suspicious, setSuspicious] = useState<SuspiciousGroup[]>([])
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([])
  const [graphEdges, setGraphEdges] = useState<GraphEdge[]>([])
  const [countries, setCountries] = useState<Array<{ country: string; countryCode: string | null; count: number }>>([])
  const [countryTotal, setCountryTotal] = useState(0)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [chainUser, setChainUser] = useState<ReferralChain | null>(null)
  const [chainLoading, setChainLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
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

  const fetchSuspicious = useCallback(async () => {
    setLoading(true)
    try {
      const data = await adminApi.getSuspiciousReferrals() as SuspiciousGroup[]
      setSuspicious(data ?? [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load suspicious patterns')
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchGraph = useCallback(async () => {
    setLoading(true)
    try {
      const [graph, byCountry] = await Promise.all([adminApi.getReferralGraph(), adminApi.getReferralsByCountry()])
      setGraphNodes(graph.nodes ?? [])
      setGraphEdges(graph.edges ?? [])
      setCountries(byCountry.countries ?? [])
      setCountryTotal(byCountry.total ?? 0)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load referral network')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (tab === 'referred') fetchReferrals()
    else if (tab === 'inviters') fetchInviters()
    else if (tab === 'network') fetchGraph()
    else fetchSuspicious()
  }, [tab, fetchReferrals, fetchInviters, fetchSuspicious, fetchGraph])

  async function viewChain(userId: string) {
    setChainLoading(true)
    try {
      const data = await adminApi.getReferralChain(userId) as ReferralChain
      setChainUser(data)
    } finally {
      setChainLoading(false)
    }
  }

  async function handleExportCsv() {
    setExporting(true)
    try {
      const blob = await adminApi.exportReferralsCsv()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'referrals.csv'
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      // silently fail — user will notice no download
    } finally {
      setExporting(false)
    }
  }

  const totalPages = Math.ceil(total / limit)

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Referrals</h1>
          <p className="text-text-muted text-sm mt-0.5">Track who invited whom and referral activity</p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void handleExportCsv()}
          disabled={exporting}
        >
          <Download className="w-4 h-4 mr-1.5" />
          {exporting ? 'Exporting…' : 'Export CSV'}
        </Button>
      </div>

      {/* Tabs */}
      <div className="admin-toolbar gap-2">
        {(['referred', 'inviters', 'network', 'suspicious'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); setPage(1) }}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors border flex items-center gap-1.5 ${
              tab === t ? 'bg-primary text-white border-primary' : 'bg-surface border-border text-text-secondary hover:bg-surface-alt'
            }`}
          >
            {t === 'suspicious' && <AlertTriangle className="w-3.5 h-3.5" />}
            {t === 'network' && <Share2 className="w-3.5 h-3.5" />}
            {t === 'referred' ? 'Referred Users' : t === 'inviters' ? 'Top Inviters' : t === 'network' ? 'Network Map' : 'Suspicious'}
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
        <ErrorState title={error} onRetry={tab === 'referred' ? fetchReferrals : tab === 'inviters' ? fetchInviters : fetchSuspicious} />
      ) : tab === 'network' ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <ReferralBubbleMap nodes={graphNodes} edges={graphEdges} onSelect={(id) => router.push(`/admin/users/${id}`)} />
          </div>
          {/* Country-wise breakdown (all users, by geo-IP country) */}
          <div className="bg-surface shadow-card rounded-xl border border-border p-4 h-fit">
            <div className="flex items-baseline justify-between mb-3">
              <h3 className="text-sm font-bold text-text-primary">Users by country</h3>
              <span className="text-xs text-text-muted">{countryTotal} total</span>
            </div>
            {countries.length === 0 ? (
              <p className="text-xs text-text-muted">No country data yet.</p>
            ) : (
              <div className="space-y-2 max-h-[520px] overflow-y-auto pr-1">
                {countries.map((c) => {
                  const pct = countryTotal > 0 ? Math.round((c.count / countryTotal) * 100) : 0
                  return (
                    <div key={`${c.countryCode}-${c.country}`}>
                      <div className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-2 text-text-primary">
                          <span className="text-base leading-none">{flagEmoji(c.countryCode)}</span>
                          {c.country}
                        </span>
                        <span className="text-text-muted text-xs">{c.count} · {pct}%</span>
                      </div>
                      <div className="mt-1 h-1.5 rounded-full bg-surface-alt overflow-hidden">
                        <div className="h-full bg-primary rounded-full" style={{ width: `${Math.max(2, pct)}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      ) : tab === 'referred' ? (
        referrals.length === 0 ? (
          <EmptyState icon={Users} title="No referred users" description="No users have signed up via a referral link yet." />
        ) : (
          <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm stack-sm">
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
                      <td className="px-4 py-3" data-label="Referred User">
                        <div className="min-w-0">
                          <Link href={`/admin/users/${u.id}`} className="font-medium text-text-primary hover:text-primary hover:underline">{u.username}</Link>
                          <p className="text-xs text-text-muted break-all">{u.email}</p>
                        </div>
                      </td>
                      <td className="px-4 py-3" data-label="Referred By">
                        {u.referredBy ? (
                          <div className="min-w-0">
                            <Link href={`/admin/users/${u.referredBy.id}`} className="text-primary hover:underline">{u.referredBy.username}</Link>
                            <p className="text-xs text-text-muted break-all">{u.referredBy.email}</p>
                          </div>
                        ) : <span className="text-text-muted">—</span>}
                      </td>
                      <td className="px-4 py-3 text-text-secondary" data-label="Joined">{fmtDate(u.createdAt)}</td>
                      <td className="px-4 py-3" data-label="KYC">
                        <span className={`text-xs font-medium ${u.kycStatus === 'approved' ? 'text-success' : u.kycStatus === 'rejected' ? 'text-danger' : 'text-warning'}`}>
                          {u.kycStatus} (L{u.kycLevel === 'enhanced' ? 2 : u.kycLevel === 'basic' ? 1 : 0})
                        </span>
                      </td>
                      <td className="px-4 py-3 text-text-secondary" data-label="Trades">{u.liveTradeCount}</td>
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
      ) : tab === 'inviters' ? (
        inviters.length === 0 ? (
          <EmptyState icon={Users} title="No inviters yet" description="No users have referred others yet." />
        ) : (
          <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full text-sm stack-sm">
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
                    <td className="px-4 py-3 text-text-muted font-medium" data-label="#">{i + 1}</td>
                    <td className="px-4 py-3" data-label="Inviter">
                      <div className="min-w-0">
                        <Link href={`/admin/users/${u.id}`} className="font-medium text-text-primary hover:text-primary hover:underline">{u.username}</Link>
                        <p className="text-xs text-text-muted break-all">{u.email}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3" data-label="KYC">
                      <span className={`text-xs font-medium ${u.kycStatus === 'approved' ? 'text-success' : 'text-warning'}`}>{u.kycStatus}</span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-text-secondary" data-label="Referral Code">{u.referralCode}</td>
                    <td className="px-4 py-3" data-label="Invited">
                      <button onClick={() => void viewChain(u.id)} className="font-bold text-primary hover:underline" title="View invited users">
                        {u._count.referrals}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => void viewChain(u.id)}>Chain</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        )
      ) : (
        // Suspicious tab
        suspicious.length === 0 ? (
          <EmptyState
            icon={AlertTriangle}
            title="No suspicious patterns found"
            description="No referred users share a registration IP with their referrer."
          />
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-text-muted">
              {suspicious.length} IP {suspicious.length === 1 ? 'address' : 'addresses'} where multiple accounts (including a referral pair) registered from the same IP.
            </p>
            {suspicious.map((group) => {
              const idSet = new Set(group.userIds)
              return (
                <div key={group.ip} className="bg-surface shadow-card rounded-xl border border-warning/30 overflow-hidden">
                  <div className="flex items-center gap-2 px-4 py-2.5 bg-warning/5 border-b border-warning/20">
                    <AlertTriangle className="w-4 h-4 text-warning" />
                    <span className="font-mono text-sm font-medium text-text-primary">{group.ip}</span>
                    <span className="text-xs text-text-muted ml-1">— {group.userIds.length} accounts</span>
                  </div>
                  <div className="divide-y divide-border">
                    {group.userIds.map((id, idx) => {
                      const isReferred = group.referredByIds[idx] !== null
                      const referrerInGroup = isReferred && idSet.has(group.referredByIds[idx]!)
                      return (
                        <div key={id} className="flex items-center gap-3 px-4 py-3 text-sm">
                          <div className="flex-1">
                            <Link href={`/admin/users/${id}`} className="font-medium text-text-primary hover:text-primary hover:underline">{group.usernames[idx]}</Link>
                            <p className="text-xs text-text-muted">{group.emails[idx]}</p>
                          </div>
                          <div className="text-xs text-text-muted">{fmtDate(group.createdAts[idx])}</div>
                          {referrerInGroup && (
                            <span className="text-xs font-medium bg-danger/10 text-danger border border-danger/20 rounded px-2 py-0.5">
                              referred by same IP
                            </span>
                          )}
                          {isReferred && !referrerInGroup && (
                            <span className="text-xs text-text-muted bg-surface border border-border rounded px-2 py-0.5">
                              referred (external)
                            </span>
                          )}
                          {!isReferred && (
                            <span className="text-xs text-text-muted">no referral</span>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => void viewChain(id)}>Chain</Button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
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
                            <Link href={`/admin/users/${r.id}`} className="font-medium text-text-primary hover:text-primary hover:underline">{r.username}</Link>
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
