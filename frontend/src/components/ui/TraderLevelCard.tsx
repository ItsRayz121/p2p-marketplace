'use client'
import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import { UserCircle, CheckCircle, Star, Trophy, Gem, Medal } from 'lucide-react'
import { cn } from '@/lib/utils'

export type TraderBadge = 'new' | 'active' | 'trusted' | 'top' | 'elite'

interface BadgeConfig {
  badge:       TraderBadge
  label:       string
  Icon:        LucideIcon
  color:       string
  bgColor:     string
  borderColor: string
  iconColor:   string
  minTrades:   number
  minRate:     number
}

const BADGE_CONFIG: BadgeConfig[] = [
  {
    badge:       'new',
    label:       'Bronze',
    Icon:        Medal,
    color:       'text-amber-700',
    bgColor:     'bg-amber-50 dark:bg-amber-950/30',
    borderColor: 'border-amber-300',
    iconColor:   'text-amber-600',
    minTrades:   0,
    minRate:     0,
  },
  {
    badge:       'active',
    label:       'Silver',
    Icon:        CheckCircle,
    color:       'text-slate-500',
    bgColor:     'bg-slate-100 dark:bg-slate-800/40',
    borderColor: 'border-slate-300',
    iconColor:   'text-slate-400',
    minTrades:   5,
    minRate:     0.80,
  },
  {
    badge:       'trusted',
    label:       'Gold',
    Icon:        Star,
    color:       'text-yellow-600',
    bgColor:     'bg-yellow-50 dark:bg-yellow-900/20',
    borderColor: 'border-yellow-300',
    iconColor:   'text-yellow-500',
    minTrades:   50,
    minRate:     0.90,
  },
  {
    badge:       'top',
    label:       'Diamond',
    Icon:        Trophy,
    color:       'text-cyan-600',
    bgColor:     'bg-cyan-50 dark:bg-cyan-900/20',
    borderColor: 'border-cyan-300',
    iconColor:   'text-cyan-500',
    minTrades:   200,
    minRate:     0.95,
  },
  {
    badge:       'elite',
    label:       'Elite',
    Icon:        Gem,
    color:       'text-purple-700',
    bgColor:     'bg-purple-50 dark:bg-purple-900/20',
    borderColor: 'border-purple-300',
    iconColor:   'text-purple-600',
    minTrades:   500,
    minRate:     0.98,
  },
]

function getBadgeConfig(badge: TraderBadge): BadgeConfig {
  return BADGE_CONFIG.find((b) => b.badge === badge) ?? BADGE_CONFIG[0]
}

function getNextBadge(badge: TraderBadge): BadgeConfig | undefined {
  const idx = BADGE_CONFIG.findIndex((b) => b.badge === badge)
  return BADGE_CONFIG[idx + 1]
}

function computeProgress(
  badge: TraderBadge,
  completedTrades: number,
  completionRate: number,
): number {
  const next = getNextBadge(badge)
  if (!next) return 100

  const current = getBadgeConfig(badge)
  const tradeProgress = next.minTrades > current.minTrades
    ? Math.min((completedTrades - current.minTrades) / (next.minTrades - current.minTrades), 1)
    : 1
  const rateProgress = next.minRate > current.minRate
    ? Math.min((completionRate - current.minRate) / (next.minRate - current.minRate), 1)
    : 1

  return Math.round(Math.min(tradeProgress, rateProgress) * 100)
}

// ─── Compact inline chip ───────────────────────────────────────────────────────

interface CompactProps {
  badge:       TraderBadge
  badgeLabel?: string
}

export function BadgeChip({ badge, badgeLabel }: CompactProps) {
  const cfg = getBadgeConfig(badge)
  const { Icon } = cfg
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold',
        cfg.bgColor,
        cfg.color,
      )}
    >
      <Icon size={11} className={cn('flex-shrink-0', cfg.iconColor)} aria-hidden />
      <span>{badgeLabel ?? cfg.label}</span>
    </span>
  )
}

// ─── Full card ─────────────────────────────────────────────────────────────────

interface CardProps {
  badge:           TraderBadge
  badgeLabel?:     string
  trustScore:      number
  completedTrades: number
  completionRate:  number
  kycStatus?:      string
  compact?:        boolean
}

export function TraderLevelCard({
  badge,
  badgeLabel,
  trustScore,
  completedTrades,
  completionRate,
  kycStatus,
  compact = false,
}: CardProps) {
  const cfg = getBadgeConfig(badge)
  const { Icon } = cfg
  const next = getNextBadge(badge)
  const progressPct = computeProgress(badge, completedTrades, completionRate)
  const kycApproved = kycStatus === 'approved'

  if (compact) {
    return <BadgeChip badge={badge} badgeLabel={badgeLabel ?? cfg.label} />
  }

  const requirements: { label: string; done: boolean; href?: string }[] = badge === 'new'
    ? [
        { label: 'Complete Basic KYC',                                                 done: kycApproved ?? false, href: '/kyc' },
        { label: `Complete ${next?.minTrades ?? 5} trades`,                            done: completedTrades >= (next?.minTrades ?? 5) },
        { label: `Maintain ${((next?.minRate ?? 0.8) * 100).toFixed(0)}% completion`, done: completionRate >= (next?.minRate ?? 0.8) },
      ]
    : next
    ? [
        { label: `Complete ${next.minTrades} trades (${completedTrades} done)`,        done: completedTrades >= next.minTrades },
        { label: `Maintain ${(next.minRate * 100).toFixed(0)}% completion rate`,       done: completionRate >= next.minRate },
      ]
    : []

  return (
    <div className={cn('bg-surface rounded-xl border-2 p-5 space-y-4 shadow-card', cfg.borderColor)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={cn('w-10 h-10 rounded-full flex items-center justify-center', cfg.bgColor)}>
            <Icon size={20} className={cfg.iconColor} aria-hidden />
          </div>
          <div>
            <p className="text-xs text-text-muted">Trader Badge</p>
            <p className={cn('text-base font-bold', cfg.color)}>{badgeLabel ?? cfg.label}</p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-xs text-text-muted">Trust Score</p>
          <p className="text-lg font-bold text-text-primary">
            {trustScore}<span className="text-xs text-text-muted">/100</span>
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="flex gap-4 text-center">
        <div className="flex-1 bg-surface-alt rounded-lg py-2">
          <p className="text-sm font-bold text-text-primary">{completedTrades}</p>
          <p className="text-xs text-text-muted">Trades</p>
        </div>
        <div className="flex-1 bg-surface-alt rounded-lg py-2">
          <p className="text-sm font-bold text-text-primary">{(completionRate * 100).toFixed(1)}%</p>
          <p className="text-xs text-text-muted">Completion</p>
        </div>
      </div>

      {/* Progress to next badge */}
      {next && (
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs text-text-muted">
            <span>Progress to {next.label}</span>
            <span>{progressPct}%</span>
          </div>
          <div className="h-1.5 bg-surface-alt rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-500"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}

      {badge === 'elite' && (
        <div className={cn('text-center text-sm font-semibold rounded-lg py-2', cfg.color, cfg.bgColor)}>
          Maximum level reached — Elite 💎
        </div>
      )}

      {/* Requirements checklist */}
      {requirements.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-text-muted uppercase tracking-wide">
            {requirements.every((r) => r.done) ? 'All requirements met' : 'To reach next badge'}
          </p>
          {requirements.map((req) => (
            <div key={req.label} className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className={cn(
                  'w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0',
                  req.done ? 'bg-success text-white' : 'border-2 border-border',
                )}>
                  {req.done && (
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
                <span className={cn('text-sm', req.done ? 'text-success line-through' : 'text-text-secondary')}>
                  {req.label}
                </span>
              </div>
              {!req.done && req.href && (
                <Link href={req.href} className="text-xs text-primary font-medium hover:underline flex-shrink-0">
                  Go
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
