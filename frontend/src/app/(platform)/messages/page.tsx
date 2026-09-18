'use client'
import { useState, useEffect, useCallback, Suspense } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/hooks/useAuth'
import { ApiError } from '@/lib/api'
import { messagingApi, type InboxItem, type ChatUser } from '@/lib/messaging'
import { channelsApi, type MyChannel } from '@/lib/channels'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { ChannelsTab } from '@/components/channels/ChannelsTab'
import { fmtDateTime } from '@/lib/fmt'
import { MessageSquare, BadgeCheck, Headphones, Search, X, Check, CheckCheck, FileText, Radio } from 'lucide-react'

/** True when a search query (after trimming + stripping a leading "@") is the
 *  viewer's own username — searchUsers deliberately excludes the caller, so
 *  an empty result set for your own handle needs a distinct message pointing
 *  at My Notes instead of the generic "no one found" text. */
function isOwnUsername(query: string, myUsername: string | null | undefined): boolean {
  if (!myUsername) return false
  const q = query.trim().replace(/^@/, '')
  return q.length > 0 && q.toLowerCase() === myUsername.toLowerCase()
}

/** WhatsApp-style delivery tick for the inbox preview, shown only when the
 *  viewer sent the last message in that thread. */
function LastMessageTick({ status }: { status: 'sent' | 'delivered' | 'read' | null }) {
  if (!status) return null
  if (status === 'read') return <CheckCheck className="w-3.5 h-3.5 text-sky-500 flex-shrink-0" aria-label="Read" />
  if (status === 'delivered') return <CheckCheck className="w-3.5 h-3.5 text-text-muted flex-shrink-0" aria-label="Delivered" />
  return <Check className="w-3.5 h-3.5 text-text-muted flex-shrink-0" aria-label="Sent" />
}

function MessagesListTab({ tabBar }: { tabBar: React.ReactNode }) {
  const { user } = useAuth()
  const router = useRouter()
  const [items, setItems] = useState<InboxItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Find-by-username search — starts a conversation even without a shared
  // trade. Debounced so we're not firing a request per keystroke.
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ChatUser[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [starting, setStarting] = useState<string | null>(null)
  const [openingNotes, setOpeningNotes] = useState(false)

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setResults(null); setSearching(false); return }
    setSearching(true)
    const id = setTimeout(() => {
      messagingApi.search(q)
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false))
    }, 300)
    return () => clearTimeout(id)
  }, [query])

  async function startWith(username: string) {
    setStarting(username)
    try {
      const { threadId } = await messagingApi.start(username)
      router.push(`/messages/${threadId}`)
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Could not start that conversation')
      setStarting(null)
    }
  }

  async function openMyNotes() {
    if (openingNotes) return
    setOpeningNotes(true)
    try {
      const { threadId } = await messagingApi.self()
      router.push(`/messages/${threadId}`)
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Could not open My Notes')
      setOpeningNotes(false)
    }
  }

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

  if (error) return <div className="max-w-2xl mx-auto px-4 py-6">{tabBar}<ErrorState description={error} onRetry={load} /></div>
  if (!items) return <div className="max-w-2xl mx-auto px-4 py-6">{tabBar}<LoadingState /></div>

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      {tabBar}
      <div className="flex items-center gap-2 mb-4">
        <MessageSquare className="w-5 h-5 text-indigo-500" />
        <h1 className="text-xl font-bold text-text-primary">Messaging</h1>
      </div>
      <p className="text-sm text-text-muted mb-4">
        Your conversations with people you&apos;ve traded with. Each person keeps one thread across all your trades.
      </p>

      {/* Find-by-username — starts a new conversation even without a shared trade. */}
      <div className="relative mb-4">
        <Search className="w-4 h-4 text-text-muted absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find someone by name or username…"
          className="w-full rounded-lg border border-border bg-surface pl-9 pr-9 py-2.5 text-sm focus:outline-none focus:border-primary"
        />
        {query && (
          <button onClick={() => setQuery('')} aria-label="Clear search" className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary">
            <X className="w-4 h-4" />
          </button>
        )}
        {results !== null && (
          <div className="absolute z-20 mt-1 w-full rounded-lg border border-border bg-surface shadow-card max-h-72 overflow-y-auto">
            {searching ? (
              <p className="text-xs text-text-muted px-3 py-3">Searching…</p>
            ) : results.length === 0 ? (
              isOwnUsername(query, user?.username) ? (
                <div className="px-3 py-3">
                  <p className="text-xs text-text-muted">That&apos;s your own username — you can&apos;t start a chat with yourself.</p>
                  <button
                    onClick={() => void openMyNotes()}
                    disabled={openingNotes}
                    className="mt-1.5 text-xs font-semibold text-primary hover:underline disabled:opacity-50"
                  >
                    {openingNotes ? 'Opening…' : 'Open My Notes →'}
                  </button>
                </div>
              ) : (
                <p className="text-xs text-text-muted px-3 py-3">No one found with that username.</p>
              )
            ) : (
              results.map((u) => (
                <button
                  key={u.id}
                  onClick={() => u.username && startWith(u.username)}
                  disabled={starting === u.username}
                  className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-surface-alt disabled:opacity-50 text-left"
                >
                  <UserAvatar name={u.fullName || u.username || 'User'} avatarUrl={u.avatarUrl} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-text-primary truncate">{u.fullName || u.username}</span>
                    {u.username && <span className="block text-xs text-text-muted truncate">@{u.username}</span>}
                  </span>
                  <span className="text-xs font-medium text-primary flex-shrink-0">{starting === u.username ? 'Opening…' : 'Message'}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Official RupChain channel — pinned at the top; opens the full-page support
          thread so it behaves like the trader threads below (not a floating popup). */}
      <Link
        href="/messages/support"
        className="w-full flex items-center gap-3 p-3 mb-2 rounded-lg bg-primary/5 border border-primary/30 hover:border-primary/50 transition-colors text-left"
      >
        <span className="w-10 h-10 rounded-full bg-primary/15 flex items-center justify-center flex-shrink-0">
          <Headphones className="w-5 h-5 text-primary" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="font-semibold text-text-primary">RupChain Official</span>
            <BadgeCheck className="w-4 h-4 text-sky-500" aria-label="Verified" />
          </div>
          <p className="text-xs text-text-muted truncate mt-0.5">Support &amp; account help — tap to chat with our team.</p>
        </div>
      </Link>

      {/* My Notes — a private, self-only thread (Saved Messages style) for jotting
          things down or holding onto text. Shows your own username since this is
          also the "who am I" surface people were reaching for in the share-username
          menu. */}
      <button
        onClick={() => void openMyNotes()}
        disabled={openingNotes}
        className="w-full flex items-center gap-3 p-3 mb-4 rounded-lg bg-surface border border-border hover:border-primary/40 transition-colors text-left disabled:opacity-60"
      >
        <UserAvatar name={user?.fullName || user?.username || 'You'} avatarUrl={user?.avatarUrl ?? null} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-text-primary">My Notes</span>
            <FileText className="w-3.5 h-3.5 text-text-muted" />
          </div>
          <p className="text-xs text-text-muted truncate mt-0.5">
            {user?.username ? `@${user.username} · private notes only you can see` : 'Private notes only you can see'}
          </p>
        </div>
        {openingNotes && <span className="text-xs font-medium text-text-muted flex-shrink-0">Opening…</span>}
      </button>

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
                    <p className="text-xs text-text-muted truncate mt-0.5 flex items-center gap-1">
                      <LastMessageTick status={t.lastMessageStatus} />
                      <span className="truncate">{t.lastMessagePreview ?? `${t.totalTrades} trade${t.totalTrades === 1 ? '' : 's'} together`}</span>
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

type MainTab = 'messages' | 'channels'

/** Shared tab bar between the DM inbox and the Telegram-style broadcast Channels
 *  tab. `channelsEnabled` hides the Channels button entirely while the admin
 *  kill switch (`channels_enabled`) is off — same convention as messaging's own
 *  `.enabled` gate — instead of showing a tab that always 404s when tapped. */
function MessagesTabBar({ activeTab, setTab, channelsEnabled }: { activeTab: MainTab; setTab: (t: MainTab) => void; channelsEnabled: boolean }) {
  const items: { id: MainTab; label: string; Icon: typeof MessageSquare }[] = [
    { id: 'messages', label: 'Messages', Icon: MessageSquare },
    ...(channelsEnabled ? [{ id: 'channels' as const, label: 'Channels', Icon: Radio }] : []),
  ]
  if (items.length < 2) return null
  return (
    <div className="flex gap-1 bg-surface border border-border rounded-xl p-1 mb-4">
      {items.map(({ id, label, Icon }) => (
        <button
          key={id}
          onClick={() => setTab(id)}
          className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
            activeTab === id ? 'bg-primary text-white shadow-sm' : 'text-text-muted hover:text-text-primary hover:bg-surface-alt'
          }`}
        >
          <Icon size={15} aria-hidden />
          {label}
        </button>
      ))}
    </div>
  )
}

function ChannelsPageTab({ tabBar, mine, reloadMine }: { tabBar: React.ReactNode; mine: MyChannel[]; reloadMine: () => void }) {
  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      {tabBar}
      <ChannelsTab mine={mine} reloadMine={reloadMine} />
    </div>
  )
}

function MessagesInboxInner() {
  const { user } = useAuth()
  const searchParams = useSearchParams()
  const router = useRouter()
  const rawTab = searchParams.get('tab')
  const activeTab: MainTab = rawTab === 'channels' ? 'channels' : 'messages'

  // Channels lives INSIDE the Messages surface, so it must also respect the
  // broader messaging_inbox_enabled kill switch, not just its own — otherwise
  // disabling messaging leaves /messages?tab=channels fully reachable and
  // functional, which contradicts what that flag is documented to do (hide the
  // whole inbox). MessagesListTab enforces this too (redirects to /dashboard),
  // but that check never runs on the channels branch below unless it's also
  // checked here.
  const [messagingEnabled, setMessagingEnabled] = useState(true)
  useEffect(() => {
    if (!user) return
    messagingApi.getSummary().then((s) => setMessagingEnabled(s.enabled)).catch(() => {})
  }, [user])

  // Fetched once here (not again inside ChannelsTab) — this single call both
  // decides whether the Channels tab should even be shown (a 404 means the
  // admin kill switch is off) and supplies its "My channels" list, so opening
  // the tab doesn't re-issue the identical GET /channels request.
  const [mine, setMine] = useState<MyChannel[] | null>(null)
  const [mineError, setMineError] = useState<string | null>(null)
  const [channelsEnabled, setChannelsEnabled] = useState(true)
  const reloadMine = useCallback(() => {
    setMineError(null)
    channelsApi.listMine()
      .then((data) => { setMine(data); setChannelsEnabled(true) })
      .catch((e) => {
        // A 404 means the admin kill switch is off — hide the tab, not an error.
        // Anything else (network blip, 5xx) is a real failure: keep the tab
        // visible but surface a retry instead of leaving Channels spinning
        // forever with `mine` stuck at null.
        if (e instanceof ApiError && e.status === 404) { setChannelsEnabled(false); return }
        setMineError(e instanceof Error ? e.message : 'Failed to load channels')
      })
  }, [])
  useEffect(() => { if (user) reloadMine() }, [user, reloadMine])

  const setTab = (tab: MainTab) => {
    const params = new URLSearchParams(searchParams.toString())
    if (tab === 'messages') params.delete('tab')
    else params.set('tab', tab)
    router.replace(`/messages${params.size ? `?${params}` : ''}`)
  }

  // Either kill switch flipped off while this tab was already open — bounce
  // back to Messages instead of leaving the Channels UI stranded.
  useEffect(() => {
    if (!(channelsEnabled && messagingEnabled) && activeTab === 'channels') router.replace('/messages')
  }, [channelsEnabled, messagingEnabled, activeTab, router])

  const showChannelsTab = channelsEnabled && messagingEnabled
  const tabBar = <MessagesTabBar activeTab={activeTab} setTab={setTab} channelsEnabled={showChannelsTab} />
  if (activeTab !== 'channels' || !showChannelsTab) return <MessagesListTab tabBar={tabBar} />
  if (mineError) return <div className="max-w-2xl mx-auto px-4 py-6">{tabBar}<ErrorState description={mineError} onRetry={reloadMine} /></div>
  if (!mine) return <div className="max-w-2xl mx-auto px-4 py-6">{tabBar}<LoadingState /></div>
  return <ChannelsPageTab tabBar={tabBar} mine={mine} reloadMine={reloadMine} />
}

export default function MessagesInboxPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <MessagesInboxInner />
    </Suspense>
  )
}
