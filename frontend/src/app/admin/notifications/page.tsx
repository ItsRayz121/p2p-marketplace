'use client'
import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { adminApi, type AdminNotif, type AdminNotifCategory } from '@/lib/api'
import { cn } from '@/lib/utils'

const CATEGORIES: { id: AdminNotifCategory | 'ALL'; label: string; color: string }[] = [
  { id: 'ALL',     label: 'All',      color: 'bg-surface-alt text-text-secondary' },
  { id: 'KYC',     label: 'KYC',      color: 'bg-blue-100 text-blue-700' },
  { id: 'TRADE',   label: 'Trade',    color: 'bg-purple-100 text-purple-700' },
  { id: 'DISPUTE', label: 'Dispute',  color: 'bg-red-100 text-red-700' },
  { id: 'GAS',     label: 'Gas',      color: 'bg-orange-100 text-orange-700' },
  { id: 'CTM',     label: 'CTM',      color: 'bg-teal-100 text-teal-700' },
  { id: 'SYSTEM',  label: 'System',   color: 'bg-surface-alt text-text-secondary' },
]

const CATEGORY_COLOR: Record<AdminNotifCategory, string> = {
  KYC:     'bg-blue-100 text-blue-700',
  TRADE:   'bg-purple-100 text-purple-700',
  GAS:     'bg-orange-100 text-orange-700',
  DISPUTE: 'bg-red-100 text-red-700',
  CTM:     'bg-teal-100 text-teal-700',
  SYSTEM:  'bg-surface-alt text-text-secondary',
}

export default function AdminNotificationsPage() {
  const [activeTab, setActiveTab]       = useState<AdminNotifCategory | 'ALL'>('ALL')
  const [unreadOnly, setUnreadOnly]     = useState(false)
  const [notifications, setNotifs]      = useState<AdminNotif[]>([])
  const [unreadCount, setUnreadCount]   = useState(0)
  const [total, setTotal]               = useState(0)
  const [page, setPage]                 = useState(1)
  const [pages, setPages]               = useState(1)
  const [loading, setLoading]           = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const load = useCallback(async (tab: AdminNotifCategory | 'ALL', unread: boolean, p: number) => {
    setLoading(true)
    try {
      const res = await adminApi.getAdminNotifications({
        category:   tab === 'ALL' ? undefined : tab,
        unreadOnly: unread || undefined,
        page:       p,
        limit:      20,
      })
      setNotifs(res.notifications)
      setUnreadCount(res.unreadCount)
      setTotal(res.pagination.total)
      setPages(res.pagination.pages)
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(activeTab, unreadOnly, page) }, [activeTab, unreadOnly, page, load])

  const switchTab = (tab: AdminNotifCategory | 'ALL') => {
    setActiveTab(tab)
    setPage(1)
  }

  const toggleUnreadOnly = () => {
    setUnreadOnly((u) => !u)
    setPage(1)
  }

  const markRead = async (id: string) => {
    setActionLoading(id)
    try {
      await adminApi.markAdminNotifRead(id)
      setNotifs((prev) => prev.map((n) => n.id === id ? { ...n, isRead: true } : n))
      setUnreadCount((c) => Math.max(0, c - 1))
    } catch { /* ignore */ } finally {
      setActionLoading(null)
    }
  }

  const markAllRead = async () => {
    setActionLoading('all')
    try {
      await adminApi.markAllAdminNotifsRead(activeTab === 'ALL' ? undefined : activeTab)
      setNotifs((prev) => prev.map((n) => ({ ...n, isRead: true })))
      setUnreadCount(0)
    } catch { /* ignore */ } finally {
      setActionLoading(null)
    }
  }

  const pruneOld = async () => {
    setActionLoading('prune')
    try {
      const res = await adminApi.deleteOldAdminNotifs()
      void load(activeTab, unreadOnly, 1)
      setPage(1)
      alert(`Deleted ${res.deleted} old read notifications.`)
    } catch { /* ignore */ } finally {
      setActionLoading(null)
    }
  }

  return (
    <div className="space-y-5">
      {/* Page header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Notifications</h1>
          <p className="text-text-muted text-sm mt-0.5">
            {total.toLocaleString()} total — {unreadCount} unread
          </p>
        </div>
        <div className="flex items-center gap-2">
          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              disabled={actionLoading === 'all'}
              className="text-xs px-3 py-1.5 rounded-lg bg-primary text-white font-medium hover:bg-primary/90 disabled:opacity-60 transition-colors"
            >
              {actionLoading === 'all' ? 'Marking…' : 'Mark all read'}
            </button>
          )}
          <button
            onClick={pruneOld}
            disabled={actionLoading === 'prune'}
            className="text-xs px-3 py-1.5 rounded-lg border border-border text-text-secondary hover:bg-surface disabled:opacity-60 transition-colors"
          >
            {actionLoading === 'prune' ? 'Pruning…' : 'Delete old (30d+)'}
          </button>
        </div>
      </div>

      {/* Category tabs */}
      <div className="bg-surface shadow-card rounded-xl border border-border p-1 flex flex-wrap gap-1">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            onClick={() => switchTab(cat.id)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors',
              activeTab === cat.id
                ? 'bg-primary text-white shadow-sm'
                : 'text-text-secondary hover:bg-surface',
            )}
          >
            {cat.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 px-2">
          <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={toggleUnreadOnly}
              className="rounded"
            />
            Unread only
          </label>
        </div>
      </div>

      {/* Notification list */}
      <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-text-muted text-sm gap-2">
            <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            Loading…
          </div>
        ) : notifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-text-muted gap-3">
            <svg className="w-10 h-10 opacity-25" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
            </svg>
            <p className="text-sm">No notifications{unreadOnly ? ' (unread)' : ''}</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {notifications.map((n) => (
              <div
                key={n.id}
                className={cn(
                  'flex items-start gap-4 px-5 py-4 transition-colors',
                  !n.isRead ? 'bg-blue-50/30' : 'hover:bg-surface',
                )}
              >
                {/* Unread dot */}
                <div className="mt-1.5 shrink-0">
                  {!n.isRead ? (
                    <div className="w-2 h-2 rounded-full bg-primary" />
                  ) : (
                    <div className="w-2 h-2 rounded-full bg-surface-alt" />
                  )}
                </div>

                {/* Category badge */}
                <span className={cn('mt-0.5 shrink-0 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide', CATEGORY_COLOR[n.category])}>
                  {n.category}
                </span>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-text-primary">{n.title}</p>
                  <p className="text-xs text-text-muted mt-0.5">{n.body}</p>
                  <p className="text-[11px] text-text-muted mt-1.5">
                    {new Date(n.createdAt).toLocaleString('en-US', {
                      dateStyle: 'medium', timeStyle: 'short',
                    })}
                  </p>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0 mt-0.5">
                  {n.href && (
                    <Link
                      href={n.href}
                      onClick={() => !n.isRead && void markRead(n.id)}
                      className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-primary border border-primary/20 hover:bg-primary/5 transition-colors"
                    >
                      Go
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </Link>
                  )}
                  {!n.isRead && (
                    <button
                      onClick={() => void markRead(n.id)}
                      disabled={actionLoading === n.id}
                      className="p-1.5 rounded-lg text-green-600 hover:bg-green-50 disabled:opacity-50 transition-colors"
                      title="Mark as read"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      {pages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-text-muted">
            Page {page} of {pages} — {total} total
          </p>
          <div className="flex items-center gap-2">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="px-3 py-1.5 text-xs rounded-lg border border-border text-text-secondary hover:bg-surface disabled:opacity-40 transition-colors"
            >
              Previous
            </button>
            <button
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
              className="px-3 py-1.5 text-xs rounded-lg border border-border text-text-secondary hover:bg-surface disabled:opacity-40 transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
