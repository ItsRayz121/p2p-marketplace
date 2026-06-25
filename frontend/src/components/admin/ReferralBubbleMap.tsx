'use client'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'

// Dependency-free interactive referral "bubble map". Nodes are users (sized by how many
// people they referred); edges point referrer → referred. A Fruchterman-Reingold force
// layout runs once to position the bubbles, then the user can pan (drag background),
// zoom (wheel) and drag individual bubbles. Clicking a bubble opens that user.

export interface GraphNode { id: string; username: string; kycStatus: string; referrals: number; referredById: string | null }
export interface GraphEdge { source: string; target: string }

interface Pos { x: number; y: number }

const W = 900
const H = 620

function runLayout(nodes: GraphNode[], edges: GraphEdge[]): Map<string, Pos> {
  const n = nodes.length
  const pos = new Map<string, Pos>()
  if (n === 0) return pos
  // Deterministic-ish initial placement on a spiral so re-renders are stable.
  nodes.forEach((node, i) => {
    const a = i * 2.399963 // golden angle
    const r = 12 * Math.sqrt(i + 1)
    pos.set(node.id, { x: Math.cos(a) * r, y: Math.sin(a) * r })
  })
  const area = W * H
  const k = Math.sqrt(area / Math.max(1, n)) // ideal edge length
  const iters = n > 500 ? 120 : 260
  let temp = W / 8
  const cool = temp / (iters + 1)
  const disp = new Map<string, Pos>()

  for (let it = 0; it < iters; it++) {
    nodes.forEach((v) => disp.set(v.id, { x: 0, y: 0 }))
    // Repulsion (every pair).
    for (let i = 0; i < n; i++) {
      const v = nodes[i]; const pv = pos.get(v.id)!
      for (let j = i + 1; j < n; j++) {
        const u = nodes[j]; const pu = pos.get(u.id)!
        let dx = pv.x - pu.x, dy = pv.y - pu.y
        let d = Math.hypot(dx, dy)
        if (d < 0.01) { d = 0.01; dx = Math.random() - 0.5; dy = Math.random() - 0.5 }
        const f = (k * k) / d
        const ux = (dx / d) * f, uy = (dy / d) * f
        const dv = disp.get(v.id)!; dv.x += ux; dv.y += uy
        const du = disp.get(u.id)!; du.x -= ux; du.y -= uy
      }
    }
    // Attraction (edges).
    for (const e of edges) {
      const pa = pos.get(e.source); const pb = pos.get(e.target)
      if (!pa || !pb) continue
      let dx = pa.x - pb.x, dy = pa.y - pb.y
      let d = Math.hypot(dx, dy)
      if (d < 0.01) d = 0.01
      const f = (d * d) / k
      const ux = (dx / d) * f, uy = (dy / d) * f
      const da = disp.get(e.source)!; da.x -= ux; da.y -= uy
      const db = disp.get(e.target)!; db.x += ux; db.y += uy
    }
    // Apply with cooling + mild gravity toward center.
    for (const v of nodes) {
      const dv = disp.get(v.id)!; const pv = pos.get(v.id)!
      const d = Math.hypot(dv.x, dv.y) || 0.01
      pv.x += (dv.x / d) * Math.min(d, temp)
      pv.y += (dv.y / d) * Math.min(d, temp)
      pv.x -= pv.x * 0.012
      pv.y -= pv.y * 0.012
    }
    temp -= cool
  }
  return pos
}

function radius(referrals: number): number {
  return 7 + Math.min(26, Math.sqrt(referrals) * 5)
}

export function ReferralBubbleMap({ nodes, edges, onSelect }: { nodes: GraphNode[]; edges: GraphEdge[]; onSelect: (id: string) => void }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [pos, setPos] = useState<Map<string, Pos>>(new Map())
  const [vb, setVb] = useState({ x: -W / 2, y: -H / 2, w: W, h: H })
  const [hover, setHover] = useState<string | null>(null)

  // Drag state held in a ref so pointer move handlers stay cheap.
  const drag = useRef<{ kind: 'pan' | 'node'; id?: string; startX: number; startY: number; origVbX: number; origVbY: number; moved: boolean } | null>(null)
  // Latest viewBox mirrored to a ref so the native (non-passive) wheel handler reads it.
  const vbRef = useRef(vb)
  vbRef.current = vb

  // Zoom via a NATIVE wheel listener registered non-passive — React's onWheel is passive,
  // so preventDefault() there is ignored and the page would scroll while zooming.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault()
      const rect = svg.getBoundingClientRect()
      const v = vbRef.current
      const wx = v.x + ((e.clientX - rect.left) / rect.width) * v.w
      const wy = v.y + ((e.clientY - rect.top) / rect.height) * v.h
      const factor = e.deltaY > 0 ? 1.12 : 0.89
      const nw = Math.max(80, Math.min(8000, v.w * factor))
      const nh = nw * (v.h / v.w)
      setVb({ x: wx - (wx - v.x) * (nw / v.w), y: wy - (wy - v.y) * (nh / v.h), w: nw, h: nh })
    }
    svg.addEventListener('wheel', onWheelNative, { passive: false })
    return () => svg.removeEventListener('wheel', onWheelNative)
  }, [])

  useEffect(() => {
    const laid = runLayout(nodes, edges)
    setPos(laid)
    // Fit the viewBox to the computed layout bounds.
    if (laid.size > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      laid.forEach((p) => { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y) })
      const pad = 60
      const w = Math.max(200, maxX - minX + pad * 2)
      const h = Math.max(160, maxY - minY + pad * 2)
      setVb({ x: minX - pad, y: minY - pad, w, h })
    }
  }, [nodes, edges])

  const toWorld = useCallback((clientX: number, clientY: number): Pos => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return { x: vb.x + ((clientX - rect.left) / rect.width) * vb.w, y: vb.y + ((clientY - rect.top) / rect.height) * vb.h }
  }, [vb])

  const onPointerDown = (e: React.PointerEvent, id?: string) => {
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    drag.current = { kind: id ? 'node' : 'pan', ...(id ? { id } : {}), startX: e.clientX, startY: e.clientY, origVbX: vb.x, origVbY: vb.y, moved: false }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) > 3) d.moved = true
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    if (d.kind === 'pan') {
      const dxWorld = ((e.clientX - d.startX) / rect.width) * vb.w
      const dyWorld = ((e.clientY - d.startY) / rect.height) * vb.h
      setVb((v) => ({ ...v, x: d.origVbX - dxWorld, y: d.origVbY - dyWorld }))
    } else if (d.id) {
      const w = toWorld(e.clientX, e.clientY)
      setPos((prev) => { const next = new Map(prev); next.set(d.id!, w); return next })
    }
  }

  const onPointerUp = (e: React.PointerEvent, id?: string) => {
    const d = drag.current
    drag.current = null
    if (id && d && !d.moved) onSelect(id)
  }

  const sortedNodes = useMemo(() => [...nodes].sort((a, b) => a.referrals - b.referrals), [nodes])

  if (nodes.length === 0) {
    return <div className="rounded-xl border border-border bg-surface p-10 text-center text-sm text-text-muted">No referral relationships to map yet.</div>
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-text-muted">
        <span>{nodes.length} users · {edges.length} referral links — scroll to zoom, drag to pan, drag a bubble to move it, click to open.</span>
        <button onClick={() => { const laid = runLayout(nodes, edges); setPos(laid); setVb({ x: -W / 2, y: -H / 2, w: W, h: H }) }} className="text-primary hover:underline">Reset</button>
      </div>
      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <svg
          ref={svgRef}
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
          className="w-full touch-none select-none"
          style={{ height: 560, cursor: 'grab' }}
          onPointerDown={(e) => onPointerDown(e)}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => onPointerUp(e)}
        >
          {/* Edges */}
          {edges.map((e, i) => {
            const a = pos.get(e.source); const b = pos.get(e.target)
            if (!a || !b) return null
            const hot = hover === e.source || hover === e.target
            return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={hot ? 'var(--color-primary, #6366f1)' : 'currentColor'} className={hot ? '' : 'text-border'} strokeWidth={hot ? 1.6 : 0.8} strokeOpacity={hot ? 0.9 : 0.5} />
          })}
          {/* Nodes (small first so hubs draw on top) */}
          {sortedNodes.map((nd) => {
            const p = pos.get(nd.id)
            if (!p) return null
            const r = radius(nd.referrals)
            const isHub = nd.referrals > 0
            const approved = nd.kycStatus === 'approved'
            return (
              <g
                key={nd.id}
                transform={`translate(${p.x} ${p.y})`}
                onPointerDown={(e) => { e.stopPropagation(); onPointerDown(e, nd.id) }}
                onPointerUp={(e) => { e.stopPropagation(); onPointerUp(e, nd.id) }}
                onPointerEnter={() => setHover(nd.id)}
                onPointerLeave={() => setHover((h) => (h === nd.id ? null : h))}
                style={{ cursor: 'pointer' }}
              >
                <circle
                  r={r}
                  fill={isHub ? 'var(--color-primary, #6366f1)' : '#94a3b8'}
                  fillOpacity={isHub ? 0.85 : 0.6}
                  stroke={approved ? '#10b981' : '#ffffff'}
                  strokeWidth={approved ? 2 : 1}
                />
                {(isHub || hover === nd.id) && (
                  <text textAnchor="middle" y={r + 11} fontSize={Math.max(9, Math.min(13, vb.w < 1200 ? 11 : 9))} className="fill-text-primary" style={{ pointerEvents: 'none' }}>
                    {nd.username}{nd.referrals > 0 ? ` (${nd.referrals})` : ''}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>
      <div className="flex items-center gap-4 text-[11px] text-text-muted">
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full" style={{ background: 'var(--color-primary, #6366f1)' }} /> Inviter (size = # referred)</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full bg-slate-400" /> Referred only</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full border-2 border-emerald-500" /> KYC approved</span>
      </div>
    </div>
  )
}
