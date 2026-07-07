'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { apiRequest } from '@/lib/api'
import { fmtPkr } from '@/lib/fmt'
import { ShieldCheck, ShieldAlert, ChevronDown } from 'lucide-react'

interface NoKycStatus {
  verified: boolean
  enabled: boolean
  perTradePkr: number
  dailyUsedPkr: number
  dailyLimitPkr: number
  lifetimeUsedPkr: number
  lifetimeCeilingPkr: number
  openTrades: number
  maxOpenTrades: number
}

/**
 * Shown to UNVERIFIED takers while no-KYC trading is enabled: surfaces their
 * remaining unverified headroom (per-trade / daily / lifetime) and nudges toward
 * KYC. Renders nothing for verified users or when the feature is off.
 */
export function NoKycLimitNotice() {
  const [s, setS] = useState<NoKycStatus | null>(null)
  // Collapsed by default → a single thin line until the user taps to see the
  // per-trade / daily / lifetime breakdown, so it never dominates the page.
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let alive = true
    apiRequest<NoKycStatus>('/trades/nokyc-status')
      .then((d) => { if (alive) setS(d) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  if (!s || s.verified || !s.enabled) return null

  const dailyLeft = Math.max(0, s.dailyLimitPkr - s.dailyUsedPkr)
  const lifetimeLeft = Math.max(0, s.lifetimeCeilingPkr - s.lifetimeUsedPkr)
  const nearLimit = lifetimeLeft <= s.lifetimeCeilingPkr * 0.15 || dailyLeft <= 0

  return (
    <div className={`rounded-lg border text-sm ${nearLimit ? 'border-amber-500/40 bg-amber-500/10' : 'border-border bg-muted'}`}>
      {/* One-line collapsed header */}
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-3 py-2 text-left">
        {nearLimit
          ? <ShieldAlert className="w-4 h-4 text-amber-500 flex-shrink-0" />
          : <ShieldCheck className="w-4 h-4 text-primary flex-shrink-0" />}
        <span className="min-w-0 flex-1 truncate font-medium text-text-primary">
          Trading without verification · up to {fmtPkr(s.perTradePkr)}/trade
        </span>
        <ChevronDown className={`w-4 h-4 text-text-muted flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="px-3 pb-3 pl-9">
          <ul className="text-xs text-text-muted space-y-0.5">
            <li>Up to <span className="font-medium text-text-primary">{fmtPkr(s.perTradePkr)}</span> per trade</li>
            <li>{fmtPkr(dailyLeft)} left today (of {fmtPkr(s.dailyLimitPkr)})</li>
            <li>{fmtPkr(lifetimeLeft)} left before verification is required</li>
            {s.maxOpenTrades > 0 && <li>One trade at a time — finish your current trade to start another</li>}
          </ul>
          <Link href="/kyc" className="inline-block mt-2 text-xs font-semibold text-primary hover:underline">
            Verify your identity to trade more →
          </Link>
        </div>
      )}
    </div>
  )
}
