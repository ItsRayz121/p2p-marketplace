'use client'
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { SlidersHorizontal } from 'lucide-react'
import { adminApi, type AdminNotif, type AdminNotifGroup } from '@/lib/api'
import { GROUP_COLOR, GROUP_LABEL, GROUP_ORDER, clusterNotifications, groupOf, resolveNotifHref, PREFS_CHANGED_EVENT } from '@/lib/adminNotifications'
import { NotificationPreferences } from '@/components/admin/NotificationPreferences'
import { cn } from '@/lib/utils'

export default function AdminNotificationsPage() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  )
}

function Inner() {
  const router = useRouter()
  const params = useSearchParams()
  const view = params.get('view') === 'preferences' ? 'preferences' : 'inbox'
  const groupParam = params.get('group') as AdminNotifGroup | null
  const activeTab: AdminNotifGroup | 'ALL' = groupParam && GROUP_ORDER.includes(groupParam) ? groupParam : 'ALL'

  const [unreadOnly, setUnreadOnly]     = useState(false)
  const [notifications, setNotifs]      = useState<AdminNotif[]>([])
  const [unreadCount, setUnreadCount]   = useState(0)
  const [total, setTotal]               = useState(0)
  const [page, setPage]                 = useState(1)
  const [pages, setPages]               = useState(1)
  const [loading, setLoading]           = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const setParam = useCallback((k: string, v: string | null) => {
    const q = new URLSearchParams(params.toString())
    if (v) q.set(k, v); else q.delete(k)
    const qs = q.toString()
    router.replace(qs ? `/admin/notifications?${qs}` : '/admin/notifications', { scroll: false })
  }, [params, router])

  const load = useCallback(async (tab: AdminNotifGroup | 'ALL', unread: boolean, p: number) => {
    setLoading(true)
    try {
      const res = await adminApi.getAdminNotifications({
        ...(tab === 'ALL' ? {} : { group: tab }),
        ...(unread ? { unreadOnly: true } : {}),
        page: p,
        limit: 20,
      })
      setNotifs(res.notifications)
      setUnreadCount(res.unreadCount)
      setTotal(res.pagination.total)
      setPages(res.pagination.pages)
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (view === 'inbox') void load(activeTab, unreadOnly, page) }, [view, activeTab, unreadOnly, page, load])
  // A change made in Preferences (or another tab) must be reflected in what the inbox lists.
  useEffect(() => {
    const h = () => { if (view === 'inbox') void load(activeTab, unreadOnly, page) }
    window.addEventListener(PREFS_CHANGED_EVENT, h)
    return () => window.removeEventListener(PREFS_CHANGED_EVENT, h)
  }, [view, activeTab, unreadOnly, page, load])

  const clusters = useMemo(() => clusterNotifications(notifications), [notifications])

  const markRead = async (ids: string[]) => {
    setActionLoading(ids[0] ?? null)
    try {
      await Promise.all(ids.map((id) => adminApi.markAdminNotifRead(id)))
      setNotifs((prev) => prev.map((n) => ids.includes(n.id) ? { ...n, isRead: true } : n))
      setUnreadCount((c) => Math.max(0, c - ids.length))
    } catch { /* ignore */ } finally {
      setActionLoading(null)
    }
  }

  const markAllRead = async () => {
    setActionLoading('all')
    try {
      await adminApi.markAllAdminNotifsRead(activeTab === 'ALL' ? undefined : { group: activeTab })
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
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Notifications</h1>
          <p className="text-text-muted text-sm mt-0.5">
            {view === 'inbox' ? `${total.toLocaleString()} shown — ${unreadCount} unread` : 'Choose what reaches you, and how.'}
          </p>
        </div>
        <div className="inline-flex rounded-xl border border-border bg-surface p-1" role="tablist" aria-label="Notifications view">
          {([['inbox', 'Inbox'], ['preferences', 'My preferences']] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={view === k}
              onClick={() => setParam('view', k === 'inbox' ? null : k)}
              className={cn('inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors', view === k ? 'bg-primary text-white shadow-sm' : 'text-text-secondary hover:bg-surface-alt')}
            >
              {k === 'preferences' && <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />}
              {label}
            </button>
          ))}
        </div>
      </div>

      {view === 'preferences' ? (
        <NotificationPreferences />
      ) : (
        <>
          <div className="flex items-center justify-end gap-2">
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

          {/* Group tabs */}
          <div className="bg-surface shadow-card rounded-xl border border-border p-1 flex flex-col gap-1 sm:flex-row sm:items-center">
            <div className="admin-toolbar gap-1 flex-1" role="group" aria-label="Alert group">
              {(['ALL', ...GROUP_ORDER] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  aria-pressed={activeTab === g}
                  onClick={() => { setParam('group', g === 'ALL' ? null : g); setPage(1) }}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors',
                    activeTab === g ? 'bg-primary text-white shadow-sm' : 'text-text-secondary hover:bg-surface-alt',
                  )}
                >
                  {g === 'ALL' ? 'All' : GROUP_LABEL[g]}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 px-2 shrink-0">
              <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer select-none">
                <input type="checkbox" checked={unreadOnly} onChange={() => { setUnreadOnly((u) => !u); setPage(1) }} className="rounded" />
                Unread only
              </label>
            </div>
          </div>

          <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
            {loading ? (
              <div className="flex items-center justify-center py-16 text-text-muted text-sm gap-2">
                <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                Loading…
              </div>
            ) : clusters.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-text-muted gap-3">
                <svg className="w-10 h-10 opacity-25" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                <p className="text-sm">No notifications{unreadOnly ? ' (unread)' : ''}</p>
                <p className="text-xs">Some groups may be muted in <button type="button" className="text-primary underline" onClick={() => setParam('view', 'preferences')}>your preferences</button>.</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {clusters.map(({ key, items }) => {
                  const n = items[0]!
                  const g = groupOf(n)
                  const unreadIds = items.filter((x) => !x.isRead).map((x) => x.id)
                  const href = resolveNotifHref(n)
                  return (
                    <div key={key} className={cn('flex items-start gap-4 px-5 py-4 transition-colors', unreadIds.length ? 'bg-blue-500/10' : 'hover:bg-surface')}>
                      <div className="mt-1.5 shrink-0" aria-hidden>
                        <div className={cn('w-2 h-2 rounded-full', unreadIds.length ? 'bg-primary' : 'bg-surface-alt')} />
                      </div>
                      <span className={cn('mt-0.5 shrink-0 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide', GROUP_COLOR[g])}>{GROUP_LABEL[g]}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-text-primary">
                          {n.title}
                          {items.length > 1 && <span className="ml-2 rounded-full bg-surface-alt px-2 py-0.5 text-[11px] font-semibold text-text-secondary" title="Repeated within 15 minutes">×{items.length}</span>}
                        </p>
                        <p className="text-xs text-text-muted mt-0.5">{n.body}</p>
                        <p className="text-[11px] text-text-muted mt-1.5">
                          {new Date(n.createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
                          {items.length > 1 && ` · first at ${new Date(items[items.length - 1]!.createdAt).toLocaleTimeString('en-US', { timeStyle: 'short' })}`}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0 mt-0.5">
                        {href && (
                          <Link
                            href={href}
                            onClick={() => unreadIds.length && void markRead(unreadIds)}
                            className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-primary border border-primary/20 hover:bg-primary/5 transition-colors"
                          >
                            Go
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                          </Link>
                        )}
                        {unreadIds.length > 0 && (
                          <button
                            onClick={() => void markRead(unreadIds)}
                            disabled={actionLoading === unreadIds[0]}
                            className="p-1.5 rounded-lg text-green-600 dark:text-green-400 hover:bg-green-500/10 disabled:opacity-50 transition-colors"
                            title={items.length > 1 ? 'Mark all repeats as read' : 'Mark as read'}
                            aria-label="Mark as read"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {pages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-text-muted">Page {page} of {pages} — {total} total</p>
              <div className="flex items-center gap-2">
                <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="px-3 py-1.5 text-xs rounded-lg border border-border text-text-secondary hover:bg-surface disabled:opacity-40 transition-colors">Previous</button>
                <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className="px-3 py-1.5 text-xs rounded-lg border border-border text-text-secondary hover:bg-surface disabled:opacity-40 transition-colors">Next</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
