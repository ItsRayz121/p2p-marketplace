'use client'
import { useState, useEffect, useCallback, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { referralApi, gasApi } from '@/lib/api'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Badge } from '@/components/ui/Badge'
import { CopyButton } from '@/components/ui/CopyButton'
import { ReferralLinks } from '@/components/referral/ReferralLinks'
import { ReferralEarnings } from '@/components/referral/ReferralEarnings'
import { CommunityGiveaways } from '@/components/referral/CommunityGiveaways'
import { ChevronDown, Users, Send, Globe } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReferralStats {
  referralCode: string
  totalReferrals: number
  totalEarned: string
  pendingEarnings: string
}

interface Referral {
  id: string
  username: string
  joinedAt: string
  status: string
  source?: 'telegram' | 'web'
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const days = Math.floor(diff / 86_400_000)
  if (days < 1) return 'today'
  if (days < 7) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString()
}

// ─── Page ────────────────────────────────────────────────────────────────────

function ReferralPageInner() {
  const params = useSearchParams()
  const [stats, setStats] = useState<ReferralStats | null>(null)
  const [referrals, setReferrals] = useState<Referral[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showReferrals, setShowReferrals] = useState(false)

  const fetchData = useCallback(async () => {
    try {
      const [statsRes, refRes] = await Promise.all([
        referralApi.getStats(),
        referralApi.getReferrals({ limit: 50 }),
      ])
      setStats(statsRes)
      setReferrals(refRes.referrals as Referral[])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load referral data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  // First-touch attribution for an inbound ?ref= (e.g. a redirected /gas/referral link or a
  // custom link an existing user clicks). Best-effort + once; the backend ignores self/dupe.
  useEffect(() => {
    const ref = params.get('ref')
    if (!ref) return
    const seen = `ref_applied_${ref.toUpperCase()}`
    try { if (sessionStorage.getItem(seen)) return; sessionStorage.setItem(seen, '1') } catch { /* ignore */ }
    void gasApi.applyReferral(ref.trim()).catch(() => { /* invalid/self/already-bound — ignore */ })
  }, [params])

  if (loading) return <LoadingState message="Loading referral data..." />
  if (error || !stats) return <ErrorState title={error || 'Failed to load data'} onRetry={fetchData} />

  const shareUrl = `${typeof window !== 'undefined' ? window.location.origin : 'https://RupChain.pk'}/r/${stats.referralCode}`
  const whatsappMessage = encodeURIComponent(
    `Join RupChain — Pakistan's P2P crypto marketplace! Use my referral code ${stats.referralCode} to sign up and earn bonuses. ${shareUrl}`
  )

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Referral Program</h1>
        <p className="text-sm text-text-muted">Invite friends to RupChain and earn on every gas top-up they make.</p>
      </div>

      {/* Active rewards banner — the live 5% / 5% program */}
      <div className="bg-gradient-to-r from-primary/5 to-pink-500/5 border border-primary/20 rounded-xl p-5 space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-bold text-text-primary">Referral rewards</h2>
          <Badge variant="success" size="sm">Active</Badge>
        </div>
        <p className="text-sm text-text-muted">
          Earn <strong>5% of the platform gas fee</strong> from everyone you refer — paid into your USDT balance —
          and your friend gets <strong>5% off</strong> their gas fee automatically. Paid from our fee, never extra cost to anyone.
        </p>
        <div className="text-xs text-text-muted space-y-1 bg-surface rounded-lg border border-border px-3 py-2">
          <p>• Share your code or link below — or create named custom links.</p>
          <p>• Earnings accrue automatically once your referrals&apos; gas orders are delivered.</p>
          <p>• Withdraw to your USDT balance after a short fraud-hold window.</p>
          <p>• Want a bigger cut? Apply to become an affiliate for up to 20–30%.</p>
        </div>
      </div>

      {/* Referral Code Card */}
      <div className="bg-gradient-to-br from-primary to-primary/80 rounded-2xl p-6 text-white">
        <p className="text-sm font-medium opacity-80 mb-1">Your Referral Code</p>
        <div className="flex items-center gap-3">
          <span className="text-3xl font-black tracking-widest">{stats.referralCode}</span>
          <CopyButton text={stats.referralCode} className="text-white/80 hover:text-white hover:bg-white/10" />
        </div>
        <div className="flex gap-2 mt-4">
          <a
            href={`https://wa.me/?text=${whatsappMessage}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 bg-white/20 hover:bg-white/30 text-white text-sm font-medium px-3 py-2 rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
            </svg>
            Share via WhatsApp
          </a>
        </div>
      </div>

      {/* Dual share links — Telegram (primary) + Website (fallback) */}
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-text-primary">Share your link</h2>
        <ReferralLinks code={stats.referralCode} />
      </div>

      {/* Live earnings + custom links + affiliate (single source of truth) */}
      <ReferralEarnings />

      {/* Community / influencer giveaways (affiliates + staff) */}
      <CommunityGiveaways />

      {/* Referred Users — collapsible */}
      <section className="bg-surface shadow-card border border-border rounded-xl overflow-hidden">
        <button
          onClick={() => setShowReferrals((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-alt transition-colors"
          aria-expanded={showReferrals}
        >
          <span className="flex items-center gap-2 text-base font-semibold text-text-primary">
            <Users size={16} className="text-text-muted" />
            Your Referrals
            <Badge variant="default" size="sm">{referrals.length}</Badge>
          </span>
          <ChevronDown size={18} className={`text-text-muted transition-transform ${showReferrals ? 'rotate-180' : ''}`} />
        </button>
        {showReferrals && (
          referrals.length === 0 ? (
            <div className="py-10 text-center border-t border-border">
              <p className="text-text-muted text-sm">No referrals yet.</p>
              <p className="text-xs text-text-muted mt-1">Share your code and start earning!</p>
            </div>
          ) : (
            <div className="divide-y divide-border border-t border-border">
              {referrals.map((ref) => (
                <div key={ref.id} className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-2 min-w-0">
                    {/* Signup source — small icon shows where they joined from */}
                    {ref.source === 'telegram' ? (
                      <span title="Joined via Telegram" className="flex-shrink-0 text-[#229ED9]">
                        <Send size={14} />
                      </span>
                    ) : (
                      <span title="Joined via website" className="flex-shrink-0 text-text-muted">
                        <Globe size={14} />
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary truncate">{ref.username}</p>
                      <p className="text-xs text-text-muted">Joined {timeAgo(ref.joinedAt)}</p>
                    </div>
                  </div>
                  <Badge variant={ref.status === 'active' ? 'success' : 'default'} size="sm">
                    {ref.status === 'active' ? 'Active' : 'Not traded yet'}
                  </Badge>
                </div>
              ))}
            </div>
          )
        )}
      </section>

      {/* How it works */}
      <section className="bg-surface border border-border rounded-xl p-5 space-y-3">
        <h2 className="text-base font-semibold text-text-primary">How It Works</h2>
        {[
          { step: '1', text: 'Share your referral code or link with friends' },
          { step: '2', text: 'Friend signs up and tops up gas using your code' },
          { step: '3', text: 'You earn 5% of the gas fee in USDT; they get 5% off automatically' },
          { step: '4', text: 'Withdraw your earnings to your USDT balance any time after the hold window' },
        ].map((item) => (
          <div key={item.step} className="flex items-start gap-3">
            <div className="w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
              {item.step}
            </div>
            <p className="text-sm text-text-primary">{item.text}</p>
          </div>
        ))}
      </section>
    </div>
  )
}

export default function ReferralPage() {
  return (
    <Suspense fallback={<LoadingState message="Loading referral data..." />}>
      <ReferralPageInner />
    </Suspense>
  )
}
