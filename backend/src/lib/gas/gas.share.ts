/**
 * Share & Earn — after a delivered gas order the user can post about it on X and submit
 * the link. An admin approves it, which draws a RANDOM discount (default 20–50%, the top
 * end rare) off the platform MARGIN of the user's next gas order. Margin-only, so the base
 * gas cost is never touched and the platform can't lose money on a reward.
 *
 * Lifecycle: submitted (→ changes_required → submitted) → approved → reserved (held by an unpaid order) → used (delivered).
 * rejected is terminal. Reservations on orders that expire/cancel/refund are released by
 * `releaseStaleShareRewards()` (called from the 60s expiry sweep).
 */
import { db } from '../prisma'
import { env } from '../env'
import { AppError } from '../errors'
import { logger } from '../logger'
import { notify } from '../notify'
import { createAdminNotif } from '../../services/adminNotification.service'
import { getBoolConfig, getNumberConfig, isFlagEnabled, FLAGS } from '../../services/platformFlags.service'
import { getOrCreateOwnCode } from './gas.referral'
import { Prisma } from '@prisma/client'
import type { GasFeeOrder } from '@prisma/client'
import { verifyShareReward, X_VERIFY_AUTO_APPROVE_KEY } from '../social/xVerification'

export const SHARE_ENABLED_KEY = 'share_reward_enabled'          // default ON
export const SHARE_TEST_EMAILS_KEY = 'share_reward_test_emails'  // comma list; '*' = everyone
export const SHARE_MIN_PCT_KEY = 'share_reward_min_pct'          // default 20
export const SHARE_MAX_PCT_KEY = 'share_reward_max_pct'          // default 50
export const SHARE_HANDLE_KEY = 'share_reward_x_handle'          // e.g. "RupChain" (no @)
export const SHARE_WINDOW_HOURS_KEY = 'share_reward_window_hours' // how long after delivery the offer stays open (default 1 hour)
const DEFAULT_TEST_EMAILS = 'fazalelahi057@gmail.com'


async function getStringConfig(key: string): Promise<string | null> {
  const row = await db.platformConfig.findUnique({ where: { key } })
  const v = row?.value?.trim()
  return v ? v : null
}

// ── Eligibility (feature switch + test-account allowlist) ────────────────────

export async function isShareFeatureOn(): Promise<boolean> {
  return getBoolConfig(SHARE_ENABLED_KEY, true)
}

/** While the allowlist is set (default: the test email) only those accounts see the feature. '*' opens it to all. */
export async function isUserAllowedToShare(email: string): Promise<boolean> {
  const raw = (await getStringConfig(SHARE_TEST_EMAILS_KEY)) ?? DEFAULT_TEST_EMAILS
  if (raw === '*') return true
  return raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean).includes(email.trim().toLowerCase())
}

// ── Random discount draw ─────────────────────────────────────────────────────

/** Integer in [min,max], skewed low: mean ≈ min + (max-min)/3, ~3% chance of landing within 2 of max. */
export function drawDiscountPct(min: number, max: number, rand: () => number = Math.random): number {
  const lo = Math.max(1, Math.min(min, max))
  const hi = Math.min(100, Math.max(min, max))
  const u = rand()
  return Math.round(lo + (hi - lo) * u * u)
}

/**
 * The reward for an order is fixed by the order itself (seeded draw), so the % we show
 * before they post is exactly what approval grants, and refreshing can't re-roll it.
 */
export function rewardPctForOrder(orderRef: string, min: number, max: number): number {
  return drawDiscountPct(min, max, mulberry32(hashSeed(`share-reward:${orderRef}`)))
}

// ── Tweet URL normalisation ──────────────────────────────────────────────────

export function normalizeTweetUrl(raw: string): { postKey: string; canonical: string } | null {
  let u: URL
  try { u = new URL(raw.trim()) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const host = u.hostname.replace(/^(www\.|mobile\.)/, '').toLowerCase()
  if (host !== 'x.com' && host !== 'twitter.com') return null
  const m = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})\/?$/.exec(u.pathname)
  if (!m) return null
  return { postKey: m[2]!, canonical: `https://x.com/${m[1]}/status/${m[2]}` }
}

// ── Natural, varied post text ────────────────────────────────────────────────

function hashSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface ShareTextInput {
  seed: string          // orderRef + variant → stable per click, different across orders/shuffles
  amount: string        // already formatted, e.g. "0.01"
  symbol: string        // e.g. "BNB"
  chainName: string     // e.g. "BNB Smart Chain"
  chainKey: string      // chain slug/code, e.g. "BSC" (drives the #<Chain>GasFees hashtag)
  paidWith: 'PKR' | 'USDT'
  link: string
  handle?: string | null
}

const CHAIN_HASHTAG_WORD: Record<string, string> = {
  BSC: 'BNB', TRON: 'Tron', ETH: 'ETH', SOL: 'Solana', MATIC: 'Polygon', ARB: 'Arbitrum', BASE: 'Base',
  OP: 'Optimism', AVAX: 'Avalanche', TON: 'TON', SUI: 'Sui', APT: 'Aptos', APTOS: 'Aptos',
}

/** Relevant, small hashtag set: brand + the chain's gas tag + the incentive disclosure. */
export function buildShareHashtags(chainKey: string, symbol: string): string[] {
  const word = CHAIN_HASHTAG_WORD[chainKey.toUpperCase()] ?? (symbol.replace(/[^A-Za-z0-9]/g, '') || 'Crypto')
  return ['#RupChain', `#${word}GasFees`, '#ad']
}

/** X counts every link as 23 characters; everything else is one per character (close enough for emoji-free text). */
export function tweetWeightedLength(text: string): number {
  return text.replace(/https?:\/\/\S+/g, 'x'.repeat(23)).length
}

/**
 * Factual, first-person-neutral caption. It only states what the order record proves (amount,
 * chain, payment currency, delivered), mentions the configured official handle (never a guess),
 * discloses the incentive, and ends with the order link and hashtags.
 */
export function buildShareText(i: ShareTextInput): string {
  const rand = mulberry32(hashSeed(i.seed))
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!
  const brand = i.handle ? `@${i.handle.replace(/^@/, '')}` : 'RupChain'
  const pay = i.paidWith

  const bodies = [
    `Topped up ${i.amount} ${i.symbol} for ${i.chainName} gas through ${brand}, paid with ${pay}. The order was delivered to my wallet.`,
    `Needed ${i.symbol} for ${i.chainName} fees, so I bought ${i.amount} ${i.symbol} via ${brand} and paid with ${pay}. Order delivered.`,
    `${i.amount} ${i.symbol} of ${i.chainName} gas, ordered through ${brand} and paid with ${pay}. Delivered to my wallet.`,
    `Got ${i.amount} ${i.symbol} for ${i.chainName} network fees using ${brand}. Paid with ${pay}, delivered.`,
  ]
  const disclosures = [
    `RupChain offered me a discount on my next order for sharing.`,
    `I get a discount on my next order from RupChain for posting this.`,
    `Sharing earns me a discount on my next RupChain order.`,
  ]
  const tags = buildShareHashtags(i.chainKey, i.symbol).join(' ')
  const body = pick(bodies)
  const disclosure = pick(disclosures)

  const compose = (b: string) => [`${b} ${disclosure}`, i.link, tags].join('\n\n')
  let text = compose(body)
  // Over the X limit (very long chain names): fall back to the shortest wording.
  if (tweetWeightedLength(text) > 280) text = compose(bodies[2]!)
  return text
}

const NATIVE_SYMBOL: Record<string, string> = { BSC: 'BNB', TRON: 'TRX', ETH: 'ETH', SOL: 'SOL', MATIC: 'POL', ARB: 'ETH', BASE: 'ETH', OP: 'ETH', AVAX: 'AVAX', TON: 'TON', SUI: 'SUI', APT: 'APT' }
const CHAIN_LABEL: Record<string, string> = { BSC: 'BNB Smart Chain', TRON: 'Tron', ETH: 'Ethereum', SOL: 'Solana', MATIC: 'Polygon', ARB: 'Arbitrum', BASE: 'Base', OP: 'Optimism', AVAX: 'Avalanche', TON: 'TON', SUI: 'Sui', APT: 'Aptos' }

function trimAmount(n: number): string {
  return String(Number(n.toFixed(6)))
}

// ── User-facing: info + submit ───────────────────────────────────────────────

export interface ShareCardFacts {
  amount: string
  symbol: string
  chainName: string
  /** Chain slug/code (BSC, ETH, TON…) — the frontend maps it to the right logo and colours. */
  chainKey: string
  /** Admin-uploaded chain logo, when there is one. */
  chainLogoUrl: string | null
  paidWith: 'PKR' | 'USDT'
}

export type ShareVerifyView = {
  status: string
  discountPct: number | null
  rejectionReason: string | null
  /** Plain-language reasons the post needs changes (verification found a mismatch). */
  issues: string[]
  postUrl: string | null
}

export interface ShareInfo {
  /** When the offer closes (ISO). Present while the offer is still open. */
  deadlineAt?: string
  /** The discount % this order unlocks if the post is approved. */
  rewardPct?: number
  /** Real facts of the order, used by the image and the caption. */
  card?: ShareCardFacts & { template: 'snapshot' | 'experience' | 'minimal' }
  eligible: boolean
  reason?: string
  text?: string
  hashtags?: string[]
  /** The public link inside the caption (also what X unfurls into the image card). */
  link?: string
  tweetIntentUrl?: string
  /** Official X handle (without @) when configured. */
  handle?: string | null
  reward: ShareVerifyView | null
}

const TEMPLATES = ['snapshot', 'experience', 'minimal'] as const

async function loadOwnedDeliveredOrder(userId: string, orderRef: string): Promise<GasFeeOrder> {
  const order = await db.gasFeeOrder.findUnique({ where: { orderRef } })
  if (!order || order.userId !== userId) throw new AppError('NOT_FOUND', 'Order not found', 404)
  return order
}

/** Facts of a gas order for the image/caption, from the order record only. */
async function describeOrder(order: GasFeeOrder): Promise<ShareCardFacts> {
  const tokenCfg = order.gasTokenConfigId
    ? await db.gasTokenConfig.findUnique({
        where: { id: order.gasTokenConfigId },
        include: { chain: { select: { name: true, slug: true, logoUrl: true } } },
      })
    : null
  return {
    amount: trimAmount(Number(order.gasAmountNative)),
    symbol: tokenCfg?.symbol ?? NATIVE_SYMBOL[order.chain] ?? String(order.chain),
    chainName: tokenCfg?.chain.name ?? CHAIN_LABEL[order.chain] ?? String(order.chain),
    chainKey: tokenCfg?.chain.slug ?? String(order.chain),
    chainLogoUrl: tokenCfg?.chain.logoUrl ?? null,
    paidWith: order.paymentCoin === 'PKR' ? 'PKR' : 'USDT',
  }
}

function rewardView(r: { status: string; discountPct: number | null; rejectionReason: string | null; postUrl: string; verifyIssues: unknown } | null): ShareVerifyView | null {
  if (!r) return null
  const issues = Array.isArray(r.verifyIssues) ? (r.verifyIssues as unknown[]).filter((x): x is string => typeof x === 'string') : []
  return { status: r.status, discountPct: r.discountPct, rejectionReason: r.rejectionReason, issues, postUrl: r.postUrl }
}

export async function getShareInfo(userId: string, orderRef: string, variant: number): Promise<ShareInfo> {
  const [user, order] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { email: true } }),
    loadOwnedDeliveredOrder(userId, orderRef),
  ])
  const reward = await db.gasShareReward.findUnique({ where: { sourceOrderId: order.id } })
  const view = rewardView(reward)

  if (!user || !(await isShareFeatureOn()) || !(await isUserAllowedToShare(user.email))) return { eligible: false, reward: null }
  if (order.status !== 'delivered' || order.isFreeGrant) return { eligible: false, reward: view }
  const windowHours = await getNumberConfig(SHARE_WINDOW_HOURS_KEY, 1)
  const deadline = new Date((order.deliveredAt ?? order.updatedAt).getTime() + windowHours * 3_600_000)
  // A post that needs changes may be fixed and resubmitted until the window closes.
  const open = !reward || reward.status === 'changes_required'
  if (open && Date.now() > deadline.getTime()) {
    return { eligible: false, reason: 'This offer has expired.', reward: view }
  }
  const [minPct, maxPct] = await Promise.all([getNumberConfig(SHARE_MIN_PCT_KEY, 20), getNumberConfig(SHARE_MAX_PCT_KEY, 50)])
  const rewardPct = rewardPctForOrder(order.orderRef, minPct, maxPct)
  const facts = await describeOrder(order)

  // The post links to our public share page: X unfurls it into a large card with the branded
  // image (the same variant the user picked), and the page carries the user's referral link.
  // Falls back to /gas when referrals are off.
  const referralsOn = await isFlagEnabled(FLAGS.GAS_REFERRAL)
  // Make sure the user has a referral code so the share page can carry their link.
  if (referralsOn) await getOrCreateOwnCode(userId).catch(() => { /* non-fatal */ })
  const template = TEMPLATES[variant % TEMPLATES.length]!
  const link = referralsOn ? `${env.FRONTEND_URL}/s/${order.orderRef}?v=${variant % TEMPLATES.length}` : `${env.FRONTEND_URL}/gas`
  const handle = (await getStringConfig(SHARE_HANDLE_KEY))?.replace(/^@/, '') ?? null
  const text = buildShareText({ seed: `${order.orderRef}:${variant}`, ...facts, link, handle })
  return {
    eligible: true,
    deadlineAt: deadline.toISOString(),
    rewardPct,
    card: { ...facts, template },
    text,
    hashtags: buildShareHashtags(facts.chainKey, facts.symbol),
    link,
    handle,
    tweetIntentUrl: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`,
    reward: view,
  }
}

/**
 * Public, non-identifying facts for the share page / preview image of a DELIVERED order:
 * amount, coin, chain, how it was paid and the owner's referral code. Never exposes the
 * address, user or tracking details.
 */
export interface PublicShareData extends ShareCardFacts {
  refCode: string | null
  discountPct: number
}

export async function getPublicShareData(orderRef: string): Promise<PublicShareData | null> {
  const order = await db.gasFeeOrder.findUnique({ where: { orderRef } })
  if (!order || order.status !== 'delivered' || order.isFreeGrant || !order.userId) return null
  if (!(await isFlagEnabled(FLAGS.GAS_REFERRAL))) return null
  const code = await db.gasReferralCode.findFirst({ where: { ownerId: order.userId, deletedAt: null, isActive: true }, orderBy: { createdAt: 'asc' }, select: { code: true } })
  return {
    ...(await describeOrder(order)),
    refCode: code?.code ?? null,
    discountPct: await getNumberConfig('gas_referral_user_discount_pct', 10),
  }
}

export async function submitSharePost(userId: string, orderRef: string, url: string): Promise<{ status: string }> {
  const info = await getShareInfo(userId, orderRef, 0)
  if (!info.eligible) throw new AppError('SHARE_NOT_ELIGIBLE', info.reason ?? 'Sharing is not available for this order.', 400)
  if (info.reward && info.reward.status !== 'changes_required') throw new AppError('SHARE_ALREADY_SUBMITTED', 'You already submitted a post for this order.', 409)
  const norm = normalizeTweetUrl(url)
  if (!norm) throw new AppError('INVALID_POST_URL', 'Paste the link to your post, like https://x.com/yourname/status/123…', 400)

  const order = await loadOwnedDeliveredOrder(userId, orderRef)
  let rewardId: string
  try {
    if (info.reward) {
      // Fixing a post that needed changes: same reward row, new link, back into review.
      const existing = await db.gasShareReward.findUnique({ where: { sourceOrderId: order.id }, select: { id: true } })
      if (!existing) throw new AppError('NOT_FOUND', 'Reward not found', 404)
      await db.gasShareReward.update({
        where: { id: existing.id },
        data: { postUrl: norm.canonical, postKey: norm.postKey, status: 'submitted', verifyStatus: null, verifyIssues: Prisma.DbNull },
      })
      rewardId = existing.id
    } else {
      const created = await db.gasShareReward.create({
        data: { userId, sourceOrderId: order.id, postUrl: norm.canonical, postKey: norm.postKey, status: 'submitted' },
        select: { id: true },
      })
      rewardId = created.id
      const who = (await db.user.findUnique({ where: { id: userId }, select: { username: true } }))?.username ?? userId
      void createAdminNotif({
        category: 'GAS',
        title: 'Share & Earn post to review',
        body: `${who} submitted an X post for order ${orderRef}. Check it and approve or reject.`,
        href: '/admin/gas/share-rewards',
        roles: ['admin', 'super_admin'],
        telegram: false,
      })
    }
  } catch (e) {
    if (e instanceof AppError) throw e
    throw new AppError('POST_ALREADY_USED', 'That post has already been submitted.', 409)
  }
  void runShareVerification(rewardId, userId)
  return { status: 'submitted' }
}

/** Background check; a failure to verify never blocks the user, it just leaves the post for an admin. */
async function runShareVerification(rewardId: string, userId: string): Promise<void> {
  try {
    const res = await verifyShareReward(rewardId)
    if (!res.ran) return
    const r = await db.gasShareReward.findUnique({ where: { id: rewardId }, select: { status: true, verifyIssues: true, verifyStatus: true } })
    if (!r) return
    if (r.status === 'changes_required') {
      const issues = Array.isArray(r.verifyIssues) ? (r.verifyIssues as string[]) : []
      notify(userId, 'gas', 'Your Share & Earn post needs a change', issues.join(' ') || 'Please check the post and resubmit it.', { rewardId }, undefined, '/gas/orders', { telegram: true })
      return
    }
    if (r.verifyStatus === 'passed' && (await getBoolConfig(X_VERIFY_AUTO_APPROVE_KEY, false))) {
      await approveShareReward(rewardId, 'system:x-verify').catch((err) => logger.warn({ err, rewardId }, 'auto-approve failed'))
    }
  } catch (err) {
    logger.warn({ err, rewardId }, 'share verification crashed')
  }
}

/** The user's usable reward (approved, or held by an unpaid order) — for the "discount ready" banner. */
export async function getActiveShareReward(userId: string): Promise<{ discountPct: number } | null> {
  const r = await db.gasShareReward.findFirst({
    where: { userId, status: { in: ['approved', 'reserved'] }, discountPct: { not: null } },
    orderBy: { createdAt: 'asc' },
    select: { discountPct: true },
  })
  return r?.discountPct ? { discountPct: r.discountPct } : null
}

// ── Admin: review ────────────────────────────────────────────────────────────

export async function listShareRewards(status?: string) {
  const rows = await db.gasShareReward.findMany({
    where: status && status !== 'all' ? { status } : {},
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { user: { select: { id: true, username: true, email: true } } },
  })
  const orders = await db.gasFeeOrder.findMany({
    where: { id: { in: rows.map((r) => r.sourceOrderId) } },
    select: { id: true, orderRef: true, gasAmountNative: true, chain: true },
  })
  const byId = new Map(orders.map((o) => [o.id, o]))
  return rows.map((r) => ({
    id: r.id, status: r.status, postUrl: r.postUrl, discountPct: r.discountPct, rejectionReason: r.rejectionReason,
    verifyStatus: r.verifyStatus, verifyIssues: Array.isArray(r.verifyIssues) ? r.verifyIssues : [], postAuthor: r.postAuthor, postCreatedAt: r.postCreatedAt, verifyAttempts: r.verifyAttempts,
    createdAt: r.createdAt, reviewedAt: r.reviewedAt, usedAt: r.usedAt,
    user: r.user,
    order: byId.has(r.sourceOrderId) ? {
      orderRef: byId.get(r.sourceOrderId)!.orderRef,
      amount: byId.get(r.sourceOrderId)!.gasAmountNative.toString(),
      chain: byId.get(r.sourceOrderId)!.chain,
    } : null,
  }))
}

export async function approveShareReward(id: string, adminId: string): Promise<{ discountPct: number }> {
  const [min, max] = await Promise.all([getNumberConfig(SHARE_MIN_PCT_KEY, 20), getNumberConfig(SHARE_MAX_PCT_KEY, 50)])
  const pending = await db.gasShareReward.findUnique({ where: { id }, select: { sourceOrderId: true } })
  const src = pending ? await db.gasFeeOrder.findUnique({ where: { id: pending.sourceOrderId }, select: { orderRef: true } }) : null
  const pct = src ? rewardPctForOrder(src.orderRef, min, max) : drawDiscountPct(min, max)
  const res = await db.gasShareReward.updateMany({
    where: { id, status: { in: ['submitted', 'changes_required'] } },
    data: { status: 'approved', discountPct: pct, reviewedById: adminId, reviewedAt: new Date() },
  })
  if (res.count === 0) throw new AppError('CONFLICT', 'This post was already reviewed.', 409)
  const r = await db.gasShareReward.findUnique({ where: { id }, select: { userId: true } })
  if (r) {
    notify(r.userId, 'gas', `You earned a ${pct}% fee discount 🎉`, `Thanks for sharing! ${pct}% off the platform fee on your next gas order, applied automatically at checkout.`, { rewardId: id, discountPct: pct }, undefined, '/gas', { telegram: true })
  }
  return { discountPct: pct }
}

export async function rejectShareReward(id: string, adminId: string, reason: string): Promise<void> {
  const clean = reason.trim().slice(0, 300) || 'The post did not meet the requirements.'
  const res = await db.gasShareReward.updateMany({
    where: { id, status: { in: ['submitted', 'changes_required'] } },
    data: { status: 'rejected', rejectionReason: clean, reviewedById: adminId, reviewedAt: new Date() },
  })
  if (res.count === 0) throw new AppError('CONFLICT', 'This post was already reviewed.', 409)
  const r = await db.gasShareReward.findUnique({ where: { id }, select: { userId: true } })
  if (r) notify(r.userId, 'gas', 'Share & Earn post not approved', `We couldn't approve your post: ${clean}`, { rewardId: id })
}

// ── Checkout integration (called from the gas order-creation paths) ──────────

/** The user's oldest approved (unreserved) reward, without claiming it. */
export async function peekShareReward(userId: string): Promise<{ id: string; discountPct: number } | null> {
  const r = await db.gasShareReward.findFirst({
    where: { userId, status: 'approved', discountPct: { not: null } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, discountPct: true },
  })
  return r?.discountPct ? { id: r.id, discountPct: r.discountPct } : null
}

/** Atomically claim a specific approved reward (approved → reserved). False if already taken. */
export async function reserveSpecificShareReward(rewardId: string): Promise<boolean> {
  const claimed = await db.gasShareReward.updateMany({ where: { id: rewardId, status: 'approved' }, data: { status: 'reserved' } })
  return claimed.count === 1
}

/** Order creation failed after reserving — put the reward back. */
export async function releaseShareReward(rewardId: string | null): Promise<void> {
  if (!rewardId) return
  await db.gasShareReward.updateMany({ where: { id: rewardId, status: 'reserved' }, data: { status: 'approved' } }).catch(() => {})
}

/** Delivered order that carried a reward → consume it. Idempotent. */
export async function markShareRewardUsed(order: Pick<GasFeeOrder, 'id' | 'shareRewardId'>): Promise<void> {
  if (!order.shareRewardId) return
  await db.gasShareReward
    .updateMany({ where: { id: order.shareRewardId, status: 'reserved' }, data: { status: 'used', usedAt: new Date(), reservedOrderId: order.id } })
    .catch((e) => logger.warn({ err: e, orderId: order.id }, 'markShareRewardUsed failed'))
}

/**
 * Sweep: a reservation whose every order ended expired/cancelled/refunded (or whose order
 * was never created, after 10 min) goes back to `approved` so the user keeps their reward.
 */
export async function releaseStaleShareRewards(): Promise<number> {
  const reserved = await db.gasShareReward.findMany({ where: { status: 'reserved' }, select: { id: true, updatedAt: true } })
  if (reserved.length === 0) return 0
  const orders = await db.gasFeeOrder.findMany({
    where: { shareRewardId: { in: reserved.map((r) => r.id) } },
    select: { shareRewardId: true, status: true },
  })
  const DEAD = new Set(['expired', 'cancelled', 'refunded'])
  let released = 0
  for (const r of reserved) {
    const mine = orders.filter((o) => o.shareRewardId === r.id)
    const dead = mine.length === 0 ? Date.now() - r.updatedAt.getTime() > 10 * 60_000 : mine.every((o) => DEAD.has(o.status))
    if (!dead) continue
    const res = await db.gasShareReward.updateMany({ where: { id: r.id, status: 'reserved' }, data: { status: 'approved' } })
    released += res.count
  }
  if (released > 0) logger.info({ released }, 'released stale share-reward reservations')
  return released
}
