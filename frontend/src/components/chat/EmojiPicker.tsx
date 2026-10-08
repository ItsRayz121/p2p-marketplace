'use client'
import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { Smile } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Dependency-free, accessible emoji picker for chat composers.
 * Unicode only — emoji are stored as ordinary text in the message body, so storage
 * and rendering need nothing special (all chat columns are UTF-8 text).
 */

const CATEGORIES: { id: string; label: string; icon: string; emojis: string[] }[] = [
  {
    id: 'smileys', label: 'Smileys', icon: '😀',
    emojis: ['😀','😃','😄','😁','😆','😅','😂','🤣','🙂','😉','😊','😇','🥰','😍','🤩','😘','😋','😎','🤗','🤔','🫡','😐','😴','😌','😢','😭','😤','😡','🥺','😱','🤯','😬','🙄','😅','🥳','🤝'],
  },
  {
    id: 'gestures', label: 'Gestures', icon: '👍',
    emojis: ['👍','👎','👌','✌️','🤞','🤝','🙏','👏','🙌','💪','👋','🤙','☝️','👆','👇','👉','👈','✋','🫶','❤️','🧡','💛','💚','💙','💜','🖤','💯','🔥','✨','⭐','🎉','🎊'],
  },
  {
    id: 'status', label: 'Status', icon: '✅',
    emojis: ['✅','☑️','❌','⚠️','❗','❓','⏳','⌛','🕐','🔔','📌','🔒','🔓','🔑','🛡️','🚫','⛔','🔄','➡️','⬆️','⬇️','ℹ️','🆗','🆕','🔴','🟢','🟡','🔵'],
  },
  {
    id: 'money', label: 'Money', icon: '💰',
    emojis: ['💰','💵','💴','💶','💷','💸','💳','🪙','🏦','📈','📉','📊','🧾','💎','⛽','🔗','⚡','🚀','🌐','📱','💻','📎','📷','🖼️','📄','📝','📞','✉️'],
  },
]

const RECENT_KEY = 'rc_recent_emoji'

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((e) => typeof e === 'string').slice(0, 16) : []
  } catch {
    return []
  }
}
function pushRecent(e: string) {
  try {
    const next = [e, ...readRecent().filter((x) => x !== e)].slice(0, 16)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch { /* storage unavailable — recents are a convenience only */ }
}

/** Insert `text` at the textarea caret (replacing any selection) and restore focus + caret. */
export function insertAtCursor(
  ref: RefObject<HTMLTextAreaElement | HTMLInputElement | null>,
  value: string,
  setValue: (v: string) => void,
  text: string,
) {
  const el = ref.current
  const start = el?.selectionStart ?? value.length
  const end = el?.selectionEnd ?? value.length
  setValue(value.slice(0, start) + text + value.slice(end))
  requestAnimationFrame(() => {
    if (!el) return
    el.focus()
    const caret = start + text.length
    el.setSelectionRange(caret, caret)
  })
}

export function EmojiPicker({
  onPick,
  disabled,
  className,
  align = 'left',
}: {
  onPick: (emoji: string) => void
  disabled?: boolean
  className?: string
  /** Which edge of the trigger the popover aligns to. */
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const [cat, setCat] = useState(CATEGORIES[0]!.id)
  const [recent, setRecent] = useState<string[]>([])
  const wrapRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const id = useId()

  useEffect(() => {
    if (!open) return
    setRecent(readRecent())
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function pick(e: string) {
    pushRecent(e)
    onPick(e)
  }

  // Arrow-key navigation inside the emoji grid.
  function onGridKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
    if (!keys.includes(e.key)) return
    const btns = Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>('button[data-emoji]') ?? [])
    const i = btns.indexOf(document.activeElement as HTMLButtonElement)
    if (i < 0) return
    e.preventDefault()
    const cols = 8
    const next = e.key === 'ArrowLeft' ? i - 1 : e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowUp' ? i - cols : i + cols
    btns[Math.max(0, Math.min(btns.length - 1, next))]?.focus()
  }

  const active = CATEGORIES.find((c) => c.id === cat) ?? CATEGORIES[0]!
  const list = active.emojis

  return (
    <div ref={wrapRef} className={cn('relative flex-shrink-0', className)}>
      <button
        type="button"
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()} // keep the textarea caret
        onClick={() => setOpen((o) => !o)}
        aria-label="Insert emoji"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title="Emoji"
        className="p-2 rounded-full text-text-muted hover:text-primary hover:bg-muted transition-colors disabled:opacity-50"
      >
        <Smile className="w-5 h-5" />
      </button>
      {open && (
        <div
          id={id}
          role="dialog"
          aria-label="Emoji picker"
          className={cn(
            'absolute bottom-full mb-2 z-50 w-[min(19rem,calc(100vw-1.5rem))] rounded-xl border border-border bg-surface shadow-xl',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          <div role="tablist" aria-label="Emoji categories" className="flex items-center gap-0.5 border-b border-border px-1.5 py-1">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={cat === c.id}
                aria-label={c.label}
                title={c.label}
                onClick={() => setCat(c.id)}
                className={cn('flex-1 rounded-md py-1 text-lg leading-none transition-colors', cat === c.id ? 'bg-muted' : 'hover:bg-muted/60')}
              >
                {c.icon}
              </button>
            ))}
          </div>
          {recent.length > 0 && (
            <div className="px-2 pt-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-text-muted mb-1">Recent</p>
              <div className="flex flex-wrap gap-0.5">
                {recent.map((e) => (
                  <button key={`r-${e}`} type="button" onClick={() => pick(e)} aria-label={`Insert ${e}`} className="h-8 w-8 rounded-md text-xl leading-none hover:bg-muted">
                    {e}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div ref={gridRef} onKeyDown={onGridKey} className="grid grid-cols-8 gap-0.5 p-2 max-h-48 overflow-y-auto" role="group" aria-label={active.label}>
            {list.map((e, i) => (
              <button
                key={`${active.id}-${i}`}
                type="button"
                data-emoji
                onClick={() => pick(e)}
                aria-label={`Insert ${e}`}
                className="h-8 w-8 rounded-md text-xl leading-none hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
