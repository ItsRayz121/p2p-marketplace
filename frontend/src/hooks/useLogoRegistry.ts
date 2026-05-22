'use client'
import { useState, useEffect } from 'react'
import type { LogoMap } from '@/lib/logoRegistry'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? ''

// ── Module-level singleton ────────────────────────────────────────────────────
// One fetch per browser session, shared across all components via listeners.
// Components that mount after the fetch completes get the cached value
// synchronously via useState initial value.

let _cache:     LogoMap | null = null
let _cachedAt   = 0
let _fetching   = false
const _listeners = new Set<(m: LogoMap) => void>()
const CACHE_TTL_MS = 5 * 60 * 1000

async function ensureLogos(): Promise<void> {
  if (_cache && Date.now() - _cachedAt < CACHE_TTL_MS) return
  if (_fetching) return
  _fetching = true
  try {
    const res = await fetch(`${API_BASE}/api/v1/logos`, { credentials: 'include' })
    if (!res.ok) return
    const data = (await res.json()) as LogoMap
    _cache    = data
    _cachedAt = Date.now()
    _listeners.forEach((fn) => fn(data))
  } catch {
    // Network error — components fall back to static map silently
  } finally {
    _fetching = false
  }
}

// Kick off the fetch as soon as this module is imported client-side
if (typeof window !== 'undefined') {
  void ensureLogos()
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useLogoRegistry(): LogoMap | null {
  const [logos, setLogos] = useState<LogoMap | null>(_cache)

  useEffect(() => {
    // Already cached — nothing to do
    if (_cache) {
      setLogos(_cache)
      return
    }
    // Register as listener for when fetch completes
    const fn = (m: LogoMap) => setLogos(m)
    _listeners.add(fn)
    void ensureLogos()
    return () => { _listeners.delete(fn) }
  }, [])

  return logos
}

// ── Cache invalidation (call after admin logo uploads) ───────────────────────

export function invalidateLogoCache(): void {
  _cache    = null
  _cachedAt = 0
}
