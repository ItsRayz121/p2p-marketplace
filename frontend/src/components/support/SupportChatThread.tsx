'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { Send, ImagePlus, X, Trash2 } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useSSE } from '@/hooks/useSSE'
import { supportChatApi, SUPPORT_RATINGS, buildChatTimeline, receiptStatus, type SupportMessage } from '@/lib/supportChat'
import { ChatDivider, SupportRatingChip, SupportSystemNote } from '@/components/support/ChatDivider'
import { RefundAddressForm } from '@/components/support/RefundAddressForm'
import { ReviewNudgeCard } from '@/components/support/ReviewNudgeCard'
import { MessageTicks } from '@/components/chat/MessageTicks'
import { useFileUpload } from '@/hooks/useFileUpload'
import { UploadProgress } from '@/components/ui/UploadProgress'
import { isTrustedImageUrl } from '@/lib/utils'
import { SUPPORT_EMAIL } from '@/lib/contact'
import { fmtTime } from '@/lib/fmt'
import { RichText, FormatToolbar, applyFormat } from '@/components/chat/richText'
import { MessageActions, MessageMenu, type MessageMenuAnchor, ReactionChips, ReplyQuote, ReplyBanner, getReplyRef, type ReplyRef } from '@/components/chat/MessageActions'

// Messages can only be retracted within this window of sending (mirrors backend).
const MESSAGE_DELETE_WINDOW_MS = 15 * 60 * 1000

// A plain user message (text and/or image) the sender may retract — own, not
// deleted, plain text/image, and still inside the delete window.
function canDeleteOwn(m: SupportMessage): boolean {
  if (m.sender !== 'user' || m.deletedAt || (m.kind && m.kind !== 'text')) return false
  return Date.now() - new Date(m.createdAt).getTime() < MESSAGE_DELETE_WINDOW_MS
}

/**
 * The support conversation body: messages timeline + satisfaction prompt + composer.
 * Fills its parent (flex-col, h-full) so it drops cleanly into either the floating
 * popup (SupportChatWidget) or the full-page thread (/messages/support). All the
 * fetch / SSE / send / rate logic lives here so both surfaces stay in sync. It
 * assumes it's only mounted while visible, so it loads + marks read on mount.
 */
export function SupportChatThread() {
  const { isAuthenticated } = useAuth()
  const [messages, setMessages] = useState<SupportMessage[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [rating, setRating] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const draftRef = useRef<HTMLTextAreaElement>(null)
  const [replyTo, setReplyTo] = useState<(ReplyRef & { name: string }) | null>(null)
  const [menu, setMenu] = useState<MessageMenuAnchor | null>(null)

  // Pending image attachment — uploaded to Cloudinary the moment it's picked, then
  // sent with the next message (optionally with a caption).
  const [pendingImage, setPendingImage] = useState<string | null>(null)
  const { upload, uploading, progress } = useFileUpload('chat-image')

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

  // Same lookup for a review_nudge's review_ack.
  function reviewAckFor(requestId: string): SupportMessage | null {
    for (const m of messages) {
      if (m.kind === 'review_ack' && (m.metadata?.requestId as string | undefined) === requestId) return m
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

  // Instant delivery: when the backend pushes a support message over SSE, pull
  // the latest thread.
  useSSE(
    useCallback((event: { type: string; payload?: unknown }) => {
      if (event.type !== 'support_message') return
      const scope = (event.payload as { scope?: string } | undefined)?.scope
      if (scope && scope !== 'user') return
      refresh()
    }, [refresh]),
  )

  // Load on mount; light fallback poll (SSE is primary).
  useEffect(() => {
    if (!isAuthenticated) return
    refresh()
    const interval = setInterval(refresh, 20_000)
    return () => clearInterval(interval)
  }, [isAuthenticated, refresh])

  // Mark read + scroll to bottom on mount and whenever messages change.
  useEffect(() => {
    supportChatApi.markRead().catch(() => {})
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  async function handleSend() {
    const text = draft.trim()
    const image = pendingImage
    // A message needs text OR an image.
    if ((!text && !image) || sending) return
    const quoting = replyTo
    setSending(true)
    setDraft('')
    setPendingImage(null)
    setReplyTo(null)
    // Optimistic append
    const optimistic: SupportMessage = {
      id: `tmp-${Date.now()}`,
      sender: 'user',
      body: text,
      attachmentUrl: image,
      metadata: quoting ? { replyTo: { id: quoting.id, sender: quoting.sender, preview: quoting.preview, hasImage: quoting.hasImage } } : null,
      createdAt: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, optimistic])
    setStatus('open') // sending reopens the conversation — drop any stale closed marker
    try {
      await supportChatApi.send(text, image ?? undefined, quoting?.id)
      await refresh()
    } catch {
      setDraft(text)
      setPendingImage(image)
      setReplyTo(quoting)
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id))
    } finally {
      setSending(false)
    }
  }

  // Pick + upload an image; the returned URL waits in pendingImage until send.
  async function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    try {
      setPendingImage(await upload(file))
    } catch {
      /* useFileUpload surfaces the error; nothing to attach */
    }
  }

  // Optimistic reaction: apply locally, then reconcile with the server's summary.
  async function reactTo(id: string, emoji: string) {
    const apply = (list: { emoji: string; count: number; mine: boolean }[], e: string) => {
      const mineNow = list.find((r) => r.mine)
      let next = list.map((r) => (r.mine ? { ...r, count: r.count - 1, mine: false } : r)).filter((r) => r.count > 0)
      if (mineNow?.emoji !== e) {
        const hit = next.find((r) => r.emoji === e)
        next = hit ? next.map((r) => (r.emoji === e ? { ...r, count: r.count + 1, mine: true } : r)) : [...next, { emoji: e, count: 1, mine: true }]
      }
      return next
    }
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, reactions: apply(m.reactions ?? [], emoji) } : m)))
    try {
      const r = await supportChatApi.reactMessage(id, emoji)
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, reactions: r.reactions } : m)))
    } catch {
      await refresh()
    }
  }

  // Retract one of the user's own messages (soft delete → tombstone).
  async function handleDelete(id: string) {
    if (!window.confirm('Delete this message? It will be removed for the support team too.')) return
    // Optimistic tombstone.
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, deletedAt: new Date().toISOString(), body: '', attachmentUrl: null } : m)))
    try {
      await supportChatApi.deleteMessage(id)
      await refresh()
    } catch {
      await refresh() // reconcile on failure
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

  return (
    <div className="flex flex-col h-full min-h-0 bg-canvas">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
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
            ) : item.msg.kind === 'review_nudge' ? (
              <ReviewNudgeCard
                key={item.key}
                request={item.msg}
                answer={reviewAckFor(item.msg.id)}
                onSubmitted={(msg) => setMessages((prev) => [...prev, msg])}
              />
            ) : item.msg.kind === 'review_ack' ? (
              // Rendered inside the nudge card's "answered" state — skip the standalone bubble.
              null
            ) : item.msg.sender === 'system' ? (
              item.msg.rating != null ? (
                <SupportRatingChip key={item.key} rating={item.msg.rating} at={item.msg.createdAt} />
              ) : (
                <SupportSystemNote key={item.key} body={item.msg.body} at={item.msg.createdAt} />
              )
            ) : item.msg.deletedAt ? (
              // Tombstone — the original was retained server-side (admin/dispute view).
              <div key={item.key} className={`flex ${item.msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className="max-w-[80%] px-3 py-2 rounded-2xl text-xs italic text-text-muted bg-muted/60 border border-dashed border-border">
                  🚫 {item.msg.sender === 'user' ? 'You deleted this message' : 'This message was deleted'}
                </div>
              </div>
            ) : (
              <div key={item.key} className={`group flex items-center gap-1.5 ${item.msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                {canDeleteOwn(item.msg) && !item.msg.id.startsWith('tmp-') && (
                  <button
                    onClick={() => handleDelete(item.msg.id)}
                    aria-label="Delete message"
                    className="order-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity p-1 rounded-full text-text-muted hover:text-danger hover:bg-muted flex-shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
                {!item.msg.id.startsWith('tmp-') && (!item.msg.kind || item.msg.kind === 'text') && (
                  <MessageActions
                    body={item.msg.body}
                    className={item.msg.sender === 'user' ? 'order-1' : 'order-3'}
                    onReply={() => setReplyTo({
                      id: item.msg.id,
                      sender: item.msg.sender,
                      name: item.msg.sender === 'user' ? 'You' : 'Support',
                      preview: item.msg.body.slice(0, 120),
                      hasImage: !!item.msg.attachmentUrl,
                    })}
                  />
                )}
                <div className={`order-2 max-w-[80%] flex flex-col gap-1 ${item.msg.sender === 'user' ? 'items-end' : 'items-start'}`}>
                <div
                  onClick={(ev) => {
                    const m = item.msg
                    if (m.id.startsWith('tmp-') || (m.kind && m.kind !== 'text') || !m.body) return
                    if ((ev.target as HTMLElement).closest('a,button')) return
                    const r = ev.currentTarget.getBoundingClientRect()
                    setMenu(menu?.id === m.id ? null : { id: m.id, top: r.top, bottom: r.bottom, mine: m.sender === 'user' })
                  }}
                  className={`${item.msg.body ? 'cursor-pointer ' : ''}px-3 py-2 rounded-2xl text-sm break-words ${
                    item.msg.sender === 'user'
                      ? 'bg-primary text-white rounded-br-sm'
                      : 'bg-surface border border-border text-text-primary rounded-bl-sm'
                  }`}
                >
                  {(() => {
                    const rr = getReplyRef(item.msg.metadata)
                    if (!rr) return null
                    const orig = messages.find((x) => x.id === rr.id)
                    return <ReplyQuote reply={rr} own={item.msg.sender === 'user'} name={rr.sender === 'user' ? 'You' : 'Support'} deleted={!!orig?.deletedAt} />
                  })()}
                  {isTrustedImageUrl(item.msg.attachmentUrl) && (
                    <a href={item.msg.attachmentUrl!} target="_blank" rel="noopener noreferrer" className="block mb-1">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img loading="lazy" decoding="async" src={item.msg.attachmentUrl!} alt="Attachment" className="rounded-lg max-h-64 w-auto max-w-full object-cover" />
                    </a>
                  )}
                  {item.msg.body && <span className="whitespace-pre-wrap"><RichText text={item.msg.body} /></span>}
                  <span className="mt-0.5 flex items-center justify-end gap-1 text-[10px] opacity-70">
                    {fmtTime(item.msg.createdAt)}
                    {item.msg.sender === 'user' && !item.msg.deletedAt && <MessageTicks status={receiptStatus(item.msg)} pending={item.msg.id.startsWith('tmp-')} />}
                  </span>
                </div>
                <ReactionChips reactions={item.msg.reactions ?? []} mine={item.msg.sender === 'user'} onToggle={(e) => void reactTo(item.msg.id, e)} />
                </div>
                {menu?.id === item.msg.id && (
                  <MessageMenu
                    anchor={menu}
                    body={item.msg.body}
                    onClose={() => setMenu(null)}
                    onReact={(e) => void reactTo(item.msg.id, e)}
                    onReply={() => { setReplyTo({ id: item.msg.id, sender: item.msg.sender, name: item.msg.sender === 'user' ? 'You' : 'Support', preview: item.msg.body.slice(0, 120), hasImage: !!item.msg.attachmentUrl }); requestAnimationFrame(() => draftRef.current?.focus()) }}
                  />
                )}
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
      <div className="border-t border-border bg-surface flex-shrink-0">
        {/* Pending image: live upload progress, then a preview thumbnail. */}
        {(pendingImage || uploading) && (
          <div className="px-3 pt-3">
            {uploading && progress ? (
              <UploadProgress progress={progress} />
            ) : pendingImage ? (
              <div className="relative inline-block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img loading="lazy" decoding="async" src={pendingImage} alt="Attachment preview" className="h-20 w-20 rounded-lg border border-border object-cover" />
                <button
                  type="button"
                  onClick={() => setPendingImage(null)}
                  aria-label="Remove image"
                  className="absolute -right-2 -top-2 rounded-full bg-text-primary text-surface p-0.5 shadow"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : null}
          </div>
        )}
        {replyTo && <ReplyBanner reply={replyTo} name={replyTo.name} onCancel={() => setReplyTo(null)} />}
        <FormatToolbar onFormat={(m) => applyFormat(draftRef, draft, setDraft, m)} />
        <div className="flex items-end gap-2 p-3">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={onPickImage}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || sending}
            aria-label="Attach image"
            className="p-2 rounded-full text-text-muted hover:text-primary hover:bg-muted transition-colors disabled:opacity-50 flex-shrink-0"
          >
            <ImagePlus className="w-5 h-5" />
          </button>
          <textarea
            ref={draftRef}
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
            disabled={(!draft.trim() && !pendingImage) || sending || uploading}
            aria-label="Send message"
            className="p-2.5 rounded-xl bg-primary text-white disabled:opacity-40 hover:bg-primary/90 transition-colors flex-shrink-0"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
