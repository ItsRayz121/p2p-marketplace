'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, List } from 'lucide-react'
import type { TocHeading } from '@/lib/blogHeadings'
import { cn } from '@/lib/utils'

/**
 * "On this page" table of contents with scroll-spy. Heading ids are injected
 * server-side (see extractHeadings), so this only tracks which section the
 * reader is in and highlights it. h2s render as top-level rows (each with a
 * small square marker so sections read as distinct); their h3s are grouped into
 * a dropdown that is collapsed by default and opens on click. Rendered in two
 * placements via `variant`: a `mobile` dropdown near the top of the article
 * (animates open), and a `desktop` sticky panel in the sidebar.
 */

interface TocNode extends TocHeading {
  children: TocHeading[]
}

// Group each h3 under the h2 that precedes it. A leading h3 with no parent h2
// is promoted to a top-level row so nothing is dropped.
function buildTree(headings: TocHeading[]): TocNode[] {
  const nodes: TocNode[] = []
  for (const h of headings) {
    const last = nodes[nodes.length - 1]
    if (h.level === 2 || !last) nodes.push({ ...h, children: [] })
    else last.children.push(h)
  }
  return nodes
}

export function ArticleToc({ headings, variant }: { headings: TocHeading[]; variant: 'mobile' | 'desktop' }) {
  const [activeId, setActiveId] = useState<string>('')
  const [open, setOpen] = useState(false)
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set())
  const clicking = useRef(false)

  const tree = useMemo(() => buildTree(headings), [headings])

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

  const toggleGroup = (id: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const list = (
    <ul className="space-y-0.5">
      {tree.map((node) => {
        const hasChildren = node.children.length > 0
        const expanded = openGroups.has(node.id)
        const active = node.id === activeId
        const childActive = node.children.some((c) => c.id === activeId)
        return (
          <li key={node.id}>
            <div className="flex items-center gap-1">
              <a
                href={`#${node.id}`}
                onClick={(e) => go(e, node.id)}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm leading-snug transition-colors',
                  active || childActive
                    ? 'text-primary font-semibold'
                    : 'text-text-muted hover:text-text-primary',
                )}
              >
                <span
                  className={cn(
                    'h-2 w-2 shrink-0 rounded-[3px] transition-colors',
                    active || childActive ? 'bg-primary' : 'bg-border',
                  )}
                />
                <span className="truncate">{node.text}</span>
              </a>
              {hasChildren && (
                <button
                  type="button"
                  onClick={() => toggleGroup(node.id)}
                  aria-expanded={expanded}
                  aria-label={expanded ? `Collapse ${node.text}` : `Expand ${node.text}`}
                  className="shrink-0 rounded-md p-1 text-text-muted transition-colors hover:bg-surface-alt hover:text-text-primary"
                >
                  <ChevronRight size={14} className={cn('transition-transform', expanded && 'rotate-90')} />
                </button>
              )}
            </div>

            {hasChildren && (
              <div
                className={cn(
                  'grid transition-all duration-200 ease-out',
                  expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
                )}
              >
                <div className="overflow-hidden">
                  <ul className="ml-3 space-y-0.5 border-l border-border pt-0.5">
                    {node.children.map((c) => {
                      const cActive = c.id === activeId
                      return (
                        <li key={c.id}>
                          <a
                            href={`#${c.id}`}
                            onClick={(e) => go(e, c.id)}
                            className={cn(
                              'block -ml-px border-l-2 py-1 pl-3 text-sm leading-snug transition-colors',
                              cActive
                                ? 'border-primary text-primary font-semibold'
                                : 'border-transparent text-text-muted hover:text-text-primary hover:border-border',
                            )}
                          >
                            {c.text}
                          </a>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              </div>
            )}
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
          <div className="px-2 pb-3">{list}</div>
        </div>
      </div>
    </nav>
  )
}
