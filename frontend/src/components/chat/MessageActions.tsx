'use client'
import { useState } from 'react'
import { Copy, Check, Reply, X } from 'lucide-react'
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

/** Copy + Reply hover actions that sit beside a bubble. */
export function MessageActions({
  body,
  onReply,
  className = '',
}: {
  body: string
  onReply?: () => void
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const btn = 'p-1 rounded-full text-text-muted hover:text-primary hover:bg-muted transition-colors flex-shrink-0'
  return (
    <div className={`flex items-center sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100 transition-opacity ${className}`}>
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
