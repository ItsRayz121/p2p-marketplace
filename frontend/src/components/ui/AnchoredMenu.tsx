'use client'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

// useLayoutEffect warns during SSR; fall back to useEffect on the server.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

interface Pos {
  left: number
  width: number
  top?: number
  bottom?: number
  maxH: number
}

/**
 * A dropdown surface that is anchored to `anchorRef` but rendered in a
 * `document.body` portal, so it ESCAPES any ancestor `overflow` clip — notably a
 * modal's scrollable body, where a plain `position: absolute` menu gets cut off
 * and forces the user to scroll the modal to reach the options.
 *
 * Behaviour:
 *  - Positioned `fixed` at the anchor's viewport rect; matches the anchor width.
 *  - Flips above the anchor when there isn't room below, and caps its height to
 *    the available space (it scrolls internally past that).
 *  - Re-measures on scroll (capture, so ANY scrolling ancestor counts) + resize.
 *  - Closes on outside click (anchor + menu both count as "inside") and Escape.
 *
 * Radix note: because the menu lives outside the Dialog's DOM subtree, we stop
 * propagation of pointer/mouse/touch-down on it. Radix's DismissableLayer listens
 * for `pointerdown` on `document` (bubble phase) to auto-close the dialog on an
 * outside interaction; stopping propagation here keeps a click on the menu from
 * bubbling up and tearing the whole modal down.
 */
export function AnchoredMenu({
  anchorRef,
  open,
  onClose,
  children,
  gap = 4,
  desiredMaxH = 288,
}: {
  anchorRef: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  children: ReactNode
  gap?: number
  desiredMaxH?: number
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<Pos | null>(null)

  const measure = useCallback(() => {
    const el = anchorRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom
    const spaceAbove = r.top
    // Prefer opening downward; flip up only when there's clearly more room above.
    const openUp = spaceBelow < Math.min(desiredMaxH, 200) && spaceAbove > spaceBelow
    const maxH = Math.max(120, Math.min(desiredMaxH, (openUp ? spaceAbove : spaceBelow) - gap - 8))
    setPos(
      openUp
        ? { left: r.left, width: r.width, bottom: window.innerHeight - r.top + gap, maxH }
        : { left: r.left, width: r.width, top: r.bottom + gap, maxH },
    )
  }, [anchorRef, gap, desiredMaxH])

  // Measure synchronously before paint so the menu never flashes at (0,0).
  useIsomorphicLayoutEffect(() => {
    if (open) measure()
    else setPos(null)
  }, [open, measure])

  useEffect(() => {
    if (!open) return
    const onScrollOrResize = () => measure()
    // capture: true → we hear scrolls on ANY ancestor (e.g. the modal body), not
    // just the window, so the menu tracks the anchor as the modal scrolls.
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (anchorRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, measure, onClose, anchorRef])

  if (!open || !pos || typeof document === 'undefined') return null

  const stop = (e: React.SyntheticEvent) => e.stopPropagation()

  return createPortal(
    <div
      ref={menuRef}
      onMouseDown={stop}
      onPointerDown={stop}
      onTouchStart={stop}
      style={{
        position: 'fixed',
        left: pos.left,
        width: pos.width,
        ...(pos.top != null ? { top: pos.top } : { bottom: pos.bottom }),
        maxHeight: pos.maxH,
        zIndex: 60, // above Modal's Dialog.Content (z-50) and Overlay (z-40)
      }}
      className="overflow-hidden"
    >
      {children}
    </div>,
    document.body,
  )
}
