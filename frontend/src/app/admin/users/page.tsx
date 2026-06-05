'use client'
import { useState, useCallback } from 'react'
import { adminApi } from '@/lib/api'
import { fmtDate, fmtDateTime } from '@/lib/fmt'
import type { AuthUser } from '@/store/auth.store'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { Users, ClipboardList, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { Input } from '@/components/ui/Input'
import { BadgeChip } from '@/components/ui/TraderLevelCard'
import type { TraderBadge } from '@/components/ui/TraderLevelCard'

interface AdminTradeStats {
  badge: TraderBadge
  badgeLabel: string
  trustScore: number
  completedTrades: number
  completionRate: number
  totalTrades: number
  badgeOverride: boolean
}

interface AdminUser extends Omit<AuthUser, 'tradeStats'> {
  isBanned?: boolean
  isSuspended?: boolean
  tradeCount?: number
  liveTradeCount?: number
  ctmBuyCount?: number
  ctmSellCount?: number
  gasOrderCount?: number
  referralCount?: number
  banReason?: string
  suspendReason?: string
  trades?: Array<{ id: string; orderRef?: string; coin: string; amount: string; fiatAmount?: string; status: string; createdAt: string }>
  sellTrades?: Array<{ id: string; orderRef?: string; coin: string; amount: string; fiatAmount?: string; status: string; createdAt: string }>
  gasFeeOrders?: Array<{ id: string; chain: string; gasAmountUSD?: string; status: string; createdAt: string }>
  kycSubmissions?: Array<{ id: string; level: string; status: string; createdAt: string }>
  tradeStats?: AdminTradeStats | null
  referredBy?: { id: string; username: string; email: string } | null
  referrals?: Array<{ id: string; username: string; email: string; createdAt: string; kycStatus: string }>
}

interface UsersResponse {
  users: AdminUser[]
  total: number
}

type UserTab = 'profile' | 'trades' | 'kyc'

export default function UsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [kycFilter, setKycFilter] = useState('')

  const [selected, setSelected] = useState<AdminUser | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<UserTab>('profile')
  const [actionReason, setActionReason] = useState('')
  const [confirmBan, setConfirmBan] = useState(false)
  const [confirmSuspend, setConfirmSuspend] = useState(false)
  const [confirmSeize, setConfirmSeize] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)
  const [badgeOverrideValue, setBadgeOverrideValue] = useState<TraderBadge>('new')
  const [badgeOverrideReason, setBadgeOverrideReason] = useState('')
  const [badgeOverriding, setBadgeOverriding] = useState(false)

  const limit = 20

  const fetchUsers = useCallback(async () => {
    try {
      const params: Record<string, string | number> = { page, limit }
      if (search) params.search = search
      if (roleFilter) params.role = roleFilter
      if (kycFilter) params.kycStatus = kycFilter
      const data = await adminApi.getUsers(params) as UsersResponse
      setUsers(data.users ?? [])
      setTotal(data.total ?? 0)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users')
    } finally {
      setLoading(false)
    }
  }, [page, search, roleFilter, kycFilter])

  usePolling(fetchUsers, 60_000)

  async function openUserModal(u: AdminUser) {
    setSelected(u)
    setActiveTab('profile')
    setActionReason('')
    setActionError(null)
    setActionSuccess(null)
    setBadgeOverrideValue((u.tradeStats?.badge ?? 'new') as TraderBadge)
    setBadgeOverrideReason('')
    setModalOpen(true)
  }

  async function handleBan() {
    if (!selected) return
    setActionError(null)
    try {
      await adminApi.banUser(selected.id, { reason: actionReason })
      setConfirmBan(false)
      setActionSuccess('User has been banned.')
      fetchUsers()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to ban user')
    }
  }

  async function handleSuspend() {
    if (!selected) return
    setActionError(null)
    try {
      await adminApi.suspendUser(selected.id, { reason: actionReason })
      setConfirmSuspend(false)
      setActionSuccess('User has been suspended.')
      fetchUsers()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to suspend user')
    }
  }

  async function handleSeize() {
    if (!selected) return
    setActionError(null)
    try {
      await adminApi.seizeCollateral(selected.id)
      setConfirmSeize(false)
      setActionSuccess('Collateral has been seized.')
      fetchUsers()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to seize collateral')
    }
  }

  async function handleBadgeOverride() {
    if (!selected) return
    setBadgeOverriding(true)
    setActionError(null)
    try {
      await adminApi.overrideBadge(selected.id, {
        badge: badgeOverrideValue,
        reason: badgeOverrideReason || undefined,
      })
      setActionSuccess(`Badge overridden to "${badgeOverrideValue}". Auto-recalculation paused.`)
      fetchUsers()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to override badge')
    } finally {
      setBadgeOverriding(false)
    }
  }

  async function handleClearBadgeOverride() {
    if (!selected) return
    setBadgeOverriding(true)
    setActionError(null)
    try {
      await adminApi.overrideBadge(selected.id, {
        badge: badgeOverrideValue,
        clearOverride: true,
      })
      setActionSuccess('Badge override cleared. Auto-recalculation resumed.')
      fetchUsers()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to clear override')
    } finally {
      setBadgeOverriding(false)
    }
  }

  const totalPages = Math.ceil(total / limit)

  const kycVariant = (s: string) => {
    if (s === 'approved') return 'success'
    if (s === 'rejected') return 'danger'
    if (s === 'pending') return 'warning'
    return 'default'
  }
  const KYC_STATUS_LABELS: Record<string, string> = {
    none: 'None', pending: 'Pending', approved: 'Approved', rejected: 'Rejected',
  }
  const kycStatusLabel = (s: string) => KYC_STATUS_LABELS[s] ?? s.charAt(0).toUpperCase() + s.slice(1)
  const TRADE_STATUS_LABELS_USER: Record<string, string> = {
    payment_pending: 'Awaiting Payment', payment_uploaded: 'Proof Uploaded',
    payment_confirmed: 'Payment Confirmed', crypto_sent: 'Crypto Sent',
    crypto_released: 'Completed', disputed: 'Disputed', cancelled: 'Cancelled', expired: 'Expired',
  }
  const tradeStatusLabelUser = (s: string) => TRADE_STATUS_LABELS_USER[s] ?? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

  if (loading) return <LoadingState message="Loading users..." />
  if (error && users.length === 0) return <ErrorState title={error} onRetry={fetchUsers} />

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Users</h1>
        <p className="text-text-muted text-sm mt-0.5">{total.toLocaleString()} users</p>
      </div>

      {/* Filters */}
      <div className="bg-surface shadow-card p-4 rounded-xl border border-border flex flex-wrap gap-3">
        <div className="flex-1 min-w-48">
          <Input
            placeholder="Search email or username..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          />
        </div>
        <select
          value={roleFilter}
          onChange={(e) => { setRoleFilter(e.target.value); setPage(1) }}
          className="px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-white focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="">All Roles</option>
          <option value="user">User</option>
          <option value="kyc_reviewer">KYC Reviewer</option>
          <option value="admin">Admin</option>
          <option value="super_admin">Super Admin</option>
        </select>
        <select
          value={kycFilter}
          onChange={(e) => { setKycFilter(e.target.value); setPage(1) }}
          className="px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-white focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="">All KYC</option>
          <option value="none">None</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      {users.length === 0 ? (
        <EmptyState icon={Users} title="No users found" description="Try adjusting your filters." />
      ) : (
        <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">User</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Role</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">KYC</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Badge</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Trades</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Joined</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-surface/50 transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-medium text-text-primary">{u.username || '—'}</p>
                      <p className="text-xs text-text-muted">{u.email}</p>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" size="sm">{u.role}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={kycVariant(u.kycStatus)} size="sm">{kycStatusLabel(u.kycStatus)}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      {u.isBanned ? (
                        <Badge variant="danger" size="sm">Banned</Badge>
                      ) : u.isSuspended ? (
                        <Badge variant="warning" size="sm">Suspended</Badge>
                      ) : (
                        <Badge variant="success" size="sm">Active</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {u.tradeStats ? (
                        <div className="flex items-center gap-1">
                          <BadgeChip badge={u.tradeStats.badge as TraderBadge} />
                          {u.tradeStats.badgeOverride && <span className="text-xs text-warning">★</span>}
                        </div>
                      ) : (
                        <span className="text-xs text-text-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{u.tradeCount ?? 0}</td>
                    <td className="px-4 py-3 text-text-secondary">{fmtDate(u.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => openUserModal(u)}>View</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <p className="text-text-muted text-sm">Page {page} of {totalPages}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
                <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* User Detail Modal */}
      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="User Details" size="lg">
        {selected && (
          <div className="space-y-5">
            {/* Tabs */}
            <div className="flex gap-1 border-b border-border">
              {(['profile', 'trades', 'kyc'] as UserTab[]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
                    activeTab === tab
                      ? 'border-primary text-primary'
                      : 'border-transparent text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>

            {activeTab === 'profile' && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-text-muted">Username</p>
                    <p className="font-medium text-text-primary">{selected.username || '—'}</p>
                  </div>
                  <div>
                    <p className="text-text-muted">Email</p>
                    <p className="text-text-primary">{selected.email}</p>
                  </div>
                  <div>
                    <p className="text-text-muted">Full Name</p>
                    <p className="text-text-primary">{selected.fullName || '—'}</p>
                  </div>
                  <div>
                    <p className="text-text-muted">Role</p>
                    <Badge variant="outline">{selected.role}</Badge>
                  </div>
                  <div>
                    <p className="text-text-muted">KYC Status</p>
                    <Badge variant={kycVariant(selected.kycStatus)}>{kycStatusLabel(selected.kycStatus)}</Badge>
                  </div>
                  <div>
                    <p className="text-text-muted">KYC Level</p>
                    <p className="text-text-primary">{selected.kycLevel}</p>
                  </div>
                  <div>
                    <p className="text-text-muted">2FA</p>
                    <Badge variant={selected.twoFaEnabled ? 'success' : 'default'}>{selected.twoFaEnabled ? 'Enabled' : 'Disabled'}</Badge>
                  </div>
                  <div>
                    <p className="text-text-muted">Email Verified</p>
                    <Badge variant={selected.isEmailVerified ? 'success' : 'warning'}>{selected.isEmailVerified ? 'Yes' : 'No'}</Badge>
                  </div>
                  <div>
                    <p className="text-text-muted">Joined</p>
                    <p className="text-text-secondary">{fmtDateTime(selected.createdAt)}</p>
                  </div>
                  <div>
                    <p className="text-text-muted">Total Trades</p>
                    <p className="text-text-primary font-medium">
                      {selected.liveTradeCount ?? selected.tradeCount ?? 0}
                      {(selected.ctmBuyCount || selected.ctmSellCount || selected.gasOrderCount) ? (
                        <span className="text-xs text-text-muted ml-1">
                          (P2P: {(selected.trades?.length ?? 0) + (selected.sellTrades?.length ?? 0)} · CTM: {(selected.ctmBuyCount ?? 0) + (selected.ctmSellCount ?? 0)} · Gas: {selected.gasOrderCount ?? 0})
                        </span>
                      ) : null}
                    </p>
                  </div>
                  {selected.referredBy && (
                    <div>
                      <p className="text-text-muted">Referred By</p>
                      <p className="text-text-primary">{selected.referredBy.username} <span className="text-xs text-text-muted">({selected.referredBy.email})</span></p>
                    </div>
                  )}
                  {(selected.referralCount ?? 0) > 0 && (
                    <div>
                      <p className="text-text-muted">Users Invited</p>
                      <p className="text-text-primary font-medium">{selected.referralCount}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-text-muted">Account Status</p>
                    {selected.isBanned ? (
                      <Badge variant="danger">Banned — {selected.banReason}</Badge>
                    ) : selected.isSuspended ? (
                      <Badge variant="warning">Suspended — {selected.suspendReason}</Badge>
                    ) : (
                      <Badge variant="success">Active</Badge>
                    )}
                  </div>
                </div>

                {/* Trader Badge */}
                <div className="bg-surface rounded-xl p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-text-primary">Trader Badge</p>
                    {selected.tradeStats?.badgeOverride && (
                      <span className="text-xs bg-warning/10 text-warning px-2 py-0.5 rounded-full font-medium">Admin Override Active</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    {selected.tradeStats ? (
                      <>
                        <BadgeChip badge={selected.tradeStats.badge as TraderBadge} badgeLabel={selected.tradeStats.badgeLabel} />
                        <span className="text-sm text-text-muted">Trust Score: <strong>{selected.tradeStats.trustScore}/100</strong></span>
                        <span className="text-sm text-text-muted">{selected.tradeStats.completedTrades} completed trades</span>
                        <span className="text-sm text-text-muted">{(Number(selected.tradeStats.completionRate) * 100).toFixed(1)}% completion</span>
                      </>
                    ) : (
                      <span className="text-sm text-text-muted">No trade stats yet</span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2 items-end">
                    <div>
                      <p className="text-xs text-text-muted mb-1">Override badge</p>
                      <select
                        value={badgeOverrideValue}
                        onChange={(e) => setBadgeOverrideValue(e.target.value as TraderBadge)}
                        className="px-3 py-2 border border-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary"
                      >
                        {(['new', 'active', 'trusted', 'top', 'elite'] as TraderBadge[]).map((b) => (
                          <option key={b} value={b}>{b.charAt(0).toUpperCase() + b.slice(1)}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex-1 min-w-32">
                      <p className="text-xs text-text-muted mb-1">Reason (optional)</p>
                      <input
                        type="text"
                        placeholder="e.g. manual review"
                        value={badgeOverrideReason}
                        onChange={(e) => setBadgeOverrideReason(e.target.value)}
                        className="w-full px-3 py-2 border border-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary"
                      />
                    </div>
                    <Button size="sm" loading={badgeOverriding} onClick={handleBadgeOverride}>
                      Set Badge
                    </Button>
                    {selected.tradeStats?.badgeOverride && (
                      <Button size="sm" variant="ghost" loading={badgeOverriding} onClick={handleClearBadgeOverride}>
                        Clear Override
                      </Button>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div>
                  <p className="text-sm font-medium text-text-primary mb-2">Action Reason</p>
                  <textarea
                    value={actionReason}
                    onChange={(e) => setActionReason(e.target.value)}
                    rows={2}
                    placeholder="Required for ban/suspend actions..."
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-white focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                  />
                </div>

                {actionError && (
                  <div className="px-3 py-2 bg-danger/10 border border-danger/20 rounded-lg text-danger text-sm">{actionError}</div>
                )}
                {actionSuccess && (
                  <div className="px-3 py-2 bg-success/10 border border-success/20 rounded-lg text-success text-sm">{actionSuccess}</div>
                )}

                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={!actionReason.trim() || !!selected.isBanned}
                    onClick={() => setConfirmBan(true)}
                  >
                    {selected.isBanned ? 'Already Banned' : 'Ban User'}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!actionReason.trim() || !!selected.isSuspended}
                    onClick={() => setConfirmSuspend(true)}
                  >
                    {selected.isSuspended ? 'Already Suspended' : 'Suspend User'}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setConfirmSeize(true)}
                  >
                    Seize Collateral
                  </Button>
                </div>

                {selected.isBanned && (
                  <p className="text-sm text-text-muted">To unban, use the platform config or contact a super admin.</p>
                )}
              </div>
            )}

            {activeTab === 'trades' && (
              <div className="space-y-4">
                {/* P2P Buy Trades */}
                {selected.trades && selected.trades.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-text-muted mb-2 uppercase tracking-wide">P2P Buys ({selected.trades.length})</p>
                    <div className="divide-y divide-border">
                      {selected.trades.slice(0, 8).map((t) => (
                        <div key={t.id} className="py-2 flex items-center justify-between text-sm">
                          <div>
                            <p className="font-mono text-xs text-text-muted">{t.orderRef ?? t.id.slice(0, 8)}</p>
                            <p className="text-text-primary">{t.amount} {t.coin} {t.fiatAmount ? `· PKR ${Number(t.fiatAmount).toLocaleString()}` : ''}</p>
                          </div>
                          <div className="text-right">
                            <Badge variant="default" size="sm">{tradeStatusLabelUser(t.status)}</Badge>
                            <p className="text-xs text-text-muted mt-0.5">{fmtDate(t.createdAt)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {/* P2P Sell Trades */}
                {selected.sellTrades && selected.sellTrades.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-text-muted mb-2 uppercase tracking-wide">P2P Sells ({selected.sellTrades.length})</p>
                    <div className="divide-y divide-border">
                      {selected.sellTrades.slice(0, 8).map((t) => (
                        <div key={t.id} className="py-2 flex items-center justify-between text-sm">
                          <div>
                            <p className="font-mono text-xs text-text-muted">{t.orderRef ?? t.id.slice(0, 8)}</p>
                            <p className="text-text-primary">{t.amount} {t.coin} {t.fiatAmount ? `· PKR ${Number(t.fiatAmount).toLocaleString()}` : ''}</p>
                          </div>
                          <div className="text-right">
                            <Badge variant="default" size="sm">{tradeStatusLabelUser(t.status)}</Badge>
                            <p className="text-xs text-text-muted mt-0.5">{fmtDate(t.createdAt)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {/* Gas Orders */}
                {selected.gasFeeOrders && selected.gasFeeOrders.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-text-muted mb-2 uppercase tracking-wide">Gas Orders ({selected.gasOrderCount ?? selected.gasFeeOrders.length})</p>
                    <div className="divide-y divide-border">
                      {selected.gasFeeOrders.slice(0, 5).map((g) => (
                        <div key={g.id} className="py-2 flex items-center justify-between text-sm">
                          <div>
                            <p className="font-mono text-xs text-text-muted">{g.chain}</p>
                            <p className="text-text-primary">{g.gasAmountUSD ? `$${Number(g.gasAmountUSD).toFixed(4)}` : 'N/A'} gas</p>
                          </div>
                          <div className="text-right">
                            <Badge variant="default" size="sm">{g.status}</Badge>
                            <p className="text-xs text-text-muted mt-0.5">{fmtDate(g.createdAt)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {/* CTM summary */}
                {((selected.ctmBuyCount ?? 0) + (selected.ctmSellCount ?? 0)) > 0 && (
                  <div className="bg-surface border border-border rounded-lg px-4 py-3 text-sm">
                    <p className="font-medium text-text-primary">CTM Community Trades</p>
                    <p className="text-text-muted text-xs mt-0.5">
                      {selected.ctmBuyCount ?? 0} buys · {selected.ctmSellCount ?? 0} sells
                      {' — see /admin/ctm/trades for detail'}
                    </p>
                  </div>
                )}
                {!selected.trades?.length && !selected.sellTrades?.length && !selected.gasFeeOrders?.length &&
                  !(selected.ctmBuyCount) && !(selected.ctmSellCount) && (
                  <EmptyState icon={ClipboardList} title="No trades" description="This user has no trade history." />
                )}
              </div>
            )}

            {activeTab === 'kyc' && (
              <div>
                {!selected.kycSubmissions || selected.kycSubmissions.length === 0 ? (
                  <EmptyState icon={ShieldCheck} title="No KYC submissions" description="This user has not submitted KYC." />
                ) : (
                  <div className="divide-y divide-border">
                    {selected.kycSubmissions.map((k) => (
                      <div key={k.id} className="py-2.5 flex items-center justify-between text-sm">
                        <div>
                          <p className="text-text-primary capitalize">{k.level} KYC</p>
                          <p className="text-xs text-text-muted">{fmtDate(k.createdAt)}</p>
                        </div>
                        <Badge variant={kycVariant(k.status)} size="sm">{k.status}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>

      <ConfirmModal
        isOpen={confirmBan}
        onClose={() => setConfirmBan(false)}
        onConfirm={handleBan}
        title="Ban User"
        description={`Permanently ban ${selected?.email}? They will lose access to the platform.`}
        confirmLabel="Ban User"
        confirmVariant="danger"
      />
      <ConfirmModal
        isOpen={confirmSuspend}
        onClose={() => setConfirmSuspend(false)}
        onConfirm={handleSuspend}
        title="Suspend User"
        description={`Suspend ${selected?.email}? Their account will be temporarily restricted.`}
        confirmLabel="Suspend"
        confirmVariant="danger"
      />
      <ConfirmModal
        isOpen={confirmSeize}
        onClose={() => setConfirmSeize(false)}
        onConfirm={handleSeize}
        title="Seize Collateral"
        description={`Seize all collateral from ${selected?.email}? This action cannot be undone.`}
        confirmLabel="Seize Collateral"
        confirmVariant="danger"
      />
    </div>
  )
}

