
/**
 * Admin notification GROUPS — what an individual admin can tune in their own preferences.
 * A group is a presentation/delivery bucket; it is separate from the stored AdminNotification
 * (the audit-style record that something happened), which is always written for every event
 * regardless of anyone's preferences. Preferences only decide who SEES/HEARS it.
 */
export const NOTIF_GROUPS = [
  'usdt_trades', 'ctm_trades', 'gas_orders', 'payment_review', 'disputes', 'support', 'promotions', 'affiliates', 'kyc', 'system',
] as const
export type NotifGroup = (typeof NOTIF_GROUPS)[number]

export interface ChannelPrefs { inApp: boolean; push: boolean; telegram: boolean; sound: boolean }
export type GroupPrefs = Record<NotifGroup, ChannelPrefs>

export interface GroupMeta {
  key: NotifGroup
  label: string
  description: string
  /** Mandatory groups can't have in-app delivery switched off (security / outage visibility). */
  mandatoryInApp: boolean
  /** Default Telegram delivery — mirrors the long-standing per-category default so nothing changes until an admin edits. */
  defaultTelegram: boolean
  /** Shown in the UI as the "routine" vs "needs action" hint. */
  priority: 'routine' | 'action' | 'critical'
}

export const GROUP_META: Record<NotifGroup, GroupMeta> = {
  usdt_trades:    { key: 'usdt_trades',    label: 'USDT trade activity',          description: 'Trades between users on the USDT marketplace: completed, proof uploaded, ratings, auto-complete warnings.', mandatoryInApp: false, defaultTelegram: false, priority: 'routine' },
  ctm_trades:     { key: 'ctm_trades',     label: 'CTM trade activity',           description: 'Community-token trades, listings and token suggestions.', mandatoryInApp: false, defaultTelegram: true, priority: 'routine' },
  gas_orders:     { key: 'gas_orders',     label: 'Gas orders & failures',        description: 'Gas deliveries, failed deliveries, refunds, hot-wallet balance and pause alerts.', mandatoryInApp: false, defaultTelegram: true, priority: 'action' },
  payment_review: { key: 'payment_review', label: 'Payment proof & payment review', description: 'PKR / exchange proofs awaiting review, unattributed or ambiguous payments, deposits and withdrawals.', mandatoryInApp: false, defaultTelegram: true, priority: 'action' },
  disputes:       { key: 'disputes',       label: 'Disputes & escalations',       description: 'New disputes, auto-escalations and unresolved-dispute reminders on both marketplaces.', mandatoryInApp: false, defaultTelegram: true, priority: 'critical' },
  support:        { key: 'support',        label: 'Support messages',             description: 'New support-chat messages, refund-address replies and user reports.', mandatoryInApp: false, defaultTelegram: false, priority: 'action' },
  promotions:     { key: 'promotions',     label: 'Promotions',                   description: 'Giveaways, Share & Earn posts to review and other campaign events.', mandatoryInApp: false, defaultTelegram: false, priority: 'routine' },
  affiliates:     { key: 'affiliates',     label: 'Affiliate applications & payouts', description: 'New affiliate applications and affiliate-related events.', mandatoryInApp: false, defaultTelegram: false, priority: 'routine' },
  kyc:            { key: 'kyc',            label: 'KYC & maker reviews',          description: 'New KYC submissions and maker applications waiting for review.', mandatoryInApp: false, defaultTelegram: true, priority: 'action' },
  system:         { key: 'system',         label: 'System & security events',     description: 'Background-job failures, rate-updater problems, infrastructure and security alerts.', mandatoryInApp: true, defaultTelegram: false, priority: 'critical' },
}

export function defaultPrefs(): GroupPrefs {
  return Object.fromEntries(
    NOTIF_GROUPS.map((g) => [g, { inApp: true, push: true, telegram: GROUP_META[g].defaultTelegram, sound: false }]),
  ) as GroupPrefs
}

/** Merge an arbitrary stored JSON blob onto the defaults — unknown keys are dropped, mandatory rules re-applied. */
export function normalizePrefs(raw: unknown): GroupPrefs {
  const out = defaultPrefs()
  const groups = (raw as { groups?: Record<string, Partial<ChannelPrefs>> } | null)?.groups
  if (groups && typeof groups === 'object') {
    for (const g of NOTIF_GROUPS) {
      const v = groups[g]
      if (!v || typeof v !== 'object') continue
      for (const k of ['inApp', 'push', 'telegram', 'sound'] as const) if (typeof v[k] === 'boolean') out[g][k] = v[k]!
    }
  }
  for (const g of NOTIF_GROUPS) if (GROUP_META[g].mandatoryInApp) out[g].inApp = true
  return out
}

/**
 * Decide which group an event belongs to. Pure and deterministic so the stored `prefGroup`, the
 * SQL backfill and any UI preview all agree. Order matters: specific topics win over the
 * generic category.
 */
export function classifyNotification(n: { category: string; title: string; href?: string | null }): NotifGroup {
  const t = n.title.toLowerCase()
  const h = n.href ?? ''
  if (/new support message|refund address submitted|user report/.test(t) || h.startsWith('/admin/support')) return 'support'
  if (/affiliate/.test(t) || h.startsWith('/admin/gas/affiliates')) return 'affiliates'
  if (
    /share & earn|giveaway|promo code/.test(t) ||
    /^\/admin\/(gas\/share-rewards|promo-giveaways|gas\/giveaways|gas\/promo-codes|gas\/free-codes|tasks)/.test(h)
  ) return 'promotions'
  if (n.category === 'DISPUTE' || /dispute/.test(t)) return 'disputes'
  if (n.category === 'KYC' || /maker application|new kyc/.test(t) || h === '/admin/makers') return 'kyc'
  if (/instant buy/.test(t) || h === '/admin/instant-buy') return 'payment_review'
  if (n.category === 'GAS') {
    return /proof|exchange transfer|payment detected|ambiguous|payment may be undetected|unattributed/.test(t) ? 'payment_review' : 'gas_orders'
  }
  if (n.category === 'DEPOSIT' || n.category === 'WITHDRAWAL') return 'payment_review'
  if (n.category === 'TRADE') return 'usdt_trades'
  if (n.category === 'CTM') return 'ctm_trades'
  return 'system'
}

/** Groups the given admin has switched off for in-app delivery (mandatory groups can never appear here). */
export function mutedInAppGroups(prefs: GroupPrefs): NotifGroup[] {
  return NOTIF_GROUPS.filter((g) => !prefs[g].inApp && !GROUP_META[g].mandatoryInApp)
}
