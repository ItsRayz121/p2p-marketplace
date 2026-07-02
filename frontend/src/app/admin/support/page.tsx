'use client'
import { useState, useCallback, useRef, useEffect } from 'react'
import { apiRequest } from '@/lib/api'
import { fmtDateTime, fmtTime } from '@/lib/fmt'
import { buildChatTimeline } from '@/lib/supportChat'
import { ChatDivider, SupportRatingChip, SupportSystemNote } from '@/components/support/ChatDivider'
import { usePolling } from '@/hooks/usePolling'
import { useSSE } from '@/hooks/useSSE'
import { LoadingState } from '@/components/ui/LoadingState'
import { EmptyState } from '@/components/ui/EmptyState'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { Send } from 'lucide-react'

interface ConversationSummary {
  id: string
  status: string
  unreadByAdmin: boolean
  lastMessageAt: string
  lastMessage: string | null
  user: { id: string; name: string; avatarUrl: string | null }
}

interface ThreadMessage {
  id: string
  sender: 'user' | 'admin' | 'system'
  body: string
  rating?: number | null
  createdAt: string
}

interface Thread {
  id: string
  status: string
  user: { id: string; name: string; email: string; avatarUrl: string | null }
  messages: ThreadMessage[]
}

export default function AdminSupportPage() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [thread, setThread] = useState<Thread | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [closing, setClosing] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const fetchConversations = useCallback(async () => {
    try {
      const data = await apiRequest<ConversationSummary[]>('/admin/support/conversations')
      setConversations(data)
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchThread = useCallback(async (id: string) => {
    const data = await apiRequest<Thread>(`/admin/support/conversations/${id}`)
    setThread(data)
    setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }), 0)
  }, [])

  // SSE is primary; polling is a slower fallback in case a push is missed.
  usePolling(fetchConversations, 15_000)
  usePolling(async () => { if (activeId) await fetchThread(activeId) }, 12_000, activeId !== null)

  // Instant inbox updates when a user sends a message
  useSSE(
    useCallback((event: { type: string; payload?: unknown }) => {
      if (event.type !== 'support_message') return
      fetchConversations()
      const convId = (event.payload as { conversationId?: string } | undefined)?.conversationId
      if (activeId && convId === activeId) fetchThread(activeId)
    }, [fetchConversations, fetchThread, activeId]),
  )

  function openConversation(id: string) {
    setActiveId(id)
    setThread(null)
    fetchThread(id)
    // Optimistically clear unread dot in the list
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, unreadByAdmin: false } : c)))
  }

  async function handleSend() {
    const text = draft.trim()
    if (!text || !activeId || sending) return
    setSending(true)
    setDraft('')
    try {
      await apiRequest(`/admin/support/conversations/${activeId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body: text }),
      })
      await fetchThread(activeId)
    } catch {
      setDraft(text)
    } finally {
      setSending(false)
    }
  }

  async function handleClose() {
    if (!activeId || closing) return
    setClosing(true)
    try {
      await apiRequest(`/admin/support/conversations/${activeId}/close`, { method: 'POST' })
      await Promise.all([fetchThread(activeId), fetchConversations()])
    } catch {
      /* leave state as-is; admin can retry */
    } finally {
      setClosing(false)
    }
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [thread?.messages.length])

  if (loading) return <LoadingState message="Loading support inbox..." />

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-black text-text-primary">Support Chat</h1>
        <p className="text-sm text-text-muted">Reply to users live. New messages appear automatically.</p>
      </div>

      <div className="grid md:grid-cols-[20rem_1fr] gap-4 h-[calc(100vh-12rem)]">
        {/* Conversation list */}
        <div className="bg-surface border border-border rounded-xl overflow-y-auto">
          {conversations.length === 0 ? (
            <EmptyState title="No conversations yet" description="User messages will show up here." />
          ) : (
            conversations.map((c) => (
              <button
                key={c.id}
                onClick={() => openConversation(c.id)}
                className={`w-full text-left px-3 py-3 border-b border-border flex items-start gap-3 hover:bg-canvas transition-colors ${
                  activeId === c.id ? 'bg-canvas' : ''
                }`}
              >
                <UserAvatar name={c.user.name} avatarUrl={c.user.avatarUrl} size="sm" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-sm text-text-primary truncate">{c.user.name}</span>
                    {c.unreadByAdmin && <span className="w-2 h-2 bg-danger rounded-full flex-shrink-0" />}
                  </div>
                  <p className="text-xs text-text-muted truncate">{c.lastMessage ?? 'No messages'}</p>
                  <p className="text-[10px] text-text-muted/70 mt-0.5">{fmtDateTime(c.lastMessageAt)}</p>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Thread */}
        <div className="bg-surface border border-border rounded-xl flex flex-col overflow-hidden">
          {!thread ? (
            <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
              Select a conversation
            </div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-border flex items-center gap-3 flex-shrink-0">
                <UserAvatar name={thread.user.name} avatarUrl={thread.user.avatarUrl} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-sm text-text-primary truncate">{thread.user.name}</p>
                  <p className="text-xs text-text-muted truncate">{thread.user.email}</p>
                </div>
                {thread.status === 'closed' ? (
                  <span className="text-[11px] font-semibold text-text-muted px-2 py-1 rounded-lg bg-canvas border border-border flex-shrink-0">
                    Closed
                  </span>
                ) : (
                  <button
                    onClick={handleClose}
                    disabled={closing}
                    className="text-[11px] font-semibold text-text-muted hover:text-danger px-2 py-1 rounded-lg border border-border hover:border-danger disabled:opacity-40 transition-colors flex-shrink-0"
                  >
                    {closing ? 'Closing…' : 'Close chat'}
                  </button>
                )}
              </div>

              <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 bg-canvas">
                {buildChatTimeline(thread.messages, { status: thread.status }).map((item) =>
                  item.kind !== 'message' ? (
                    <ChatDivider key={item.key} kind={item.kind} at={item.at} />
                  ) : item.msg.sender === 'system' ? (
                    item.msg.rating != null ? (
                      <SupportRatingChip key={item.key} rating={item.msg.rating} at={item.msg.createdAt} />
                    ) : (
                      <SupportSystemNote key={item.key} body={item.msg.body} at={item.msg.createdAt} />
                    )
                  ) : (
                    <div key={item.key} className={`flex ${item.msg.sender === 'admin' ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={`max-w-[75%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words ${
                          item.msg.sender === 'admin'
                            ? 'bg-primary text-white rounded-br-sm'
                            : 'bg-surface border border-border text-text-primary rounded-bl-sm'
                        }`}
                      >
                        {item.msg.body}
                        <span className="block text-[10px] opacity-60 mt-0.5">{fmtTime(item.msg.createdAt)}</span>
                      </div>
                    </div>
                  ),
                )}
              </div>

              <div className="flex items-end gap-2 p-3 border-t border-border flex-shrink-0">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleSend()
                    }
                  }}
                  rows={1}
                  placeholder="Type your reply…"
                  className="flex-1 resize-none max-h-24 px-3 py-2 text-sm bg-canvas border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary text-text-primary"
                />
                <button
                  onClick={handleSend}
                  disabled={!draft.trim() || sending}
                  className="p-2.5 rounded-xl bg-primary text-white disabled:opacity-40 hover:bg-primary/90 transition-colors flex-shrink-0"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
