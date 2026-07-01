'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, List } from 'lucide-react'
import type { TocHeading } from '@/lib/blogHeadings'
import { cn } from '@/lib/utils'

/**
 * "On this page" table of contents with scroll-spy. Heading ids are injected
 * server-side (see extractHeadings), so this only tracks which section the
 * reader is in and highlights it; h3s nest under their h2. Rendered in two
 * placements via `variant`: a `mobile` dropdown near the top of the article
 * (animates open), and a `desktop` always-open sticky panel in the sidebar.
 */
export function ArticleToc({ headings, variant }: { headings: TocHeading[]; variant: 'mobile' | 'desktop' }) {
  const [activeId, setActiveId] = useState<string>('')
  const [open, setOpen] = useState(false)
  const clicking = useRef(false)

  useEffect(() => {
    if (headings.length === 0) return
    const ids = headings.map((h) => h.id)

    let raf = 0
    const update = () => {
      raf = 0
      if (clicking.current) return
      const offset = 120
      let current = ids[0] ?? ''
      for (const id of ids) {
        const el = document.getElementById(id)
        if (el && el.getBoundingClientRect().top - offset <= 0) current = id
        else break
      }
      setActiveId(current)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [headings])

  if (headings.length === 0) return null

  const go = (e: React.MouseEvent, id: string) => {
    e.preventDefault()
    const el = document.getElementById(id)
    if (!el) return
    // Set active immediately + briefly suppress the spy so it doesn't flicker
    // through intermediate headings during the smooth scroll.
    clicking.current = true
    setActiveId(id)
    setOpen(false)
    history.replaceState(null, '', `#${id}`)
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    window.setTimeout(() => {
      clicking.current = false
    }, 700)
  }

  const list = (
    <ul className="space-y-0.5 border-l border-border">
      {headings.map((h) => {
        const active = h.id === activeId
        return (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              onClick={(e) => go(e, h.id)}
              className={cn(
                'block -ml-px border-l-2 py-1 text-sm leading-snug transition-colors',
                h.level === 3 ? 'pl-6' : 'pl-3',
                active
                  ? 'border-primary text-primary font-semibold'
                  : 'border-transparent text-text-muted hover:text-text-primary hover:border-border',
              )}
            >
              {h.text}
            </a>
          </li>
        )
      })}
    </ul>
  )

  if (variant === 'desktop') {
    return (
      <nav aria-label="On this page" className="text-sm">
        <p className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-text-secondary">
          <List size={15} className="text-primary" /> On this page
        </p>
        {list}
      </nav>
    )
  }

  const activeLabel = headings.find((h) => h.id === activeId)?.text ?? 'Jump to a section'

  return (
    <nav aria-label="On this page" className="rounded-xl border border-border bg-canvas text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="flex min-w-0 items-center gap-2">
          <List size={15} className="shrink-0 text-primary" />
          <span className="shrink-0 text-xs font-bold uppercase tracking-wide text-text-secondary">On this page</span>
          <span className="truncate text-text-muted">· {activeLabel}</span>
        </span>
        <ChevronDown size={16} className={cn('shrink-0 text-text-muted transition-transform', open && 'rotate-180')} />
      </button>
      <div className={cn('grid transition-all duration-300 ease-out', open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')}>
        <div className="overflow-hidden">
          <div className="px-4 pb-3">{list}</div>
        </div>
      </div>
    </nav>
  )
}
