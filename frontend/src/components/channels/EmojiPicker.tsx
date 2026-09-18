'use client'
import { useRef, useState } from 'react'
import { AnchoredMenu } from '@/components/ui/AnchoredMenu'
import { Smile } from 'lucide-react'

// A small curated grid — no emoji-picker package needed (zero extra bundle/
// backend cost), just literal unicode characters inserted into the draft text.
const EMOJIS = [
  '😀', '😂', '😍', '🥳', '😎', '🤔', '😅', '😭',
  '👍', '👎', '🙏', '👏', '🔥', '🎉', '💯', '✅',
  '❌', '⚠️', '📈', '📉', '💰', '🚀', '⭐', '❤️',
]

/** Inserts an emoji at the caret position of the given textarea/input ref. */
export function insertAtCursor(el: HTMLTextAreaElement | HTMLInputElement, text: string, emoji: string): { next: string; caret: number } {
  const start = el.selectionStart ?? text.length
  const end = el.selectionEnd ?? text.length
  const next = text.slice(0, start) + emoji + text.slice(end)
  return { next, caret: start + emoji.length }
}

export function EmojiPicker({ onPick, disabled }: { onPick: (emoji: string) => void; disabled?: boolean }) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-label="Add emoji"
        aria-expanded={open}
        className={`p-2 rounded-full text-text-muted hover:text-primary hover:bg-muted transition-colors disabled:opacity-50 ${open ? 'bg-muted text-primary' : ''}`}
      >
        <Smile className="w-5 h-5" />
      </button>
      <AnchoredMenu anchorRef={anchorRef} open={open} onClose={() => setOpen(false)} width={264} gap={8}>
        <div className="bg-surface border border-border rounded-xl shadow-card p-2 grid grid-cols-8 gap-1">
          {EMOJIS.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => { onPick(e); setOpen(false) }}
              className="text-lg leading-none p-1.5 rounded hover:bg-surface-alt"
            >
              {e}
            </button>
          ))}
        </div>
      </AnchoredMenu>
    </>
  )
}
