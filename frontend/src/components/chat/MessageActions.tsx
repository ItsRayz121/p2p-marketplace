'use client'
import { useState } from 'react'
import { Copy, Check, Reply, SmilePlus, X } from 'lucide-react'
import { copyText, plainText } from '@/components/chat/richText'

export interface ReplyRef {
  id: string
  sender: string
  preview: string
  hasImage?: boolean
}

/** Pull the quote-reply snapshot a message was sent with (if any). */
export function getReplyRef(metadata: Record<string, unknown> | null | undefined): ReplyRef | null {
  const r = metadata?.replyTo as ReplyRef | undefined
  return r && typeof r.id === 'string' ? r : null
}

/** The quick-reaction set (must match REACTION_EMOJIS on the backend). */
export const QUICK_REACTIONS = ['👍', '👎', '❤️', '😂', '😮', '😢', '🙏']

/** Copy + Reply (+ optional React) hover actions that sit beside a bubble. */
export function MessageActions({
  body,
  onReply,
  onReact,
  className = '',
}: {
  body: string
  onReply?: () => void
  onReact?: (emoji: string) => void
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const [picking, setPicking] = useState(false)
  const btn = 'p-1 rounded-full text-text-muted hover:text-primary hover:bg-muted transition-colors flex-shrink-0'
  return (
    <div className={`relative flex items-center ${picking ? 'opacity-100' : 'sm:opacity-0 sm:group-hover:opacity-100'} focus-within:opacity-100 transition-opacity ${className}`}>
      {onReact && (
        <>
          <button type="button" onClick={() => setPicking((v) => !v)} aria-label="React" aria-expanded={picking} title="React" className={btn}>
            <SmilePlus className="w-3.5 h-3.5" />
          </button>
          {picking && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setPicking(false)} aria-hidden />
              <div role="menu" aria-label="Pick a reaction" className="absolute bottom-full left-0 z-30 mb-1 flex gap-0.5 rounded-full border border-border bg-surface p-1 shadow-lg">
                {QUICK_REACTIONS.map((e) => (
                  <button
                    key={e}
                    type="button"
                    role="menuitem"
                    onClick={() => { setPicking(false); onReact(e) }}
                    aria-label={`React ${e}`}
                    className="h-8 w-8 rounded-full text-lg leading-none transition-transform hover:scale-125 hover:bg-muted"
                  >
                    {e}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
      {onReply && (
        <button type="button" onClick={onReply} aria-label="Reply" title="Reply" className={btn}>
          <Reply className="w-3.5 h-3.5" />
        </button>
      )}
      {body && (
        <button
          type="button"
          aria-label="Copy message"
          title={copied ? 'Copied' : 'Copy'}
          className={btn}
          onClick={async () => {
            if (await copyText(plainText(body))) {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }
          }}
        >
          {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      )}
    </div>
  )
}

/** Quoted original shown inside a reply bubble. `own` = bubble is the coloured (sent) side. */
export function ReplyQuote({ reply, own, name, deleted }: { reply: ReplyRef; own: boolean; name: string; deleted?: boolean }) {
  return (
    <div
      className={`mb-1 rounded-lg border-l-2 px-2 py-1 text-xs ${
        own ? 'bg-white/15 border-white/70' : 'bg-muted border-primary'
      }`}
    >
      <p className={`font-semibold ${own ? 'text-white' : 'text-primary'}`}>{name}</p>
      <p className={`line-clamp-2 break-words ${own ? 'text-white/80' : 'text-text-muted'} ${deleted ? 'italic' : ''}`}>
        {deleted ? 'Message deleted' : reply.preview || (reply.hasImage ? '📷 Photo' : 'Message')}
      </p>
    </div>
  )
}

/** "Replying to …" strip above the composer. */
export function ReplyBanner({ reply, name, onCancel }: { reply: ReplyRef; name: string; onCancel: () => void }) {
  return (
    <div className="mx-3 mt-2 flex items-start gap-2 rounded-lg border-l-2 border-primary bg-muted px-2 py-1.5">
      <div className="min-w-0 flex-1 text-xs">
        <p className="font-semibold text-primary">Replying to {name}</p>
        <p className="truncate text-text-muted">{reply.preview || (reply.hasImage ? '📷 Photo' : 'Message')}</p>
      </div>
      <button type="button" onClick={onCancel} aria-label="Cancel reply" className="p-0.5 text-text-muted hover:text-text-primary">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

/** Reaction chips under a bubble; tapping one toggles your own reaction. */
export function ReactionChips({ reactions, mine, onToggle }: { reactions: { emoji: string; count: number; mine: boolean }[]; mine: boolean; onToggle: (emoji: string) => void }) {
  if (!reactions.length) return null
  return (
    <div className={`flex flex-wrap gap-1 ${mine ? 'justify-end' : 'justify-start'}`}>
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          onClick={() => onToggle(r.emoji)}
          aria-pressed={r.mine}
          aria-label={`${r.emoji} ${r.count}${r.mine ? ', you reacted' : ''}`}
          className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs leading-none ${r.mine ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-surface text-text-secondary hover:bg-muted'}`}
        >
          <span className="text-sm">{r.emoji}</span>
          {r.count > 1 && <span className="font-medium">{r.count}</span>}
        </button>
      ))}
    </div>
  )
}
