'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { adminApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { toast } from '@/lib/toast'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { ArrowLeft, RefreshCw } from 'lucide-react'

type Affiliate = Awaited<ReturnType<typeof adminApi.getGasAffiliates>>[number]
type EarningRow = Awaited<ReturnType<typeof adminApi.getGasReferrals>>[number]

function fmt(n: number): string { return `$${n.toFixed(2)}` }

function statusVariant(s: string): 'success' | 'warning' | 'danger' | 'default' {
  if (s === 'approved') return 'success'
  if (s === 'pending') return 'warning'
  if (s === 'rejected') return 'danger'
  return 'default'
}

export default function GasAffiliatesAdminPage() {
  const router = useRouter()
  const isSuperAdmin = useAuthStore((s) => s.user?.role === 'super_admin')

  const [affiliates, setAffiliates] = useState<Affiliate[] | null>(null)
  const [earnings, setEarnings] = useState<EarningRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [a, e] = await Promise.all([adminApi.getGasAffiliates(), adminApi.getGasReferrals()])
      setAffiliates(a); setEarnings(e)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load affiliates')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  async function approve(a: Affiliate) {
    const maxMarginPct = Number(window.prompt(`Margin allowance % for ${a.email ?? a.userId}\n(total margin the affiliate may split between buyer discount + commission)`, String(a.maxMarginPct)))
    if (!(maxMarginPct >= 0 && maxMarginPct <= 100)) { toast.error('Margin % must be 0–100'); return }
    const minUserDiscountPct = Number(window.prompt(`Minimum buyer discount % (0–${maxMarginPct})`, String(a.minUserDiscountPct)))
    if (!(minUserDiscountPct >= 0 && minUserDiscountPct <= maxMarginPct)) { toast.error(`Min discount must be 0–${maxMarginPct}`); return }
    const maxLinks = Number(window.prompt('Max number of affiliate links (1–50)', String(a.maxLinks)))
    if (!(Number.isInteger(maxLinks) && maxLinks >= 1 && maxLinks <= 50)) { toast.error('Max links must be 1–50'); return }
    setBusyId(a.userId)
    try {
      await adminApi.reviewGasAffiliate(a.userId, { decision: 'approve', maxMarginPct, minUserDiscountPct, maxLinks })
      toast.success(`${a.email ?? 'Affiliate'} approved`)
      void load()
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Failed to approve') }
    finally { setBusyId(null) }
  }

  async function reject(a: Affiliate) {
    const reason = window.prompt(`Reject ${a.email ?? a.userId}? Optional reason shown to the applicant:`, '')
    if (reason == null) return
    setBusyId(a.userId)
    try {
      await adminApi.reviewGasAffiliate(a.userId, { decision: 'reject', rejectionReason: reason || null })
      toast.success('Application rejected')
      void load()
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Failed to reject') }
    finally { setBusyId(null) }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => router.push('/admin/gas')} className="p-2 rounded-lg hover:bg-surface-alt"><ArrowLeft className="w-4 h-4" /></button>
        <div className="flex-1">
          <h1 className="text-lg font-bold text-text-primary">Gas Affiliates</h1>
          <p className="text-xs text-text-muted">Self-service affiliate applications + KOL income, paid from the platform margin only. Active only when <code>gas_affiliate_enabled</code> is ON.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw className="w-4 h-4" /></Button>
      </div>

      {loading && <LoadingState message="Loading affiliates..." />}
      {error && !loading && <ErrorState description={error} onRetry={load} />}

      {!loading && !error && (
        <>
          {/* Applications + approved affiliates */}
          <section className="space-y-3">
            <h2 className="text-sm font-bold text-text-primary">Applications</h2>
            {affiliates && affiliates.length === 0 && (
              <div className="rounded-xl border border-border bg-surface p-8 text-center text-sm text-text-muted">No affiliate applications yet.</div>
            )}
            {affiliates && affiliates.map((a) => (
              <div key={a.userId} className="rounded-xl border border-border bg-surface p-4">
                <div className="flex items-start gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-text-primary truncate">{a.email ?? a.userId}</span>
                      <Badge variant={statusVariant(a.status)}>{a.status}</Badge>
                    </div>
                    {a.socials && Object.keys(a.socials).length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {Object.entries(a.socials).map(([k, v]) => (
                          <span key={k} className="text-xs bg-surface-alt rounded-full px-2.5 py-0.5 text-text-secondary"><span className="text-text-muted">{k}:</span> {v}</span>
                        ))}
                      </div>
                    )}
                    {a.applicantNote && <p className="text-xs text-text-muted mt-1.5 italic">“{a.applicantNote}”</p>}
                    {a.status === 'rejected' && a.rejectionReason && <p className="text-xs text-red-500 mt-1">Rejected: {a.rejectionReason}</p>}
                  </div>
                  {isSuperAdmin && (
                    <div className="flex gap-2">
                      <Button size="sm" variant="primary" onClick={() => approve(a)} disabled={busyId === a.userId}>
                        {a.status === 'approved' ? 'Edit caps' : 'Approve'}
                      </Button>
                      {a.status !== 'rejected' && (
                        <Button size="sm" variant="secondary" onClick={() => reject(a)} disabled={busyId === a.userId}>Reject</Button>
                      )}
                    </div>
                  )}
                </div>
                {a.status === 'approved' && (
                  <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div><p className="text-text-muted">Margin allowance</p><p className="font-semibold text-text-primary">{a.maxMarginPct}%</p></div>
                    <div><p className="text-text-muted">Min buyer discount</p><p className="font-semibold text-text-primary">{a.minUserDiscountPct}%</p></div>
                    <div><p className="text-text-muted">Links</p><p className="font-semibold text-text-primary">{a.linkCount} / {a.maxLinks}</p></div>
                  </div>
                )}
              </div>
            ))}
          </section>

          {/* Earnings (per referral/affiliate link) */}
          <section className="space-y-3">
            <h2 className="text-sm font-bold text-text-primary">Affiliate earnings</h2>
            {earnings && earnings.length === 0 && (
              <div className="rounded-xl border border-border bg-surface p-8 text-center text-sm text-text-muted">No affiliate links with activity yet.</div>
            )}
            {earnings && earnings.map((r) => (
              <div key={r.codeId} className="rounded-xl border border-border bg-surface p-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono font-bold text-text-primary">{r.code}</span>
                  <Badge variant={r.isActive ? 'success' : 'default'}>{r.isActive ? 'Active' : 'Disabled'}</Badge>
                  <span className="text-xs text-primary font-semibold">{r.referralPct}% commission</span>
                  <span className="text-xs text-text-muted truncate">· {r.owner.username ?? r.owner.email}</span>
                </div>
                <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div><p className="text-text-muted">Referred</p><p className="font-semibold text-text-primary">{r.referredCount}</p></div>
                  <div><p className="text-text-muted">Total earned</p><p className="font-semibold text-text-primary">{fmt(r.totalAccruedUsdt)}</p></div>
                  <div><p className="text-text-muted">Available</p><p className="font-semibold text-primary">{fmt(r.availableUsdt)}</p></div>
                  <div><p className="text-text-muted">Withdrawn</p><p className="font-semibold text-text-primary">{fmt(r.withdrawnUsdt)}</p></div>
                </div>
              </div>
            ))}
          </section>
        </>
      )}
    </div>
  )
}
