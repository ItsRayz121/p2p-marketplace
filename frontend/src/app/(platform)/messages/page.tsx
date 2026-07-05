'use client'
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/hooks/useAuth'
import { messagingApi, type InboxItem } from '@/lib/messaging'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { fmtDateTime } from '@/lib/fmt'
import { MessageSquare } from 'lucide-react'

export default function MessagesInboxPage() {
  const { user } = useAuth()
  const router = useRouter()
  const [items, setItems] = useState<InboxItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const summary = await messagingApi.getSummary()
      if (!summary.enabled) {
        router.replace('/dashboard')
        return
      }
      setItems(await messagingApi.getInbox())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load messages')
    }
  }, [router])

  useEffect(() => {
    if (user) void load()
  }, [user, load])

  if (error) return <ErrorState description={error} onRetry={load} />
  if (!items) return <LoadingState />

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <div className="flex items-center gap-2 mb-4">
        <MessageSquare className="w-5 h-5 text-indigo-500" />
        <h1 className="text-xl font-bold text-text-primary">Messaging</h1>
      </div>
      <p className="text-sm text-text-muted mb-4">
        Your conversations with people you&apos;ve traded with. Each person keeps one thread across all your trades.
      </p>

      {items.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="No conversations yet"
          description="Once you trade with someone, a conversation opens here and stays for all your future trades together."
        />
      ) : (
        <ul className="space-y-2">
          {items.map((t) => {
            const name = t.other.fullName || t.other.username || 'Trader'
            return (
              <li key={t.threadId}>
                <Link
                  href={`/messages/${t.threadId}`}
                  className="flex items-center gap-3 p-3 rounded-lg bg-surface border border-border hover:border-primary/40 transition-colors"
                >
                  <UserAvatar name={name} avatarUrl={t.other.avatarUrl} size="md" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`truncate font-semibold ${t.unread ? 'text-text-primary' : 'text-text-primary/90'}`}>{name}</span>
                      {t.unread && <span className="w-2 h-2 rounded-full bg-primary flex-shrink-0" aria-label="unread" />}
                    </div>
                    <p className="text-xs text-text-muted truncate mt-0.5">
                      {t.lastMessagePreview ?? `${t.totalTrades} trade${t.totalTrades === 1 ? '' : 's'} together`}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <span className="text-[10px] text-text-muted">{fmtDateTime(t.lastMessageAt)}</span>
                    {t.activeTrades > 0 && (
                      <span className="inline-flex items-center px-1.5 h-[18px] rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-semibold">
                        {t.activeTrades} in progress
                      </span>
                    )}
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
