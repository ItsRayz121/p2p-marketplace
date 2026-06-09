'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'

export interface PaletteCommand {
  id: string
  label: string
  group: string
  href: string
  icon?: React.ReactNode
  /** Extra match terms (synonyms) not shown but searchable. */
  keywords?: string
}

interface Props {
  open: boolean
  onClose: () => void
  commands: PaletteCommand[]
}

/**
 * ⌘K / Ctrl+K command palette for the admin panel. Fuzzy-filters every admin
 * destination for fast keyboard navigation, plus a dynamic "search users"
 * action when the query looks like a name / email / id.
 */
export default function CommandPalette({ open, onClose, commands }: Props) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Reset + focus whenever the palette opens.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      // focus after the element is painted
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const results = useMemo<PaletteCommand[]>(() => {
    const q = query.trim().toLowerCase()
    const nav = commands.filter((c) => {
      if (!q) return true
      return (
        c.label.toLowerCase().includes(q) ||
        c.group.toLowerCase().includes(q) ||
        (c.keywords?.toLowerCase().includes(q) ?? false)
      )
    })

    // Dynamic entity action — only when the admin has typed something specific.
    const dynamic: PaletteCommand[] = []
    if (q.length >= 2) {
      dynamic.push({
        id: 'search-users',
        label: `Search users for “${query.trim()}”`,
        group: 'Search',
        href: `/admin/users?search=${encodeURIComponent(query.trim())}`,
        keywords: 'user email username find lookup',
      })
    }
    return [...dynamic, ...nav]
  }, [query, commands])

  // Keep active index in range as results change.
  useEffect(() => { setActive(0) }, [query])

  // Scroll the active row into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  function go(cmd: PaletteCommand | undefined) {
    if (!cmd) return
    onClose()
    router.push(cmd.href)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      go(results[active])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] px-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        className="relative w-full max-w-xl bg-surface rounded-xl shadow-2xl border border-border overflow-hidden"
        role="dialog"
        aria-modal="true"
      >
        {/* Search input */}
        <div className="flex items-center gap-2 px-4 border-b border-border">
          <svg className="w-4 h-4 text-text-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to a page, or search users…"
            className="flex-1 bg-transparent py-3.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
          />
          <kbd className="hidden sm:block text-[10px] text-text-muted border border-border rounded px-1.5 py-0.5">Esc</kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[55vh] overflow-y-auto py-2">
          {results.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-text-muted">No matches</div>
          ) : (
            results.map((cmd, idx) => (
              <button
                key={cmd.id}
                data-idx={idx}
                onClick={() => go(cmd)}
                onMouseMove={() => setActive(idx)}
                className={cn(
                  'w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors',
                  idx === active ? 'bg-primary/10' : 'hover:bg-surface-alt',
                )}
              >
                <span className={cn('flex-shrink-0', idx === active ? 'text-primary' : 'text-text-muted')}>
                  {cmd.icon ?? (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  )}
                </span>
                <span className="flex-1 text-sm text-text-primary truncate">{cmd.label}</span>
                <span className="text-[11px] text-text-muted flex-shrink-0">{cmd.group}</span>
              </button>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-border text-[11px] text-text-muted">
          <span><kbd className="border border-border rounded px-1">↑</kbd> <kbd className="border border-border rounded px-1">↓</kbd> navigate</span>
          <span><kbd className="border border-border rounded px-1">↵</kbd> open</span>
          <span><kbd className="border border-border rounded px-1">esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}
