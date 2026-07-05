'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { apiRequest } from '@/lib/api'
import { fmtPkr } from '@/lib/fmt'
import { ShieldCheck, ShieldAlert } from 'lucide-react'

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
    <div className={`rounded-lg border p-3 text-sm ${nearLimit ? 'border-amber-500/40 bg-amber-500/10' : 'border-border bg-muted'}`}>
      <div className="flex items-start gap-2">
        {nearLimit
          ? <ShieldAlert className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
          : <ShieldCheck className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />}
        <div className="min-w-0 flex-1">
          <p className="font-medium text-text-primary">Trading without verification</p>
          <ul className="text-xs text-text-muted mt-1 space-y-0.5">
            <li>Up to <span className="font-medium text-text-primary">{fmtPkr(s.perTradePkr)}</span> per trade</li>
            <li>{fmtPkr(dailyLeft)} left today (of {fmtPkr(s.dailyLimitPkr)})</li>
            <li>{fmtPkr(lifetimeLeft)} left before verification is required</li>
            {s.maxOpenTrades > 0 && <li>One trade at a time — finish your current trade to start another</li>}
          </ul>
          <Link href="/kyc" className="inline-block mt-2 text-xs font-semibold text-primary hover:underline">
            Verify your identity to trade more →
          </Link>
        </div>
      </div>
    </div>
  )
}
