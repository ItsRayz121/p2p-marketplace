'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { usePathname } from 'next/navigation'
import { X, Send } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useSSE } from '@/hooks/useSSE'
import { supportChatApi, SUPPORT_CHAT_OPEN_EVENT, SUPPORT_RATINGS, buildChatTimeline, type SupportMessage } from '@/lib/supportChat'
import { ChatDivider, SupportRatingChip, SupportSystemNote } from '@/components/support/ChatDivider'
import { RefundAddressForm } from '@/components/support/RefundAddressForm'
import { SUPPORT_EMAIL } from '@/lib/contact'
import { fmtTime } from '@/lib/fmt'
import { BadgeCheck } from 'lucide-react'

export default function SupportChatWidget() {
  const { isAuthenticated } = useAuth()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<SupportMessage[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [rating, setRating] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // The current (closed) session can be rated once. Scan the trailing block of
  // system notes (e.g. the survey message) from newest: a system message WITH a
  // rating means it's already scored; the first real message ends the session.
  const canRate = (() => {
    if (status !== 'closed') return false
    let sawReal = false
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!
      if (m.sender !== 'system') { sawReal = true; break }
      if (m.rating != null) return false // already rated
    }
    return sawReal
  })()

  // Find the user's submitted answer (if any) for a given refund_request message.
  function answerFor(requestId: string): SupportMessage | null {
    for (const m of messages) {
      if (m.kind === 'refund_response' && (m.metadata?.requestId as string | undefined) === requestId) return m
    }
    return null
  }

  const refresh = useCallback(async () => {
    try {
      const state = await supportChatApi.get()
      setMessages(state.messages)
      setStatus(state.conversation?.status ?? null)
    } catch {
      /* ignore — user may be logged out */
    }
  }, [])

  // Open via global event (e.g. Help page "Live Chat" button)
  useEffect(() => {
    const handler = () => setOpen(true)
    window.addEventListener(SUPPORT_CHAT_OPEN_EVENT, handler)
    return () => window.removeEventListener(SUPPORT_CHAT_OPEN_EVENT, handler)
  }, [])

  // Instant delivery: when the backend pushes a support message over SSE, pull
  // the latest thread. Closed-widget alerts come from the bell notification +
  // web push, so no floating unread dot is needed.
  useSSE(
    useCallback((event: { type: string; payload?: unknown }) => {
      if (event.type !== 'support_message') return
      const scope = (event.payload as { scope?: string } | undefined)?.scope
      if (scope && scope !== 'user') return
      refresh()
    }, [refresh]),
  )

  // Load the thread on mount; fallback poll (SSE is primary) only while open
  useEffect(() => {
    if (!isAuthenticated) return
    refresh()
    if (!open) return
    const interval = setInterval(refresh, 20_000)
    return () => clearInterval(interval)
  }, [isAuthenticated, open, refresh])

  // Mark read + scroll to bottom when opened or messages change
  useEffect(() => {
    if (open) {
      supportChatApi.markRead().catch(() => {})
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
    }
  }, [open, messages])

  async function handleSend() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setDraft('')
    // Optimistic append
    const optimistic: SupportMessage = {
      id: `tmp-${Date.now()}`,
      sender: 'user',
      body: text,
      createdAt: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, optimistic])
    setStatus('open') // sending reopens the conversation — drop any stale closed marker
    try {
      await supportChatApi.send(text)
      await refresh()
    } catch {
      setDraft(text)
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id))
    } finally {
      setSending(false)
    }
  }

  async function handleRate(score: number) {
    if (rating || !canRate) return
    setRating(true)
    // Optimistic: append the rating chip immediately so the prompt disappears.
    const optimistic: SupportMessage = {
      id: `rate-${Date.now()}`,
      sender: 'system',
      body: '',
      rating: score,
      createdAt: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, optimistic])
    try {
      await supportChatApi.rate(score)
      await refresh()
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id))
    } finally {
      setRating(false)
    }
  }

  // Hidden for guests and inside the admin panel (admins reply from the inbox page)
  if (!isAuthenticated || pathname?.startsWith('/admin')) return null

  // No floating launcher — chat opens via openSupportChat() (Help Centre
  // "Live Chat" button and support bell notifications)
  return (
    <>
      {/* Chat panel */}
      {open && (
        <div className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] lg:bottom-5 right-5 z-50 w-[calc(100vw-2.5rem)] sm:w-96 h-[32rem] max-h-[calc(100dvh-7rem)] lg:max-h-[calc(100dvh-2.5rem)] bg-surface border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-primary text-white flex-shrink-0">
            <div>
              <p className="font-semibold text-sm flex items-center gap-1">
                RupChain Official
                <BadgeCheck className="w-4 h-4 text-sky-300" aria-label="Verified" />
              </p>
              <p className="text-xs text-white/70">We typically reply within a few hours</p>
            </div>
            <button onClick={() => setOpen(false)} aria-label="Close chat" className="p-1 hover:bg-white/10 rounded-lg">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 bg-canvas">
            {messages.length === 0 ? (
              <div className="text-center text-text-muted text-sm mt-8 space-y-1">
                <p>👋 Send us a message and our team will reply here.</p>
                <p className="text-xs">Prefer email? {SUPPORT_EMAIL}</p>
              </div>
            ) : (
              buildChatTimeline(messages, { status: status ?? undefined }).map((item) =>
                item.kind !== 'message' ? (
                  <ChatDivider key={item.key} kind={item.kind} at={item.at} />
                ) : item.msg.kind === 'refund_request' ? (
                  <RefundAddressForm
                    key={item.key}
                    request={item.msg}
                    answer={answerFor(item.msg.id)}
                    onSubmitted={(msg) => setMessages((prev) => [...prev, msg])}
                  />
                ) : item.msg.kind === 'refund_response' ? (
                  // Rendered inside the request form's "answered" state — skip the standalone bubble.
                  null
                ) : item.msg.sender === 'system' ? (
                  item.msg.rating != null ? (
                    <SupportRatingChip key={item.key} rating={item.msg.rating} at={item.msg.createdAt} />
                  ) : (
                    <SupportSystemNote key={item.key} body={item.msg.body} at={item.msg.createdAt} />
                  )
                ) : (
                  <div key={item.key} className={`flex ${item.msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[80%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words ${
                        item.msg.sender === 'user'
                          ? 'bg-primary text-white rounded-br-sm'
                          : 'bg-surface border border-border text-text-primary rounded-bl-sm'
                      }`}
                    >
                      {item.msg.body}
                      <span className="block text-[10px] opacity-60 mt-0.5">{fmtTime(item.msg.createdAt)}</span>
                    </div>
                  </div>
                ),
              )
            )}

            {/* Satisfaction prompt — shown once when the session has closed */}
            {canRate && (
              <div className="mt-2 rounded-xl border border-border bg-surface px-3 py-3 text-center space-y-2">
                <p className="text-xs text-text-muted">How was our support?</p>
                <div className="flex items-center justify-center gap-4">
                  {SUPPORT_RATINGS.map((r) => (
                    <button
                      key={r.score}
                      onClick={() => handleRate(r.score)}
                      disabled={rating}
                      aria-label={r.label}
                      className="flex flex-col items-center gap-0.5 disabled:opacity-40 hover:scale-110 transition-transform"
                    >
                      <span className="text-2xl leading-none">{r.emoji}</span>
                      <span className="text-[10px] text-text-muted">{r.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="flex items-end gap-2 p-3 border-t border-border bg-surface flex-shrink-0">
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
              placeholder="Type a message…"
              className="flex-1 resize-none max-h-24 px-3 py-2 text-sm bg-canvas border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary text-text-primary"
            />
            <button
              onClick={handleSend}
              disabled={!draft.trim() || sending}
              aria-label="Send message"
              className="p-2.5 rounded-xl bg-primary text-white disabled:opacity-40 hover:bg-primary/90 transition-colors flex-shrink-0"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </>
  )
}
