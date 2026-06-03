'use client'
import { useState, useCallback, useRef, useEffect } from 'react'
import { apiRequest } from '@/lib/api'
import { fmtDateTime } from '@/lib/fmt'
import { usePolling } from '@/hooks/usePolling'
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
  sender: 'user' | 'admin'
  body: string
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

  usePolling(fetchConversations, 8_000)
  usePolling(async () => { if (activeId) await fetchThread(activeId) }, 5_000, activeId !== null)

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
                <div>
                  <p className="font-semibold text-sm text-text-primary">{thread.user.name}</p>
                  <p className="text-xs text-text-muted">{thread.user.email}</p>
                </div>
              </div>

              <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 bg-canvas">
                {thread.messages.map((m) => (
                  <div key={m.id} className={`flex ${m.sender === 'admin' ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[75%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words ${
                        m.sender === 'admin'
                          ? 'bg-primary text-white rounded-br-sm'
                          : 'bg-surface border border-border text-text-primary rounded-bl-sm'
                      }`}
                    >
                      {m.body}
                      <span className="block text-[10px] opacity-60 mt-0.5">{fmtDateTime(m.createdAt)}</span>
                    </div>
                  </div>
                ))}
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
