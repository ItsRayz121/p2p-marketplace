'use client'

import { useEffect, useRef } from 'react'

const API = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '')

/**
 * Fires a single per-visit view ping for a published post. Lives in the browser
 * (not the ISR-cached server render) so the count reflects actual visits rather
 * than incrementing once per revalidation window. Fire-and-forget: failures are
 * ignored and never surface to the reader.
 */
export function BlogViewPing({ slug }: { slug: string }) {
  const sent = useRef(false)

  useEffect(() => {
    if (sent.current) return
    sent.current = true
    const url = `${API}/api/v1/blog/post/${encodeURIComponent(slug)}/view`
    try {
      // keepalive lets the request complete even if the user navigates away.
      void fetch(url, { method: 'POST', keepalive: true }).catch(() => {})
    } catch {
      // ignore
    }
  }, [slug])

  return null
}
