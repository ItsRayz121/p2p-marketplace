'use client'
import { useState, useEffect, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { gasApi } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { toast } from '@/lib/toast'
import { LoadingState } from '@/components/ui/LoadingState'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/CopyButton'
import { ArrowLeft, Users, Wallet, Gift } from 'lucide-react'

type Summary = Awaited<ReturnType<typeof gasApi.getReferralSummary>>

const PENDING_KEY = 'gas_ref_pending'

function ReferralInner() {
  const router = useRouter()
  const params = useSearchParams()
  const { user } = useAuth()

  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [applied, setApplied] = useState<string | null>(null)

  // Capture an inbound ?ref=CODE so it survives a login round-trip.
  useEffect(() => {
    const ref = params.get('ref')
    if (ref) { try { localStorage.setItem(PENDING_KEY, ref.toUpperCase()) } catch { /* ignore */ } }
  }, [params])

  const load = useCallback(async () => {
    if (!user) { setLoading(false); return }
    setLoading(true)
    try {
      const s = await gasApi.getReferralSummary()
      setSummary(s)
      // Apply a pending referral once, only if the user isn't already bound.
      if (s.enabled && !s.boundToReferrer) {
        let pending: string | null = null
        try { pending = localStorage.getItem(PENDING_KEY) } catch { /* ignore */ }
        if (pending && pending !== s.code) {
          try {
            const r = await gasApi.applyReferral(pending)
            if (r.bound) { setApplied(pending); toast.success('Referral applied — welcome!') }
          } catch { /* invalid/self code — silently ignore */ }
          finally { try { localStorage.removeItem(PENDING_KEY) } catch { /* ignore */ } }
        }
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to load referral info')
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => { void load() }, [load])

  const link = summary?.code ? `${typeof window !== 'undefined' ? window.location.origin : ''}/gas/referral?ref=${summary.code}` : ''

  return (
    <div className="max-w-xl mx-auto px-4 py-6 space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={() => router.push('/gas')} className="p-2 rounded-lg hover:bg-surface-alt"><ArrowLeft className="w-4 h-4" /></button>
        <div className="flex items-center gap-2">
          <Gift className="w-5 h-5 text-primary" />
          <h1 className="text-lg font-bold text-text-primary">Gas Referrals</h1>
        </div>
      </div>

      {loading && <LoadingState message="Loading…" />}

      {!loading && !user && (
        <div className="rounded-xl border border-border bg-surface p-6 text-center space-y-3">
          <p className="text-sm text-text-muted">Log in to get your referral link and track your earnings.</p>
          <Button size="sm" variant="primary" onClick={() => router.push('/login')}>Log in</Button>
        </div>
      )}

      {!loading && user && summary && !summary.enabled && (
        <div className="rounded-xl border border-border bg-surface p-6 text-center text-sm text-text-muted">
          The referral program isn&apos;t live yet. Check back soon.
        </div>
      )}

      {!loading && user && summary && summary.enabled && (
        <>
          {applied && (
            <div className="rounded-xl border border-green-500/40 bg-green-500/5 p-3 text-xs text-green-700 dark:text-green-300">
              You were referred with code <b>{applied}</b>. Your referrer earns a share of the platform fee on your gas orders — at no extra cost to you.
            </div>
          )}

          <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
            <p className="text-xs font-semibold text-text-primary">Your referral link</p>
            <p className="text-xs text-text-muted">
              Earn <b>{summary.referralPct}%</b> of the platform fee on every gas order from people you refer — paid from our fee, not theirs.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate rounded-lg bg-surface-alt px-3 py-2 text-xs">{link}</code>
              <CopyButton text={link} />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-muted">Code</span>
              <span className="font-mono font-bold text-text-primary">{summary.code}</span>
              <CopyButton text={summary.code ?? ''} />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-border bg-surface p-3 text-center">
              <Users className="w-4 h-4 mx-auto text-text-muted" />
              <p className="mt-1 text-lg font-bold text-text-primary">{summary.referredCount}</p>
              <p className="text-[11px] text-text-muted">Referred</p>
            </div>
            <div className="rounded-xl border border-border bg-surface p-3 text-center">
              <Wallet className="w-4 h-4 mx-auto text-text-muted" />
              <p className="mt-1 text-lg font-bold text-primary">${summary.availableUsdt.toFixed(2)}</p>
              <p className="text-[11px] text-text-muted">Available</p>
            </div>
            <div className="rounded-xl border border-border bg-surface p-3 text-center">
              <Gift className="w-4 h-4 mx-auto text-text-muted" />
              <p className="mt-1 text-lg font-bold text-text-primary">${summary.totalAccruedUsdt.toFixed(2)}</p>
              <p className="text-[11px] text-text-muted">Total earned</p>
            </div>
          </div>

          <p className="text-[11px] text-text-muted text-center">Withdrawals open soon. Earnings accrue automatically once your referrals&apos; gas orders are delivered.</p>
        </>
      )}
    </div>
  )
}

export default function GasReferralPage() {
  return (
    <Suspense fallback={<div className="max-w-xl mx-auto px-4 py-10"><LoadingState message="Loading…" /></div>}>
      <ReferralInner />
    </Suspense>
  )
}
