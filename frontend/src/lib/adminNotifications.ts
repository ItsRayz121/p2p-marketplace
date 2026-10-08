import type { AdminNotif, AdminNotifGroup } from '@/lib/api'

export const GROUP_LABEL: Record<AdminNotifGroup, string> = {
  usdt_trades: 'USDT trades',
  ctm_trades: 'CTM trades',
  gas_orders: 'Gas',
  payment_review: 'Payments',
  disputes: 'Disputes',
  support: 'Support',
  promotions: 'Promotions',
  affiliates: 'Affiliates',
  kyc: 'KYC',
  system: 'System',
}

export const GROUP_ORDER: AdminNotifGroup[] = ['disputes', 'gas_orders', 'payment_review', 'support', 'kyc', 'usdt_trades', 'ctm_trades', 'promotions', 'affiliates', 'system']

export const GROUP_COLOR: Record<AdminNotifGroup, string> = {
  usdt_trades: 'bg-purple-500/15 text-purple-700 dark:text-purple-300',
  ctm_trades: 'bg-teal-500/15 text-teal-700 dark:text-teal-300',
  gas_orders: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  payment_review: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  disputes: 'bg-red-500/15 text-red-700 dark:text-red-300',
  support: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  promotions: 'bg-pink-500/15 text-pink-700 dark:text-pink-300',
  affiliates: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
  kyc: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  system: 'bg-surface-alt text-text-secondary',
}

/** Fallback for rows written before the bucket column existed. */
const CATEGORY_TO_GROUP: Record<string, AdminNotifGroup> = {
  KYC: 'kyc', TRADE: 'usdt_trades', GAS: 'gas_orders', DISPUTE: 'disputes', CTM: 'ctm_trades',
  SYSTEM: 'system', DEPOSIT: 'payment_review', WITHDRAWAL: 'payment_review',
}
export const groupOf = (n: Pick<AdminNotif, 'prefGroup' | 'category'>): AdminNotifGroup => n.prefGroup ?? CATEGORY_TO_GROUP[n.category] ?? 'system'

/**
 * Where a notification should land. Per-order links already point at the order; older aggregate
 * payment alerts that used to land on the gas dashboard now open the Payment Orders queue instead.
 */
export function resolveNotifHref(n: Pick<AdminNotif, 'href' | 'prefGroup' | 'category' | 'title'>): string | null {
  if (!n.href) return null
  if ((n.href === '/admin/gas' || n.href === '/admin/gas/') && groupOf(n) === 'payment_review') {
    return /proof|exchange transfer/i.test(n.title) ? '/admin/payment-orders?status=payment_uploaded&paymentType=MANUAL' : '/admin/payment-orders'
  }
  return n.href
}

export interface NotifCluster { key: string; items: AdminNotif[] }

/**
 * Collapse repeats of the same event (same title + destination, within 15 minutes of each other)
 * into one row with a count, so a failing job or a retry loop reads as one alert, not fifty.
 * Input must be newest-first (the API order).
 */
export function clusterNotifications(list: AdminNotif[], windowMs = 15 * 60_000): NotifCluster[] {
  const out: NotifCluster[] = []
  for (const n of list) {
    const prev = out[out.length - 1]
    const last = prev?.items[prev.items.length - 1]
    if (prev && last && last.title === n.title && last.href === n.href && Math.abs(new Date(last.createdAt).getTime() - new Date(n.createdAt).getTime()) <= windowMs) {
      prev.items.push(n)
    } else {
      out.push({ key: n.id, items: [n] })
    }
  }
  return out
}

/** Short two-note chime via WebAudio (no asset to load). Silently does nothing if audio is blocked. */
export function playNotifChime(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const now = ctx.currentTime
    ;[880, 1175].forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, now + i * 0.16)
      gain.gain.exponentialRampToValueAtTime(0.18, now + i * 0.16 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.16 + 0.28)
      osc.connect(gain).connect(ctx.destination)
      osc.start(now + i * 0.16)
      osc.stop(now + i * 0.16 + 0.3)
    })
    setTimeout(() => void ctx.close().catch(() => {}), 900)
  } catch { /* autoplay policy / unsupported — a missed chime is harmless */ }
}

export const PREFS_CHANGED_EVENT = 'rc-admin-notif-prefs-changed'
