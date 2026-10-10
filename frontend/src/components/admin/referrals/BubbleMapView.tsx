'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation } from 'd3-force'
import { Maximize2, Minus, Plus } from 'lucide-react'
import {
  DEFAULT_CHILD_LIMIT, DEFAULT_ROOT_LIMIT, ROOT_GROUP_KEY, bubbleRadius, pathTo, visibleGraph,
  type Forest, type VisibleNode,
} from '@/lib/referralNetwork'

// Bubble Map: an actual bubble network. Bubble size is a bounded scale of the REAL direct
// referral count. A crowded inviter folds its extra people into one dashed "+N" bubble
// that keeps the exact count and expands on click. Physics (collision + springs) only
// runs while something changes; the map is still when idle.

export interface FissionEvent { id: string; parentId: string | null }

interface SimNode {
  key: string
  kind: 'user' | 'group'
  id: string
  r: number
  direct: number
  x: number; y: number; vx: number; vy: number
  fx?: number | null; fy?: number | null
  spawnAt?: number
  index?: number
}

interface Cam { x: number; y: number; k: number }

const SPAWN_MS = 550
const FLASH_MS = 3500
const GROUP_STEP = 24
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)
const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export function BubbleMapView({
  forest, selectedId, onSelect, active, fission, fissionToken,
}: {
  forest: Forest
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** False while another view is showing: the simulation pauses. */
  active: boolean
  fission: FissionEvent[]
  /** Changes only when a refresh brought genuinely new referrals. */
  fissionToken: number
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 560 })
  const [cam, setCam] = useState<Cam>({ x: 0, y: 0, k: 1 })
  const camRef = useRef(cam); camRef.current = cam
  const [, setVersion] = useState(0)
  const [hover, setHover] = useState<string | null>(null)

  // Expansion state lives here so it survives data refreshes and view switches.
  const [limits, setLimits] = useState<Map<string, number>>(new Map())
  const [rootLimit, setRootLimit] = useState(DEFAULT_ROOT_LIMIT)

  const simRef = useRef<Simulation<SimNode, undefined> | null>(null)
  const nodesRef = useRef<Map<string, SimNode>>(new Map())
  const flashRef = useRef<Map<string, number>>(new Map())
  const userMovedRef = useRef(false)
  const needsFitRef = useRef(true)
  const animUntilRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const fissionRef = useRef<{ events: FissionEvent[]; token: number }>({ events: [], token: 0 })
  fissionRef.current = { events: fission, token: fissionToken }
  const handledToken = useRef(0)

  const vg = useMemo(
    () => visibleGraph(forest, limits, rootLimit, selectedId ? [selectedId] : []),
    [forest, limits, rootLimit, selectedId],
  )

  // ── render scheduling ────────────────────────────────────────────────────────
  const schedule = useCallback(() => {
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      setVersion((v) => v + 1)
      if (Date.now() < animUntilRef.current) schedule()
    })
  }, [])

  const fit = useCallback(() => {
    const nodes = [...nodesRef.current.values()]
    if (!nodes.length || size.w < 50) return
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of nodes) { minX = Math.min(minX, n.x - n.r); minY = Math.min(minY, n.y - n.r); maxX = Math.max(maxX, n.x + n.r); maxY = Math.max(maxY, n.y + n.r + 14) }
    const pad = 36
    const k = Math.max(0.15, Math.min(1.4, (size.w - pad * 2) / Math.max(1, maxX - minX), (size.h - pad * 2) / Math.max(1, maxY - minY)))
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
    setCam({ x: -cx * k, y: -cy * k, k })
  }, [size.w, size.h])

  // ── measure ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // ── simulation lifecycle ────────────────────────────────────────────────────
  useEffect(() => {
    const sim = forceSimulation<SimNode>([])
      .alphaDecay(0.028)
      .velocityDecay(0.5)
      .force('charge', forceManyBody<SimNode>().strength((d) => -35 - d.r * 4).distanceMax(420))
      .force('collide', forceCollide<SimNode>().radius((d) => d.r + 11).strength(1).iterations(3))
      .force('x', forceX<SimNode>(0).strength(0.012))
      .force('y', forceY<SimNode>(0).strength(0.012))
      .force('link', forceLink<SimNode, { source: string | SimNode; target: string | SimNode }>([]).id((d) => d.key).distance((l) => {
        const a = l.source as SimNode, b = l.target as SimNode
        return (a.r ?? 10) + (b.r ?? 10) + 42
      }).strength(0.9))
      .on('tick', schedule)
      .on('end', () => {
        schedule()
        if (needsFitRef.current && !userMovedRef.current) { needsFitRef.current = false; fitRef.current() }
      })
      .stop()
    simRef.current = sim
    const onVis = () => { if (document.hidden) sim.stop(); else if (sim.alpha() > sim.alphaMin()) sim.restart() }
    document.addEventListener('visibilitychange', onVis)
    return () => { document.removeEventListener('visibilitychange', onVis); sim.stop(); simRef.current = null; if (rafRef.current != null) cancelAnimationFrame(rafRef.current) }
  }, [schedule])

  const fitRef = useRef(fit); fitRef.current = fit

  // Reconcile the visible graph into the simulation without recreating it, so positions
  // survive routine refreshes and nothing jumps.
  useEffect(() => {
    const sim = simRef.current
    if (!sim) return
    const map = nodesRef.current
    const keep = new Set(vg.nodes.map((n) => n.key))
    let changed = false
    for (const k of [...map.keys()]) if (!keep.has(k)) { map.delete(k); changed = true }

    const reduced = prefersReducedMotion()
    const { events, token } = fissionRef.current
    const isNewBatch = token !== handledToken.current
    const growing = new Map<string, FissionEvent>()
    if (isNewBatch) {
      handledToken.current = token
      // A burst is not animated bubble by bubble; it just settles in.
      if (events.length <= 12) for (const e of events) growing.set(`u:${e.id}`, e)
    }

    const posOf = (k: string | null) => (k ? map.get(k) : undefined)
    const byKey = new Map<string, VisibleNode>(vg.nodes.map((n) => [n.key, n]))
    const now = Date.now()
    const firstPopulation = map.size === 0
    let rootIndex = [...map.values()].filter((m) => !vg.nodes.find((v) => v.key === m.key)?.parentKey).length

    // Parents before children so a new child can start at its inviter.
    const order = [...vg.nodes].sort((a, b) => depthOf(a.key, byKey) - depthOf(b.key, byKey))
    for (const vn of order) {
      const direct = vn.kind === 'user' ? forest.byId.get(vn.id)?.referrals ?? 0 : 0
      const r = vn.kind === 'group' ? 14 + Math.min(12, Math.log10(1 + (vn.hiddenCount ?? 0)) * 6) : bubbleRadius(direct)
      let sn = map.get(vn.key)
      if (sn) { sn.r = r; sn.direct = direct; continue }
      changed = true
      const parent = posOf(vn.parentKey)
      const ang = Math.random() * Math.PI * 2
      const grow = growing.get(vn.key)
      if (parent) {
        const off = grow && !reduced ? 1 : (parent.r + r + 20)
        sn = { key: vn.key, kind: vn.kind, id: vn.id, r, direct, x: parent.x + Math.cos(ang) * off, y: parent.y + Math.sin(ang) * off, vx: grow && !reduced ? Math.cos(ang) * 2.2 : 0, vy: grow && !reduced ? Math.sin(ang) * 2.2 : 0 }
      } else {
        // Top-level trees start spread on a golden-angle spiral so they don't pile up.
        const n = rootIndex++
        const a = n * 2.399963, rad = 110 * Math.sqrt(n + 0.5)
        sn = { key: vn.key, kind: vn.kind, id: vn.id, r, direct, x: Math.cos(a) * rad, y: Math.sin(a) * rad, vx: 0, vy: 0 }
      }
      if (grow && !reduced) sn.spawnAt = now
      if (grow) flashRef.current.set(vn.key, now + FLASH_MS)
      map.set(vn.key, sn)
    }
    // A new person folded into a group: pulse the group so the change is noticed.
    if (isNewBatch) for (const e of events) {
      const parentKey = e.parentId ? `u:${e.parentId}` : null
      const g = vg.nodes.find((n) => n.kind === 'group' && n.parentKey === parentKey)
      if (g && !growing.has(`u:${e.id}`)) flashRef.current.set(g.key, now + FLASH_MS)
    }

    sim.nodes([...map.values()])
    ;(sim.force('link') as ReturnType<typeof forceLink<SimNode, { source: string | SimNode; target: string | SimNode }>>).links(vg.links.map((l) => ({ source: l.source, target: l.target })))

    if (changed || growing.size) {
      if (firstPopulation && !reduced) {
        // Settle the first layout off-screen so the map opens organised, not as a pile.
        sim.alpha(1)
        for (let i = 0; i < 260; i++) sim.tick()
        sim.alpha(0.02).stop()
        schedule()
        if (needsFitRef.current && !userMovedRef.current) { needsFitRef.current = false; setTimeout(() => fitRef.current(), 0) }
      } else if (reduced) {
        sim.alpha(1)
        for (let i = 0; i < 260; i++) sim.tick()
        sim.stop()
        schedule()
        if (needsFitRef.current && !userMovedRef.current) { needsFitRef.current = false; fitRef.current() }
      } else {
        sim.alpha(Math.max(sim.alpha(), growing.size ? 0.55 : 0.4))
        if (active && !document.hidden) sim.restart()
        if (growing.size) { animUntilRef.current = now + FLASH_MS; schedule() }
      }
    }
    // Bubble data (counts, sizes) may have changed even when the layout didn't, so always redraw.
    schedule()
  }, [vg, forest, schedule, active])

  // Pause everything while another view is showing; refit if the map was never fitted.
  useEffect(() => {
    const sim = simRef.current
    if (!sim) return
    if (!active) { sim.stop(); return }
    if (sim.alpha() > sim.alphaMin() && !document.hidden) sim.restart()
    if (needsFitRef.current && !userMovedRef.current && size.w > 50 && nodesRef.current.size) { needsFitRef.current = false; setTimeout(() => fitRef.current(), 0) }
  }, [active, size.w])

  // ── camera interaction ──────────────────────────────────────────────────────
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map())
  const gesture = useRef<{ kind: 'pan' | 'node' | 'pinch' | null; key?: string; sx: number; sy: number; cam: Cam; moved: boolean; dist?: number }>({ kind: null, sx: 0, sy: 0, cam, moved: false })

  const toWorld = (clientX: number, clientY: number) => {
    const r = wrapRef.current!.getBoundingClientRect()
    const c = camRef.current
    return { x: (clientX - r.left - size.w / 2 - c.x) / c.k, y: (clientY - r.top - size.h / 2 - c.y) / c.k }
  }

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      userMovedRef.current = true
      const r = el.getBoundingClientRect()
      const c = camRef.current
      const sx = e.clientX - r.left, sy = e.clientY - r.top
      const nk = Math.max(0.12, Math.min(4, c.k * (e.deltaY > 0 ? 0.9 : 1.1)))
      const wx = (sx - el.clientWidth / 2 - c.x) / c.k, wy = (sy - el.clientHeight / 2 - c.y) / c.k
      setCam({ k: nk, x: sx - el.clientWidth / 2 - wx * nk, y: sy - el.clientHeight / 2 - wy * nk })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const downBg = (e: React.PointerEvent) => {
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      gesture.current = { kind: 'pinch', sx: 0, sy: 0, cam: camRef.current, moved: true, dist: Math.hypot(a.x - b.x, a.y - b.y) }
    } else gesture.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, cam: camRef.current, moved: false }
  }
  const downNode = (e: React.PointerEvent, key: string) => {
    e.stopPropagation()
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    gesture.current = { kind: 'node', key, sx: e.clientX, sy: e.clientY, cam: camRef.current, moved: false }
  }
  const move = (e: React.PointerEvent) => {
    const g = gesture.current
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (g.kind === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      userMovedRef.current = true
      setCam({ ...g.cam, k: Math.max(0.12, Math.min(4, g.cam.k * (d / (g.dist || d)))) })
      return
    }
    if (!g.kind) return
    if (Math.abs(e.clientX - g.sx) + Math.abs(e.clientY - g.sy) > 4) g.moved = true
    if (g.kind === 'pan' && g.moved) {
      userMovedRef.current = true
      setCam({ ...g.cam, x: g.cam.x + (e.clientX - g.sx), y: g.cam.y + (e.clientY - g.sy) })
    } else if (g.kind === 'node' && g.moved && g.key) {
      const n = nodesRef.current.get(g.key)
      if (!n) return
      const w = toWorld(e.clientX, e.clientY)
      n.fx = w.x; n.fy = w.y
      const sim = simRef.current
      if (sim && !prefersReducedMotion()) sim.alphaTarget(0.25).restart()
      else { n.x = w.x; n.y = w.y; schedule() }
    }
  }
  const up = (e: React.PointerEvent) => {
    const g = gesture.current
    pointers.current.delete(e.pointerId)
    if (g.kind === 'node' && g.key) {
      const n = nodesRef.current.get(g.key)
      if (n) { n.fx = null; n.fy = null }
      const sim = simRef.current
      if (sim) { sim.alphaTarget(0); if (g.moved) { if (prefersReducedMotion()) { sim.alpha(0.6); for (let i = 0; i < 80; i++) sim.tick(); sim.stop(); schedule() } else sim.alpha(0.3).restart() } }
      if (!g.moved && n) activate(n)
    } else if (g.kind === 'pan' && !g.moved) onSelect(null)
    if (pointers.current.size === 0) gesture.current = { kind: null, sx: 0, sy: 0, cam: camRef.current, moved: false }
  }

  const activate = (n: SimNode) => {
    if (n.kind === 'user') { onSelect(n.id); return }
    // Group bubble: reveal more of that inviter's people (or more top-level trees).
    if (n.key === ROOT_GROUP_KEY) setRootLimit((l) => l + GROUP_STEP)
    else setLimits((m) => { const nm = new Map(m); nm.set(n.id, (nm.get(n.id) ?? DEFAULT_CHILD_LIMIT) + GROUP_STEP); return nm })
  }

  const zoomBy = (f: number) => { userMovedRef.current = true; setCam((c) => ({ ...c, k: Math.max(0.12, Math.min(4, c.k * f)) })) }

  // ── highlight sets ──────────────────────────────────────────────────────────
  const hl = useMemo(() => {
    const keys = new Set<string>()
    if (!selectedId) return null
    keys.add(`u:${selectedId}`)
    for (const id of pathTo(forest, selectedId)) keys.add(`u:${id}`)
    for (const l of vg.links) if (l.source === `u:${selectedId}`) keys.add(l.target)
    return keys
  }, [selectedId, forest, vg])

  // ── labels: greedy, collision-free, prioritised ──────────────────────────────
  const nodes = [...nodesRef.current.values()]
  const now = Date.now()
  const labels = (() => {
    const out = new Map<string, { x: number; y: number; text: string }>()
    const fs = 11 / cam.k
    const cands: Array<{ n: SimNode; pri: number; text: string }> = []
    for (const n of nodes) {
      const u = n.kind === 'user' ? forest.byId.get(n.id) : null
      const text = n.kind === 'group' ? `+${(vg.nodes.find((v) => v.key === n.key)?.hiddenCount ?? 0).toLocaleString()} more` : `${u?.username ?? ''}${n.direct > 0 ? ` · ${n.direct}` : ''}`
      let pri = 0
      if (n.kind === 'user' && n.id === selectedId) pri = 1000
      else if (hover === n.key) pri = 900
      else if (hl?.has(n.key)) pri = 500 + n.direct
      else if (n.kind === 'group') pri = 120
      else if (n.direct >= 5) pri = 100 + n.direct
      else if (n.direct >= 2 && cam.k > 0.9) pri = 40 + n.direct
      if (pri > 0) cands.push({ n, pri, text })
    }
    cands.sort((a, b) => b.pri - a.pri)
    const rects: Array<{ x0: number; y0: number; x1: number; y1: number }> = []
    const hit = (a: { x0: number; y0: number; x1: number; y1: number }, b: typeof a) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0
    for (const { n, pri, text } of cands.slice(0, 60)) {
      const w = text.length * fs * 0.58 + 6 / cam.k
      const rect = { x0: n.x - w / 2, x1: n.x + w / 2, y0: n.y + n.r + 2 / cam.k, y1: n.y + n.r + 2 / cam.k + fs * 1.25 }
      const labelClash = rects.some((r) => hit(rect, r))
      // Major referrers, the selection and its neighbours always get a label; minor ones only if they fit.
      const bubbleClash = pri < 100 && nodes.some((o) => o !== n && rect.x0 < o.x + o.r && rect.x1 > o.x - o.r && rect.y0 < o.y + o.r && rect.y1 > o.y - o.r)
      if ((labelClash && pri < 900) || bubbleClash) continue
      rects.push(rect)
      out.set(n.key, { x: n.x, y: rect.y0 + fs, text })
    }
    return { out, fs }
  })()

  const dim = (key: string) => (hl && !hl.has(key) ? 0.28 : 1)

  if (!forest.byId.size) {
    return <div className="rounded-xl border border-border bg-surface p-10 text-center text-sm text-text-muted">No referral relationships to map yet.</div>
  }

  const scaleOf = (n: SimNode) => (n.spawnAt ? easeOut(Math.min(1, (now - n.spawnAt) / SPAWN_MS)) : 1)
  const byKey = nodesRef.current

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-surface-alt/40">
      <div ref={wrapRef} className="h-[460px] w-full touch-none select-none sm:h-[560px]" style={{ cursor: 'grab' }}
        onPointerDown={downBg} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <svg width={size.w} height={size.h} className="block" role="img" aria-label="Referral network bubble map">
          <g transform={`translate(${size.w / 2 + cam.x} ${size.h / 2 + cam.y}) scale(${cam.k})`}>
            {vg.links.map((l) => {
              const a = byKey.get(l.source), b = byKey.get(l.target)
              if (!a || !b) return null
              const flash = (flashRef.current.get(l.target) ?? 0) > now
              const on = hl ? hl.has(l.source) && hl.has(l.target) : false
              return <line key={`${l.source}>${l.target}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={flash || on ? 'rgb(37 99 235)' : 'rgb(148 163 184)'} strokeWidth={(flash ? 2.4 : on ? 1.8 : 1) / cam.k} strokeOpacity={flash || on ? 0.9 : hl ? 0.18 : 0.55} />
            })}
            {nodes.map((n) => {
              const u = n.kind === 'user' ? forest.byId.get(n.id) : null
              const sel = n.kind === 'user' && n.id === selectedId
              const sc = scaleOf(n)
              const flash = (flashRef.current.get(n.key) ?? 0) > now
              const isGroup = n.kind === 'group'
              const hub = n.direct > 0
              return (
                <g key={n.key} transform={`translate(${n.x} ${n.y}) scale(${sc})`} opacity={dim(n.key)} style={{ cursor: 'pointer' }}
                  onPointerDown={(e) => downNode(e, n.key)} onPointerEnter={() => setHover(n.key)} onPointerLeave={() => setHover((h) => (h === n.key ? null : h))}>
                  {(sel || flash) && <circle r={n.r + 5} fill="none" stroke="rgb(37 99 235)" strokeOpacity={flash ? 0.5 : 0.8} strokeWidth={2 / cam.k} />}
                  <circle r={n.r}
                    fill={isGroup ? 'rgb(241 245 249)' : hub ? 'rgb(37 99 235)' : 'rgb(203 213 225)'}
                    fillOpacity={isGroup ? 1 : hub ? 0.88 : 0.9}
                    stroke={isGroup ? 'rgb(100 116 139)' : u?.kycStatus === 'approved' ? 'rgb(16 185 129)' : 'rgb(255 255 255)'}
                    strokeWidth={(isGroup ? 1.4 : u?.kycStatus === 'approved' ? 2 : 1) / cam.k * Math.max(1, cam.k)}
                    strokeDasharray={isGroup ? '4 3' : undefined} />
                  {isGroup && <text textAnchor="middle" dy="0.35em" fontSize={Math.min(12, n.r * 0.8)} className="fill-slate-600" style={{ pointerEvents: 'none', fontWeight: 600 }}>+{vg.nodes.find((v) => v.key === n.key)?.hiddenCount}</text>}
                </g>
              )
            })}
            {[...labels.out.entries()].map(([key, l]) => (
              <text key={`l:${key}`} x={l.x} y={l.y} textAnchor="middle" fontSize={labels.fs} opacity={dim(key)} className="fill-text-primary" style={{ pointerEvents: 'none', paintOrder: 'stroke', stroke: 'var(--color-surface, #fff)', strokeWidth: 3 / cam.k, strokeLinejoin: 'round' }}>
                {l.text}
              </text>
            ))}
          </g>
        </svg>
      </div>

      <div className="absolute right-2 top-2 flex flex-col gap-1">
        <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.25)} className="rounded-md border border-border bg-surface p-1.5 text-text-secondary hover:bg-surface-alt"><Plus className="h-4 w-4" /></button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomBy(0.8)} className="rounded-md border border-border bg-surface p-1.5 text-text-secondary hover:bg-surface-alt"><Minus className="h-4 w-4" /></button>
        <button type="button" aria-label="Fit to view" title="Fit to view" onClick={() => { userMovedRef.current = false; fit() }} className="rounded-md border border-border bg-surface p-1.5 text-text-secondary hover:bg-surface-alt"><Maximize2 className="h-4 w-4" /></button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border bg-surface px-3 py-2 text-[11px] text-text-muted">
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-full bg-blue-600/90" />Inviter (size = direct referrals)</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-full bg-slate-300" />Referred only</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-full border-2 border-emerald-500" />KYC approved</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-full border border-dashed border-slate-500" />+N = folded group, click to expand</span>
      </div>
    </div>
  )
}

function depthOf(key: string, byKey: Map<string, VisibleNode>): number {
  let d = 0
  let cur = byKey.get(key)
  while (cur?.parentKey && d < 10_000) { d++; cur = byKey.get(cur.parentKey) }
  return d
}
