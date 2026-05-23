'use client'
import Link from 'next/link'

export type TraderLevel = 0 | 1 | 2 | 3

export interface TraderLevelData {
  level: TraderLevel
  label: string
  color: string
  bgColor: string
  borderColor: string
}

const LEVELS: TraderLevelData[] = [
  { level: 0, label: 'New User',       color: 'text-text-muted',   bgColor: 'bg-gray-100',    borderColor: 'border-gray-200' },
  { level: 1, label: 'Verified Trader',color: 'text-primary',      bgColor: 'bg-primary/10',  borderColor: 'border-primary/30' },
  { level: 2, label: 'Trusted Trader', color: 'text-yellow-700',   bgColor: 'bg-yellow-50',   borderColor: 'border-yellow-300' },
  { level: 3, label: 'Elite Trader',   color: 'text-purple-700',   bgColor: 'bg-purple-50',   borderColor: 'border-purple-300' },
]

const LEVEL_ICONS = ['👤', '✅', '⭐', '💎']

export function computeTraderLevel(opts: {
  kycStatus: string
  kycLevel: string
  completedTrades: number
}): TraderLevel {
  const { kycStatus, kycLevel, completedTrades } = opts
  const kycApproved = kycStatus === 'approved'
  const enhanced = kycLevel === 'enhanced'

  if (kycApproved && enhanced && completedTrades >= 100) return 3
  if (kycApproved && enhanced && completedTrades >= 20)  return 2
  if (kycApproved && completedTrades >= 5)               return 1
  return 0
}

interface Props {
  kycStatus: string
  kycLevel: string
  completedTrades: number
  compact?: boolean
}

export function TraderLevelCard({ kycStatus, kycLevel, completedTrades, compact = false }: Props) {
  const level = computeTraderLevel({ kycStatus, kycLevel, completedTrades })
  const current = LEVELS[level]
  const next = LEVELS[level + 1] as TraderLevelData | undefined

  const kycApproved = kycStatus === 'approved'
  const enhanced = kycLevel === 'enhanced'

  const requirements: { label: string; done: boolean; href?: string }[] = level === 0
    ? [
        { label: 'Complete Basic KYC', done: kycApproved, href: '/kyc' },
        { label: 'Complete 5 trades', done: completedTrades >= 5 },
      ]
    : level === 1
    ? [
        { label: 'Upgrade to Enhanced KYC', done: enhanced, href: '/kyc' },
        { label: 'Complete 20 trades', done: completedTrades >= 20 },
      ]
    : level === 2
    ? [
        { label: 'Complete 100 trades', done: completedTrades >= 100 },
      ]
    : []

  const progressPct = level === 0
    ? Math.min((completedTrades / 5) * 60 + (kycApproved ? 40 : 0), 99)
    : level === 1
    ? Math.min(((completedTrades - 5) / 15) * 60 + (enhanced ? 40 : 0), 99)
    : level === 2
    ? Math.min(((completedTrades - 20) / 80) * 100, 99)
    : 100

  if (compact) {
    return (
      <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${current.bgColor} ${current.color}`}>
        <span>{LEVEL_ICONS[level]}</span>
        <span>Level {level} — {current.label}</span>
      </div>
    )
  }

  return (
    <div className={`bg-white border-2 ${current.borderColor} rounded-xl p-5 space-y-4`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-full ${current.bgColor} flex items-center justify-center text-xl`}>
            {LEVEL_ICONS[level]}
          </div>
          <div>
            <p className="text-xs text-text-muted">Trader Level {level}</p>
            <p className={`text-base font-bold ${current.color}`}>{current.label}</p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-xs text-text-muted">Completed Trades</p>
          <p className="text-lg font-bold text-text-primary">{completedTrades}</p>
        </div>
      </div>

      {/* Progress to next level */}
      {next && (
        <div className="space-y-2">
          <div className="flex justify-between text-xs text-text-muted">
            <span>Progress to Level {level + 1} — {next.label}</span>
            <span>{Math.round(progressPct)}%</span>
          </div>
          <div className="h-2 bg-surface rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-500"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}

      {level === 3 && (
        <div className="text-center text-sm text-purple-700 font-semibold bg-purple-50 rounded-lg py-2">
          Maximum level reached — Elite Trader
        </div>
      )}

      {/* Requirements checklist */}
      {requirements.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-text-muted uppercase tracking-wide">
            {requirements.every((r) => r.done) ? 'All requirements met!' : 'Complete to advance'}
          </p>
          {requirements.map((req) => (
            <div key={req.label} className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${req.done ? 'bg-success text-white' : 'border-2 border-border'}`}>
                  {req.done && (
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
                <span className={`text-sm ${req.done ? 'text-success line-through' : 'text-text-secondary'}`}>{req.label}</span>
              </div>
              {!req.done && req.href && (
                <Link href={req.href} className="text-xs text-primary font-medium hover:underline flex-shrink-0">
                  Go →
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
