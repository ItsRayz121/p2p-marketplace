'use client'
import { useCallback } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { cn } from '@/lib/utils'
import type { ClaimStatus, PaymentState, RewardType, TaskLifecycle } from '@/lib/platformTasks'

export const inputCls = 'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60'
export const labelCls = 'mb-1 block text-xs font-semibold text-text-secondary'

export function fmtReward(type: RewardType, points: number | null | undefined, usdt: number | null | undefined): string {
  return type === 'points' ? `${(points ?? 0).toLocaleString()} pts` : `$${(usdt ?? 0).toFixed(2)} USDT`
}

const STATUS: Record<ClaimStatus, { label: string; cls: string }> = {
  pending_review: { label: 'Pending review', cls: 'bg-warning/10 text-warning' },
  needs_changes: { label: 'Needs changes', cls: 'bg-info/10 text-info' },
  awaiting_payout: { label: 'Approved · awaiting payment', cls: 'bg-warning/10 text-warning' },
  completed: { label: 'Approved', cls: 'bg-success/10 text-success' },
  rejected: { label: 'Rejected', cls: 'bg-danger/10 text-danger' },
}
export function StatusPill({ status }: { status: ClaimStatus }) {
  const s = STATUS[status] ?? { label: status, cls: 'bg-surface-alt text-text-secondary' }
  return <span className={cn('inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold', s.cls)}>{s.label}</span>
}

const LIFE: Record<TaskLifecycle, { label: string; cls: string }> = {
  active: { label: 'Active', cls: 'bg-success/10 text-success' },
  scheduled: { label: 'Scheduled', cls: 'bg-info/10 text-info' },
  paused: { label: 'Paused', cls: 'bg-warning/10 text-warning' },
  ended: { label: 'Ended', cls: 'bg-surface-alt text-text-secondary' },
  draft: { label: 'Draft', cls: 'bg-surface-alt text-text-secondary' },
  archived: { label: 'Archived', cls: 'bg-surface-alt text-text-muted' },
}
export function LifecyclePill({ lifecycle }: { lifecycle: TaskLifecycle }) {
  const s = LIFE[lifecycle]
  return <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-semibold', s.cls)}>{s.label}</span>
}

const PAY: Record<PaymentState, { label: string; cls: string }> = {
  credited: { label: 'Credited', cls: 'bg-success/10 text-success' },
  awaiting_payment: { label: 'Awaiting payment', cls: 'bg-warning/10 text-warning' },
  paid: { label: 'Paid', cls: 'bg-success/10 text-success' },
}
export function PaymentPill({ state }: { state: PaymentState }) {
  const s = PAY[state]
  return <span className={cn('inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold', s.cls)}>{s.label}</span>
}

export function memberName(u: { username: string | null; fullName: string | null; email: string }): string {
  return u.username || u.fullName || u.email
}

export function Avatar({ name }: { name: string }) {
  return <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold uppercase text-primary">{name.charAt(0)}</span>
}

export function ago(iso: string | Date, now = Date.now()): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

export function fmtWait(hours: number | null): string {
  if (hours == null) return ''
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`
  return `${Math.round(hours / 24)}d`
}

/** Active tab + filters live in the URL so refresh, back/forward and shared links keep the view. */
export function useUrlState() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const get = (k: string, fb = '') => params.get(k) ?? fb
  const set = useCallback((patch: Record<string, string | null | undefined>, opts?: { push?: boolean }) => {
    const q = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') q.delete(k)
      else q.set(k, v)
    }
    const s = q.toString()
    const url = s ? `${pathname}?${s}` : pathname
    if (opts?.push) router.push(url, { scroll: false })
    else router.replace(url, { scroll: false })
  }, [params, pathname, router])
  return { get, set, params }
}

export const RANGES = [
  { key: '7', label: '7 days' },
  { key: '30', label: '30 days' },
  { key: '90', label: '90 days' },
] as const

/** ISO from/to for a "last N days" preset. */
export function rangeOf(days: string): { from: string; to: string } {
  const n = Number(days) || 30
  const to = new Date()
  const from = new Date(to.getTime() - (n - 1) * 86_400_000)
  from.setUTCHours(0, 0, 0, 0)
  return { from: from.toISOString(), to: to.toISOString() }
}

export function Pager({ page, total, limit, onPage }: { page: number; total: number; limit: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / limit))
  if (pages <= 1) return null
  return (
    <div className="flex items-center justify-between pt-2 text-xs text-text-muted">
      <span>Page {page} of {pages} · {total.toLocaleString()} total</span>
      <div className="flex gap-2">
        <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} className="rounded-md border border-border bg-surface px-2.5 py-1 font-medium text-text-secondary hover:bg-surface-alt disabled:opacity-50">Prev</button>
        <button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)} className="rounded-md border border-border bg-surface px-2.5 py-1 font-medium text-text-secondary hover:bg-surface-alt disabled:opacity-50">Next</button>
      </div>
    </div>
  )
}
