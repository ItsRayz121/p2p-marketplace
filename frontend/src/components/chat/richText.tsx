'use client'
import { Fragment, type ReactNode, type RefObject } from 'react'
import { Bold, Italic, Underline, Strikethrough } from 'lucide-react'

// Lightweight chat markup (stored as plain text in the message body):
//   **bold**   __underline__   _italic_   ~strike~
// Rendered via React nodes only — never innerHTML — so a message can't inject markup.

// _italic_ and ~strike~ only match at word edges so snake_case ids / "~5 USDT" are left alone.
const TOKEN = /(\*\*[^*\n]+\*\*|__[^_\n]+__|(?<![A-Za-z0-9])_[^_\n]+_(?![A-Za-z0-9])|(?<![A-Za-z0-9])~[^~\n]+~(?![A-Za-z0-9]))/g

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(TOKEN).map((part, i) => {
    const key = `${keyPrefix}-${i}`
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return <strong key={key}>{renderInline(part.slice(2, -2), key)}</strong>
    if (part.length > 4 && part.startsWith('__') && part.endsWith('__')) return <u key={key}>{renderInline(part.slice(2, -2), key)}</u>
    if (part.length > 2 && part.startsWith('_') && part.endsWith('_')) return <em key={key}>{renderInline(part.slice(1, -1), key)}</em>
    if (part.length > 2 && part.startsWith('~') && part.endsWith('~')) return <s key={key}>{renderInline(part.slice(1, -1), key)}</s>
    return <Fragment key={key}>{part}</Fragment>
  })
}

/** Render a chat body with the formatting markers applied (newlines preserved by the caller's whitespace-pre-wrap). */
export function RichText({ text }: { text: string }) {
  return <>{renderInline(text, 'rt')}</>
}

/** Strip markers → plain text (for copy-to-clipboard and previews). */
export function plainText(text: string): string {
  return text
    .split(TOKEN)
    .map((part) => {
      if (part.length > 4 && ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__')))) return plainText(part.slice(2, -2))
      if (part.length > 2 && ((part.startsWith('_') && part.endsWith('_')) || (part.startsWith('~') && part.endsWith('~')))) return plainText(part.slice(1, -1))
      return part
    })
    .join('')
}

/** Wrap the textarea's current selection (or insert an empty pair) in `marker`. */
export function applyFormat(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  setValue: (v: string) => void,
  marker: string,
) {
  const el = ref.current
  if (!el) return
  const start = el.selectionStart ?? value.length
  const end = el.selectionEnd ?? value.length
  const selected = value.slice(start, end)
  const next = value.slice(0, start) + marker + selected + marker + value.slice(end)
  setValue(next)
  requestAnimationFrame(() => {
    el.focus()
    const caret = selected ? end + marker.length * 2 : start + marker.length
    el.setSelectionRange(selected ? start + marker.length : caret, selected ? end + marker.length : caret)
  })
}

const FORMATS = [
  { marker: '**', label: 'Bold', Icon: Bold },
  { marker: '_', label: 'Italic', Icon: Italic },
  { marker: '__', label: 'Underline', Icon: Underline },
  { marker: '~', label: 'Strikethrough', Icon: Strikethrough },
] as const

/** Small B / I / U / S bar shown above the composer. */
export function FormatToolbar({ onFormat }: { onFormat: (marker: string) => void }) {
  return (
    <div className="flex items-center gap-0.5 px-3 pt-2">
      {FORMATS.map(({ marker, label, Icon }) => (
        <button
          key={label}
          type="button"
          onMouseDown={(e) => e.preventDefault()} // keep textarea selection
          onClick={() => onFormat(marker)}
          aria-label={label}
          title={label}
          className="p-1.5 rounded-md text-text-muted hover:text-primary hover:bg-muted transition-colors"
        >
          <Icon className="w-3.5 h-3.5" />
        </button>
      ))}
    </div>
  )
}

/** Copy text to clipboard with a legacy fallback (non-HTTPS / older webviews). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}
