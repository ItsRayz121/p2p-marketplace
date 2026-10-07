'use client'
import { useEffect, useState } from 'react'
import { makerApi, type MakerStatusView } from '@/lib/makerApi'
import { useAuth } from '@/hooks/useAuth'
import { swrGet, swrSet, userKey } from '@/lib/swrCache'
import { MakerChecklist } from './MakerChecklist'

/**
 * Wraps the create-ad / create-listing forms. With the maker gate OFF (the
 * default) or an eligible user, it renders the form untouched. Otherwise it shows
 * the "Become a maker" checklist in its place.
 *
 * Fails open: if the status call errors, the form still renders and the server
 * enforces the rule when the ad is submitted.
 */
export function MakerGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const key = userKey(user?.id, 'maker-status')
  const [status, setStatus] = useState<MakerStatusView | null>(() => swrGet<MakerStatusView>(key) ?? null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!user) return
    let cancelled = false
    makerApi.getStatus()
      .then((s) => { if (!cancelled) { swrSet(key, s); setStatus(s) } })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [user, key])

  if (!status && !failed) {
    return <div className="max-w-2xl mx-auto px-4 py-12 text-center text-text-muted">Loading…</div>
  }
  if (status && status.gateEnabled && !status.eligible) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-8">
        <MakerChecklist status={status} onChange={(s) => { swrSet(key, s); setStatus(s) }} />
      </div>
    )
  }
  return <>{children}</>
}
