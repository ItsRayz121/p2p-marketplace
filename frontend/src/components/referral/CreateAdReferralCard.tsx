'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { referralApi } from '@/lib/api'
import { CopyButton } from '@/components/ui/CopyButton'
import { ReferralLinks } from '@/components/referral/ReferralLinks'
import { Gift, ChevronDown } from 'lucide-react'

// Collapsible referral nudge shown on the create-ad page: a maker building a listing is a
// great moment to remind them they can earn 5% (USDT) by inviting others. Collapsed by
// default so it never gets in the way of the form; expands to reveal the share links.
export function CreateAdReferralCard() {
  const [code, setCode] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    referralApi.getStats()
      .then((s) => setCode(s.referralCode))
      .catch(() => { /* non-critical */ })
  }, [])

  if (!code) return null

  return (
    <div className="mb-6 bg-surface border border-border rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-alt transition-colors"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Gift size={16} className="text-primary" />
          Invite &amp; earn 5% in USDT
        </span>
        <ChevronDown size={18} className={`text-text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 space-y-3 border-t border-border">
          <p className="text-xs text-text-muted">
            Earn 5% of the gas fee from everyone you refer (paid in USDT) — they get 5% off too. Share your link:
          </p>
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted">Code</span>
            <span className="font-mono font-bold tracking-wider text-text-primary">{code}</span>
            <CopyButton text={code} />
          </div>
          <ReferralLinks code={code} />
          <Link href="/referral" className="inline-block text-xs font-medium text-primary hover:underline">
            Manage links &amp; earnings →
          </Link>
        </div>
      )}
    </div>
  )
}
