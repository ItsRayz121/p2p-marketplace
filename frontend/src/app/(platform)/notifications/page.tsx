'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { notificationsApi } from '@/lib/api'
import type { Notification } from '@/lib/api'
import { useSSE } from '@/hooks/useSSE'
import { openSupportChat } from '@/lib/supportChat'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { Bell } from 'lucide-react'
import { PushToggle } from '@/components/ui/PushToggle'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  if (hrs < 168) return `${Math.floor(hrs / 24)}d ago`
  return new Date(dateStr).toLocaleDateString()
}

function NotifIcon({ type }: { type: string }) {
  const base = 'w-5 h-5'
  if (type === 'trade' || type.startsWith('CTM_') || type.startsWith('ctm_'))
    return (
      <svg className={`${base} text-primary`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
      </svg>
    )
  if (type === 'dispute')
    return (
      <svg className={`${base} text-danger`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      </svg>
    )
  if (type === 'kyc')
    return (
      <svg className={`${base} text-warning`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
      </svg>
    )
  if (type === 'badge')
    return (
      <svg className={`${base} text-gold`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
      </svg>
    )
  if (type === 'payment' || type === 'wallet')
    return (
      <svg className={`${base} text-success`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
      </svg>
    )
  return (
    <svg className={`${base} text-text-muted`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
    </svg>
  )
}

function getNavTarget(notif: Notification): string | null {
  const meta = notif.metadata as Record<string, string> | undefined
  const t = notif.type

  // P2P trade & dispute
  if ((t === 'trade' || t === 'dispute') && meta?.tradeId) return `/trade/${meta.tradeId}`

  // CTM dispute-related types deep-link into the trade room and auto-open the
  // dispute panel + evidence/response area.
  const ctmDisputeTypes = new Set([
    'CTM_DISPUTE_OPENED', 'CTM_DISPUTE_RESOLVED', 'CTM_AUTO_DISPUTE', 'CTM_DISPUTE_MESSAGE',
  ])
  if (ctmDisputeTypes.has(t) && meta?.tradeRef) return `/ctm/trade/${meta.tradeRef}?focus=dispute`

  // CTM trade room (all other CTM_ types that carry a tradeRef)
  const ctmTradeTypes = new Set([
    'ctm_trade_created',
    'CTM_PAYMENT_UPLOADED', 'CTM_PAYMENT_CONFIRMED', 'CTM_SELLER_TRANSFERRING',
    'CTM_TOKEN_PROOF_SUBMITTED', 'CTM_TRADE_COMPLETED', 'CTM_TRADE_CANCELLED',
    'CTM_AUTO_COMPLETED', 'CTM_ESCROW_CONFIRMED', 'CTM_TRADE_EXPIRED',
  ])
  if (ctmTradeTypes.has(t) && meta?.tradeRef) return `/ctm/trade/${meta.tradeRef}`

  // CTM bids
  if (t === 'CTM_BID_ACCEPTED' && meta?.tradeRef) return `/ctm/trade/${meta.tradeRef}`
  if (t === 'CTM_BID_RECEIVED') {
    if (meta?.listingId) return `/ctm/listings/${meta.listingId}`
    return '/ctm/my-requests'
  }

  // USDT marketplace bids
  if (t === 'AD_BID_RECEIVED' && meta?.adId) return `/marketplace/listings/${meta.adId}`
  if (t === 'AD_BID_ACCEPTED_PENDING' && meta?.adId) return `/marketplace/listings/${meta.adId}`
  if (t === 'AD_BID_ACCEPTED' && meta?.tradeId) return `/trade/${meta.tradeId}`
  if (t === 'AD_TRADE_READY' && meta?.tradeId) return `/trade/${meta.tradeId}`

  // Profile & account
  if (t === 'kyc') return '/kyc'
  if (t === 'badge') return '/dashboard'
  if (t === 'wallet' || t === 'payment') return '/wallet'
  if (t === 'referral') return '/referral'

  return null
}

// ─── Page ────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 20

export default function NotificationsPage() {
  const router = useRouter()
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [markingAll, setMarkingAll] = useState(false)

  const fetchPage = useCallback(async (pg: number, append = false) => {
    if (append) setLoadingMore(true)
    else setLoading(true)
    try {
      const res = await notificationsApi.getAll({ page: pg, limit: PAGE_SIZE })
      setTotal(res.pagination?.total ?? 0)
      if (append) {
        setNotifications((prev) => [...prev, ...res.notifications])
      } else {
        setNotifications(res.notifications)
      }
    } catch (err) {
      if (!append) setError(err instanceof Error ? err.message : 'Failed to load notifications')
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [])

  useEffect(() => { fetchPage(1) }, [fetchPage])

  useSSE((event) => {
    if (event.type === 'notification') {
      const n = event.payload as Notification | undefined
      if (!n) return
      setNotifications((prev) => [{ ...n, isRead: false }, ...prev])
      setTotal((t) => t + 1)
    }
  })

  const handleMarkAllRead = async () => {
    setMarkingAll(true)
    try {
      await notificationsApi.markAllRead()
      setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })))
    } catch { /* silent */ } finally { setMarkingAll(false) }
  }

  const handleClick = async (notif: Notification) => {
    if (!notif.isRead) {
      notificationsApi.markRead(notif.id).catch(() => {})
      setNotifications((prev) => prev.map((n) => n.id === notif.id ? { ...n, isRead: true } : n))
    }
    // Support replies open the live chat widget rather than navigating
    if (notif.type === 'support') {
      openSupportChat()
      return
    }
    const target = getNavTarget(notif)
    if (target) router.push(target)
  }

  const loadMore = () => {
    const nextPage = page + 1
    setPage(nextPage)
    fetchPage(nextPage, true)
  }

  const unread = notifications.filter((n) => !n.isRead).length

  if (loading) return <LoadingState message="Loading notifications..." />
  if (error) return <ErrorState title={error} onRetry={() => fetchPage(1)} />

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Notifications</h1>
          {unread > 0 && (
            <p className="text-sm text-text-muted">{unread} unread</p>
          )}
        </div>
        {unread > 0 && (
          <Button size="sm" variant="secondary" onClick={handleMarkAllRead} disabled={markingAll}>
            {markingAll ? <Spinner size="sm" /> : 'Mark all read'}
          </Button>
        )}
      </div>

      {/* Push notification opt-in banner */}
      <div className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3">
        <p className="text-sm text-text-muted">Get alerts even when you leave this page</p>
        <PushToggle />
      </div>

      {notifications.length === 0 ? (
        <EmptyState icon={Bell} title="All caught up" description="You have no new notifications." />
      ) : (
        <div className="bg-surface shadow-card border border-border rounded-xl overflow-hidden divide-y divide-border">
          {notifications.map((notif) => {
            const target = getNavTarget(notif)
            return (
              <button
                key={notif.id}
                onClick={() => handleClick(notif)}
                className={`w-full flex items-start gap-3 px-4 py-4 text-left transition-colors ${
                  target ? 'hover:bg-surface-alt cursor-pointer' : 'cursor-default'
                } ${!notif.isRead ? 'bg-primary/5' : ''}`}
              >
                <div className="flex-shrink-0 mt-0.5 w-8 h-8 rounded-full bg-surface flex items-center justify-center">
                  <NotifIcon type={notif.type} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <p className={`text-sm ${!notif.isRead ? 'font-semibold text-text-primary' : 'font-medium text-text-primary'}`}>
                      {notif.title}
                    </p>
                    <span className="text-xs text-text-muted flex-shrink-0">{timeAgo(notif.createdAt)}</span>
                  </div>
                  <p className="text-sm text-text-muted mt-0.5 line-clamp-2">{notif.body}</p>
                </div>
                <div className="flex-shrink-0 flex items-center gap-1.5 mt-1">
                  {!notif.isRead && (
                    <div className="w-2 h-2 rounded-full bg-primary" />
                  )}
                  {target && (
                    <svg className="w-4 h-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}

      {notifications.length < total && (
        <div className="mt-4 text-center">
          <Button variant="secondary" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <Spinner size="sm" /> : `Load more (${total - notifications.length} remaining)`}
          </Button>
        </div>
      )}
    </div>
  )
}
