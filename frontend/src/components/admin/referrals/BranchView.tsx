'use client'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { pathTo, type Forest } from '@/lib/referralNetwork'
import { cn } from '@/lib/utils'

// Referral Branch: "follow every connection". Compact person cards in columns. The first
// column is top-level inviters, each next column is the people invited by the selected
// card in the column before it, joined by thin curves. Selecting a card follows its
// branch; the breadcrumb walks back through ancestors. Large lists show a page at a time
// and always say how many are not shown.

const PAGE = 12
const MORE = 24

export function BranchView({ forest, selectedId, onSelect, active }: {
  forest: Forest
  selectedId: string | null
  onSelect: (id: string | null) => void
  active: boolean
}) {
  // How many cards each column (keyed by its parent id, '' = top level) shows. Kept here so
  // it survives switching views.
  const [shown, setShown] = useState<Map<string, number>>(new Map())
  const path = useMemo(() => (selectedId ? pathTo(forest, selectedId) : []), [forest, selectedId])

  // Columns: [top-level], then the children of each path element.
  const columns = useMemo(() => {
    const cols: Array<{ parent: string; ids: string[]; selected: string | null }> = [
      { parent: '', ids: forest.roots, selected: path[0] ?? null },
    ]
    path.forEach((id, i) => {
      const kids = forest.children.get(id) ?? []
      if (kids.length) cols.push({ parent: id, ids: kids, selected: path[i + 1] ?? null })
    })
    return cols
  }, [forest, path])

  const wrapRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map())
  const [lines, setLines] = useState<Array<{ d: string; on: boolean }>>([])
  const [box, setBox] = useState({ w: 0, h: 0 })

  const measure = useCallback(() => {
    const wrap = wrapRef.current
    if (!wrap || !active) return
    const wr = wrap.getBoundingClientRect()
    setBox({ w: wrap.scrollWidth, h: wrap.scrollHeight })
    if (window.innerWidth < 768) { setLines([]); return }
    const out: Array<{ d: string; on: boolean }> = []
    columns.forEach((col, i) => {
      const next = columns[i + 1]
      if (!next || !col.selected) return
      const from = cardRefs.current.get(`${i}:${col.selected}`)
      if (!from) return
      const fr = from.getBoundingClientRect()
      const colEl = from.closest('[data-col]') as HTMLElement | null
      const nextColEl = wrap.querySelector(`[data-col="${i + 1}"]`) as HTMLElement | null
      const nr = nextColEl?.getBoundingClientRect()
      const cr = colEl?.getBoundingClientRect()
      if (!nr || !cr || fr.bottom < cr.top || fr.top > cr.bottom) return
      const x1 = fr.right - wr.left + wrap.scrollLeft
      const y1 = fr.top + fr.height / 2 - wr.top
      for (const id of next.ids) {
        const to = cardRefs.current.get(`${i + 1}:${id}`)
        if (!to) continue
        const tr = to.getBoundingClientRect()
        if (tr.bottom < nr.top || tr.top > nr.bottom) continue
        const x2 = tr.left - wr.left + wrap.scrollLeft
        const y2 = tr.top + tr.height / 2 - wr.top
        const mx = (x1 + x2) / 2
        out.push({ d: `M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`, on: id === next.selected })
      }
    })
    setLines(out)
  }, [columns, active])

  useLayoutEffect(() => { measure() }, [measure, shown])
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(() => measure())
    ro.observe(wrap)
    window.addEventListener('resize', measure)
    return () => { ro.disconnect(); window.removeEventListener('resize', measure) }
  }, [measure])

  // Keep the deepest column in view when the path grows.
  useEffect(() => {
    const wrap = wrapRef.current
    if (wrap && active) wrap.scrollTo({ left: wrap.scrollWidth, behavior: 'smooth' })
  }, [path.length, active])

  const limitFor = (parent: string, ids: string[], selected: string | null) => {
    const base = shown.get(parent) ?? PAGE
    const idx = selected ? ids.indexOf(selected) + 1 : 0
    return Math.max(base, idx)
  }

  if (!forest.byId.size) {
    return <div className="rounded-xl border border-border bg-surface p-10 text-center text-sm text-text-muted">No referral relationships to show yet.</div>
  }

  return (
    <div className="rounded-xl border border-border bg-surface-alt/40">
      {/* Breadcrumb: walk back through ancestors */}
      <div className="flex flex-wrap items-center gap-1 border-b border-border bg-surface px-3 py-2 text-xs">
        <button type="button" onClick={() => onSelect(null)} className={cn('rounded px-1.5 py-0.5 font-medium', !selectedId ? 'text-text-primary' : 'text-primary hover:underline')}>All inviters</button>
        {path.map((id, i) => (
          <span key={id} className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3 text-text-muted" aria-hidden />
            <button type="button" onClick={() => onSelect(id)} className={cn('rounded px-1.5 py-0.5 font-medium', i === path.length - 1 ? 'bg-primary/10 text-primary' : 'text-primary hover:underline')}>
              {forest.byId.get(id)?.username}
            </button>
          </span>
        ))}
      </div>

      <div ref={wrapRef} onScroll={measure} className="relative overflow-x-auto p-3">
        <svg className="pointer-events-none absolute left-0 top-0 hidden md:block" width={box.w} height={box.h} aria-hidden>
          {lines.map((l, i) => <path key={i} d={l.d} fill="none" strokeWidth={l.on ? 1.6 : 1} className={l.on ? 'stroke-primary' : 'stroke-slate-300 dark:stroke-slate-600'} />)}
        </svg>
        <div className="relative flex min-w-max flex-col gap-4 md:flex-row md:gap-14 max-md:min-w-0">
          {columns.map((col, i) => {
            const limit = limitFor(col.parent, col.ids, col.selected)
            const visible = col.ids.slice(0, limit)
            const left = col.ids.length - visible.length
            const parentName = col.parent ? forest.byId.get(col.parent)?.username : null
            return (
              <div key={`${i}:${col.parent}`} data-col={i} className="w-full md:w-64 md:flex-shrink-0">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                  {parentName ? `Invited by ${parentName}` : 'Top-level inviters'} · {col.ids.length.toLocaleString()}
                </p>
                <div className="max-h-[420px] space-y-1.5 overflow-y-auto pr-1" onScroll={measure}>
                  {visible.map((id) => {
                    const u = forest.byId.get(id)!
                    const isSel = col.selected === id
                    const last = id === selectedId
                    const net = forest.descendants.get(id) ?? 0
                    return (
                      <button
                        key={id}
                        type="button"
                        ref={(el) => { if (el) cardRefs.current.set(`${i}:${id}`, el); else cardRefs.current.delete(`${i}:${id}`) }}
                        onClick={() => onSelect(id)}
                        aria-pressed={isSel}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-lg border bg-surface px-2.5 py-2 text-left transition-colors hover:bg-surface-alt',
                          isSel ? 'border-primary ring-1 ring-primary/40' : 'border-border',
                          last && 'bg-primary/5',
                        )}
                      >
                        <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold uppercase text-primary">{u.username.charAt(0)}</span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-semibold text-text-primary">{u.username}</span>
                            {u.active === true && <span title="Active: has completed at least one trade" className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-emerald-500" />}
                          </span>
                          <span className="block truncate text-[11px] text-text-muted">
                            {u.referrals.toLocaleString()} direct{net > u.referrals ? ` · ${net.toLocaleString()} in network` : ''}
                          </span>
                        </span>
                        {u.referrals > 0 && <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-text-muted" aria-hidden />}
                      </button>
                    )
                  })}
                  {left > 0 && (
                    <button type="button" onClick={() => setShown((m) => new Map(m).set(col.parent, limit + MORE))}
                      className="w-full rounded-lg border border-dashed border-border bg-surface px-3 py-2 text-xs font-medium text-primary hover:bg-surface-alt">
                      Showing {visible.length.toLocaleString()} of {col.ids.length.toLocaleString()} · show {Math.min(MORE, left)} more
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <p className="border-t border-border bg-surface px-3 py-2 text-[11px] text-text-muted">
        Click a person to follow their branch. Green dot = active (has completed a trade). “in network” counts everyone beneath them in the loaded data.
      </p>
    </div>
  )
}
