'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { adminApi } from '@/lib/api'
import { fmtDate } from '@/lib/fmt'
import type { AuthUser } from '@/store/auth.store'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { Users, ChevronRight, Send } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { BadgeChip } from '@/components/ui/TraderLevelCard'
import type { TraderBadge } from '@/components/ui/TraderLevelCard'
import type { ModerationStatus } from '@/components/admin/ModerationPanel'

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
  moderationStatus?: ModerationStatus
  hasPendingAppeal?: boolean
  tradeCount?: number
  tradeStats?: AdminTradeStats | null
}

interface UsersResponse {
  users: AdminUser[]
  total?: number
  pagination?: { page: number; limit: number; total: number; pages: number }
}

export default function UsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const router = useRouter()
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [kycFilter, setKycFilter] = useState('')
  const [searching, setSearching] = useState(false)

  const limit = 20

  const fetchUsers = useCallback(async () => {
    try {
      const params: Record<string, string | number> = { page, limit }
      if (search) params.search = search
      if (roleFilter) params.role = roleFilter
      if (kycFilter) params.kycStatus = kycFilter
      const data = await adminApi.getUsers(params) as UsersResponse
      setUsers(data.users ?? [])
      setTotal(data.pagination?.total ?? data.total ?? 0)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users')
    } finally {
      setLoading(false)
      setSearching(false)
    }
  }, [page, search, roleFilter, kycFilter])

  // Seed the search box from a ?search= deep link (e.g. from the ⌘K palette).
  // Read from window.location to avoid the useSearchParams Suspense requirement.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('search')
    if (q) { setSearchInput(q); setSearch(q) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  usePolling(fetchUsers, 60_000)

  // Debounced live search: re-fetch shortly after the admin stops typing.
  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return }
    setSearching(true)
    const t = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 350)
    return () => clearTimeout(t)
  }, [searchInput])

  useEffect(() => {
    fetchUsers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, roleFilter, kycFilter, page])

  function runSearchNow() {
    setSearch(searchInput.trim())
    setPage(1)
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

  if (loading) return <LoadingState message="Loading users..." />
  if (error && users.length === 0) return <ErrorState title={error} onRetry={fetchUsers} />

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Users</h1>
        <p className="text-text-muted text-sm mt-0.5">{total.toLocaleString()} users · click a row to open the full profile</p>
      </div>

      {/* Filters */}
      <div className="bg-surface shadow-card p-4 rounded-xl border border-border flex flex-wrap gap-3">
        <div className="flex-1 min-w-48">
          <Input
            placeholder="Search username, name, email, Telegram @handle, user ID, referral code, IP..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runSearchNow() }}
          />
        </div>
        <Button onClick={runSearchNow} loading={searching}>Search</Button>
        <select
          value={roleFilter}
          onChange={(e) => { setRoleFilter(e.target.value); setPage(1) }}
          className="px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="">All Roles</option>
          <option value="user">User</option>
          <option value="kyc_reviewer">KYC Reviewer</option>
          <option value="support_agent">Support Agent</option>
          <option value="admin">Admin</option>
          <option value="super_admin">Super Admin</option>
        </select>
        <select
          value={kycFilter}
          onChange={(e) => { setKycFilter(e.target.value); setPage(1) }}
          className="px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="">All KYC</option>
          <option value="none">None</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      {users.length === 0 ? (
        <EmptyState
          icon={Users}
          title={search ? `No user found for “${search}”` : 'No users found'}
          description={search ? 'Check the spelling or try a different username, email, or ID.' : 'Try adjusting your filters.'}
        />
      ) : (
        <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm stack-sm">
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
                  <tr
                    key={u.id}
                    onClick={() => router.push(`/admin/users/${u.id}`)}
                    className="hover:bg-surface/50 transition-colors cursor-pointer"
                  >
                    <td className="px-4 py-3" data-label="User">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 sm:justify-start justify-end flex-wrap">
                          <Link
                            href={`/admin/users/${u.id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="font-medium text-primary hover:underline"
                          >
                            {u.username || '—'}
                          </Link>
                          {u.telegramLinked && (
                            <span
                              title={u.telegramUsername ? `Telegram: @${u.telegramUsername}` : 'Joined via Telegram'}
                              className="inline-flex items-center gap-0.5 rounded-full bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-500"
                            >
                              <Send size={10} /> Telegram
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-text-muted">
                          {u.hasRealEmail
                            ? u.email
                            : u.telegramUsername
                              ? `@${u.telegramUsername}`
                              : 'Telegram — no email yet'}
                        </p>
                      </div>
                    </td>
                    <td className="px-4 py-3" data-label="Role">
                      <Badge variant="outline" size="sm">{u.role}</Badge>
                    </td>
                    <td className="px-4 py-3" data-label="KYC">
                      <Badge variant={kycVariant(u.kycStatus)} size="sm">{kycStatusLabel(u.kycStatus)}</Badge>
                    </td>
                    <td className="px-4 py-3" data-label="Status">
                      <div className="flex flex-col items-end sm:items-start gap-1">
                        {u.moderationStatus === 'permanently_banned' || u.moderationStatus === 'temporarily_banned' ? (
                          <Badge variant="danger" size="sm">{u.moderationStatus === 'temporarily_banned' ? 'Temp Banned' : 'Banned'}</Badge>
                        ) : u.moderationStatus === 'suspended' ? (
                          <Badge variant="warning" size="sm">Suspended</Badge>
                        ) : u.moderationStatus === 'under_review' ? (
                          <Badge variant="default" size="sm">Under Review</Badge>
                        ) : (
                          <Badge variant="success" size="sm">Active</Badge>
                        )}
                        {u.hasPendingAppeal && <Badge variant="info" size="sm">Appeal</Badge>}
                      </div>
                    </td>
                    <td className="px-4 py-3" data-label="Badge">
                      {u.tradeStats ? (
                        <div className="flex items-center gap-1">
                          <BadgeChip badge={u.tradeStats.badge as TraderBadge} />
                          {u.tradeStats.badgeOverride && <span className="text-xs text-warning">★</span>}
                        </div>
                      ) : (
                        <span className="text-xs text-text-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-text-secondary" data-label="Trades">{u.tradeCount ?? 0}</td>
                    <td className="px-4 py-3 text-text-secondary" data-label="Joined">{fmtDate(u.createdAt)}</td>
                    <td className="px-4 py-3 text-right stack-hide">
                      <ChevronRight size={16} className="text-text-muted inline-block" />
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
    </div>
  )
}
