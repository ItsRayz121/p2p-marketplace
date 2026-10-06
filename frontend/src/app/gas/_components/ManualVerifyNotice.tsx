'use client'

import { useEffect, useState } from 'react'
import { Moon } from 'lucide-react'
import { availabilityApi } from '@/lib/api'
import type { ManualVerifyStatus } from '@/lib/api'

/**
 * Shown on PKR / exchange payment screens while the admin's manual verification is
 * offline (set in Admin → Config). Informational only — the user can still submit a
 * proof, it simply won't be checked until the team is back. Blockchain payments are
 * auto-verified, so we point people there.
 */
export function ManualVerifyNotice() {
  const [st, setSt] = useState<ManualVerifyStatus | null>(null)

  useEffect(() => {
    availabilityApi.getManualVerifyStatus().then(setSt).catch(() => { /* hide on error */ })
  }, [])

  if (!st?.offline) return null

  return (
    <div role="status" className="flex items-start gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
      <Moon className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <div className="min-w-0 text-xs text-text-secondary">
        <p className="font-semibold text-text-primary">Manual verification is offline{st.resumesAt ? ` until ${st.resumesAt}` : ''}</p>
        <p className="mt-0.5">{st.message}</p>
      </div>
    </div>
  )
}
