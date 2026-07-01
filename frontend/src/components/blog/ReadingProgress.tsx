'use client'

import { useEffect, useState } from 'react'

/**
 * Slim reading-progress bar pinned to the very top of the viewport. Fills left
 * → right as the reader scrolls the article, so the header line doubles as a
 * "how much is left" indicator. Passive scroll listener + rAF throttle keep it
 * cheap; the width is CSS-transitioned so it glides rather than jumps.
 */
export function ReadingProgress() {
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    let raf = 0
    const update = () => {
      raf = 0
      const doc = document.documentElement
      const scrollable = doc.scrollHeight - doc.clientHeight
      const pct = scrollable > 0 ? (doc.scrollTop / scrollable) * 100 : 0
      setProgress(Math.min(100, Math.max(0, pct)))
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
  }, [])

  return (
    <div className="fixed top-0 left-0 right-0 z-[60] h-1 bg-transparent pointer-events-none" aria-hidden>
      <div
        className="h-full bg-gradient-to-r from-primary via-blue-400 to-primary transition-[width] duration-150 ease-out"
        style={{ width: `${progress}%` }}
      />
    </div>
  )
}
