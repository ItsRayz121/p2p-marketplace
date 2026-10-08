'use client'
import { useEffect, useRef, useState } from 'react'
import { Plus, Star } from 'lucide-react'
import { trustpilotRequestDraft } from '@/lib/trustpilot'

/**
 * "+" shortcut menu for the admin support composer. Each item only INSERTS an
 * editable draft into the composer — nothing is ever sent automatically.
 */
export function ComposerPlusMenu({
  onInsert,
  disabled,
}: {
  /** Replace-or-append the draft text (caller decides how to merge with existing text). */
  onInsert: (text: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const draft = trustpilotRequestDraft()

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
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

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        type="button"
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
        className="p-2 rounded-full text-text-muted hover:text-primary hover:bg-canvas transition-colors disabled:opacity-50"
      >
        <Plus className="w-5 h-5" />
      </button>
      {open && (
        <div role="menu" className="absolute bottom-full left-0 mb-2 z-50 w-64 rounded-xl border border-border bg-surface shadow-xl p-1">
          <button
            type="button"
            role="menuitem"
            disabled={!draft}
            onClick={() => { if (draft) { onInsert(draft); setOpen(false) } }}
            className="w-full flex items-start gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Star className="w-4 h-4 mt-0.5 text-[#00b67a] flex-shrink-0" aria-hidden />
            <span>
              <span className="block text-sm font-medium text-text-primary">Request a Trustpilot review</span>
              <span className="block text-xs text-text-muted">
                {draft ? 'Inserts an editable message — review it, then press Send.' : 'Trustpilot is turned off for this site.'}
              </span>
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
