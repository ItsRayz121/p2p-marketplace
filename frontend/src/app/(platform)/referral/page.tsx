'use client'
import { useState, useEffect, useCallback } from 'react'
import { referralApi } from '@/lib/api'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/CopyButton'
import { ReferralLinks } from '@/components/referral/ReferralLinks'
import { Users, TrendingUp, Clock } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReferralStats {
  referralCode: string
  totalReferrals: number
  totalEarned: string
  pendingEarnings: string
}

interface Referral {
  id: string
  email: string
  username?: string
  joinedAt: string
  status: string
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const days = Math.floor(diff / 86_400_000)
  if (days < 1) return 'today'
  if (days < 7) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString()
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ReferralPage() {
  const [stats, setStats] = useState<ReferralStats | null>(null)
  const [referrals, setReferrals] = useState<Referral[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

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
        <p className="text-sm text-text-muted">Invite friends to RupChain — referral rewards coming soon.</p>
      </div>

      {/* Reward banner — rewards are not auto-credited; admin-approved after real volume */}
      <div className="bg-gradient-to-r from-primary/5 to-pink-500/5 border border-primary/20 rounded-xl p-5 space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-bold text-text-primary">Referral rewards / cashback</h2>
          <Badge variant="warning" size="sm">Coming soon</Badge>
        </div>
        <p className="text-sm text-text-muted">
          We&apos;re finalising our referral rewards program. Rewards will be reviewed and approved by our team
          based on your referrals&apos; completed trading activity — there are no automatic cash payouts yet.
        </p>
        <div className="text-xs text-text-muted space-y-1 bg-surface rounded-lg border border-border px-3 py-2">
          <p>• Your friend must register using your referral code or link.</p>
          <p>• Track your referrals below — start building your network now.</p>
          <p>• Rewards will be announced and credited after admin review.</p>
          <p>• No limit on the number of referrals.</p>
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

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Total Referrals', value: stats.totalReferrals.toString(),                          Icon: Users,       iconCls: 'text-pink-500',    bgCls: 'bg-pink-500/10'    },
          { label: 'Total Earned',    value: `PKR ${parseFloat(stats.totalEarned).toLocaleString()}`,  Icon: TrendingUp,  iconCls: 'text-emerald-500', bgCls: 'bg-emerald-500/10' },
          { label: 'Pending',         value: `PKR ${parseFloat(stats.pendingEarnings).toLocaleString()}`, Icon: Clock,    iconCls: 'text-amber-500',   bgCls: 'bg-amber-500/10'   },
        ].map(({ label, value, Icon, iconCls, bgCls }) => (
          <div key={label} className="bg-surface shadow-card border border-border rounded-xl p-4 text-center">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center mx-auto mb-2 ${bgCls}`}>
              <Icon size={16} className={iconCls} aria-hidden />
            </div>
            <p className="text-lg font-bold text-text-primary">{value}</p>
            <p className="text-xs text-text-muted mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      {/* Referred Users */}
      <section>
        <h2 className="text-base font-semibold text-text-primary mb-3">Your Referrals</h2>
        <div className="bg-surface shadow-card border border-border rounded-xl overflow-hidden">
          {referrals.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-text-muted text-sm">No referrals yet.</p>
              <p className="text-xs text-text-muted mt-1">Share your code and start earning!</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {referrals.map((ref) => (
                <div key={ref.id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-text-primary">
                      {ref.username ?? ref.email.split('@')[0] + '@...'}
                    </p>
                    <p className="text-xs text-text-muted">Joined {timeAgo(ref.joinedAt)}</p>
                  </div>
                  <Badge
                    variant={ref.status === 'active' ? 'success' : 'default'}
                    size="sm"
                  >
                    {ref.status === 'active' ? 'Active' : 'Not traded yet'}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* How it works */}
      <section className="bg-surface border border-border rounded-xl p-5 space-y-3">
        <h2 className="text-base font-semibold text-text-primary">How It Works</h2>
        {[
          { step: '1', text: 'Share your referral code or link with friends' },
          { step: '2', text: 'Friend signs up using your referral code' },
          { step: '3', text: 'Friend completes their first trade on RupChain' },
          { step: '4', text: 'Referral rewards (coming soon) will be credited after admin review of completed trades' },
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
