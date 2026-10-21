/**
 * X post verification for Share & Earn.
 *
 * Read-only: the provider (twitterapi.io by default) only looks a public post up by id. Nothing
 * here posts, likes or follows on anyone's behalf, and no X credentials are ever handled.
 *
 * A check can never approve a reward by itself unless an admin switched on auto-approve. It
 * either finds a concrete, user-fixable problem (changes_required), passes (queued for approval
 * with a green summary), or comes back inconclusive (provider down / data missing) and stays in
 * manual review. A provider error is never treated as a failed post.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { db } from '../prisma'
import { redis } from '../redis'
import { env } from '../env'
import { logger } from '../logger'
import { AppError } from '../errors'
import { createAdminNotif } from '../../services/adminNotification.service'

const X_VERIFY_ENABLED_KEY = 'x_verify_enabled'            // default OFF until an admin sets it up
export const X_VERIFY_AUTO_APPROVE_KEY = 'x_verify_auto_approve'  // default OFF
const X_PROVIDER_BASE_KEY = 'x_provider_base_url'          // default https://api.twitterapi.io
const X_PROVIDER_KEY_ENC = 'x_provider_api_key_enc'        // AES-256-GCM, never returned to the browser
const X_VERIFY_DAILY_BUDGET_KEY = 'x_verify_daily_budget'  // max provider lookups per UTC day
const X_VERIFY_LOW_CREDITS_KEY = 'x_verify_low_credits'    // alert admins below this many credits
const X_VERIFY_LAST_ERROR_KEY = 'x_verify_last_error'
const X_VERIFY_LAST_CREDITS_KEY = 'x_verify_last_credits'

const DEFAULT_PROVIDER_BASE = 'https://api.twitterapi.io'
const MAX_ATTEMPTS_PER_REWARD = 4
const REQUEST_TIMEOUT_MS = 8_000
/** A post may be a little late relative to the offer window (clock skew, slow posting). */
const WINDOW_GRACE_MS = 10 * 60_000

// ── Secret handling ──────────────────────────────────────────────────────────

function masterKey(): Buffer | null {
  return env.WALLET_MASTER_KEY ? Buffer.from(env.WALLET_MASTER_KEY, 'hex') : null
}

export function encryptSecret(plain: string): string {
  const key = masterKey()
  if (!key) throw new AppError('SERVICE_UNAVAILABLE', 'Secret storage is not configured on the server', 503)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')
}

export function decryptSecret(blob: string): string | null {
  const key = masterKey()
  if (!key) return null
  try {
    const buf = Buffer.from(blob, 'base64')
    const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12))
    d.setAuthTag(buf.subarray(12, 28))
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')
  } catch {
    return null
  }
}

async function readConfig(key: string): Promise<string | null> {
  const row = await db.platformConfig.findUnique({ where: { key } })
  const v = row?.value?.trim()
  return v ? v : null
}

export async function writeConfig(key: string, value: string): Promise<void> {
  await db.platformConfig.upsert({ where: { key }, update: { value }, create: { key, value } })
}

async function getApiKey(): Promise<string | null> {
  const enc = await readConfig(X_PROVIDER_KEY_ENC)
  const fromDb = enc ? decryptSecret(enc) : null
  return fromDb ?? process.env.TWITTERAPI_IO_KEY?.trim() ?? null
}

// ── Provider adapter ─────────────────────────────────────────────────────────

export interface XPost {
  id: string
  text: string
  createdAt: Date | null
  authorHandle: string | null
  /** Expanded URLs when the provider returns entity data; null when it only gives shortened links. */
  urls: string[] | null
  hasMedia: boolean | null
  isReply: boolean
  isRetweet: boolean
}

export class ProviderError extends Error {
  constructor(message: string, readonly kind: 'auth' | 'budget' | 'transient' | 'not_found') {
    super(message)
  }
}

export interface XProvider {
  readonly name: string
  getPost(id: string): Promise<XPost | null>
  getCredits(): Promise<number | null>
  /** Profile bio text of an account, or null when the account does not exist. */
  getProfileBio(handle: string): Promise<string | null>
  /** Whether `source` follows `target`; null when the provider did not say. */
  isFollowing(source: string, target: string): Promise<boolean | null>
}

type Json = Record<string, unknown>
const asStr = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** Tolerant of both the nested (`author.userName`, `entities.urls`) and flattened tweet shapes. */
export function parseTweet(raw: Json): XPost | null {
  const id = asStr(raw.id) ?? (typeof raw.id === 'number' ? String(raw.id) : null)
  const text = asStr(raw.text)
  if (!id || text === null) return null
  const author = (raw.author ?? null) as Json | null
  const authorHandle = asStr(author?.userName) ?? asStr(author?.screen_name) ?? asStr(raw.authorUserName)
  const entities = (raw.entities ?? null) as Json | null
  const urlList = entities && Array.isArray(entities.urls) ? (entities.urls as Json[]) : null
  const urls = urlList ? urlList.map((u) => asStr(u.expanded_url) ?? asStr(u.url)).filter((u): u is string => !!u) : null
  const created = asStr(raw.createdAt) ?? asStr(raw.created_at)
  const createdMs = created ? Date.parse(created) : NaN
  const mediaCount = typeof raw.mediaCount === 'number' ? raw.mediaCount : null
  const ext = (raw.extendedEntities ?? raw.extended_entities ?? null) as Json | null
  const hasMedia = typeof raw.hasMedia === 'boolean' ? raw.hasMedia : mediaCount !== null ? mediaCount > 0 : ext ? Array.isArray(ext.media) && ext.media.length > 0 : null
  return {
    id, text,
    createdAt: Number.isFinite(createdMs) ? new Date(createdMs) : null,
    authorHandle,
    urls,
    hasMedia,
    isReply: raw.isReply === true,
    isRetweet: raw.retweeted_tweet != null || /^RT @/.test(text),
  }
}

class TwitterApiIoProvider implements XProvider {
  readonly name = 'twitterapi.io'
  constructor(private readonly base: string, private readonly apiKey: string) {}

  private async get(path: string): Promise<Json> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(`${this.base}${path}`, { headers: { 'X-API-Key': this.apiKey, accept: 'application/json' }, signal: ctrl.signal })
      if (res.status === 401 || res.status === 403) throw new ProviderError('The provider rejected the API key', 'auth')
      if (res.status === 402) throw new ProviderError('The provider account is out of credits', 'budget')
      if (res.status === 404 || res.status === 400) throw new ProviderError('Not found', 'not_found')
      if (!res.ok) throw new ProviderError(`Provider answered HTTP ${res.status}`, 'transient')
      return (await res.json()) as Json
    } catch (err) {
      if (err instanceof ProviderError) throw err
      throw new ProviderError('The provider could not be reached', 'transient')
    } finally {
      clearTimeout(timer)
    }
  }

  async getPost(id: string): Promise<XPost | null> {
    const body = await this.get(`/twitter/tweets?tweet_ids=${encodeURIComponent(id)}`)
    const tweets = Array.isArray(body.tweets) ? (body.tweets as Json[]) : []
    const first = tweets[0]
    return first ? parseTweet(first) : null
  }

  async getProfileBio(handle: string): Promise<string | null> {
    const body = await this.get(`/twitter/user/info?userName=${encodeURIComponent(handle)}`)
    const data = (body.data ?? null) as Json | null
    if (body.status === 'error' || !data) return null
    return typeof data.description === 'string' ? data.description : typeof data.profile_bio === 'string' ? data.profile_bio : ''
  }

  async isFollowing(source: string, target: string): Promise<boolean | null> {
    const body = await this.get(`/twitter/user/check_follow_relationship?source_user_name=${encodeURIComponent(source)}&target_user_name=${encodeURIComponent(target)}`)
    const data = (body.data ?? null) as Json | null
    return typeof data?.following === 'boolean' ? data.following : null
  }

  async getCredits(): Promise<number | null> {
    const body = await this.get('/oapi/my/info')
    const a = typeof body.recharge_credits === 'number' ? body.recharge_credits : 0
    const b = typeof body.total_bonus_credits === 'number' ? body.total_bonus_credits : 0
    return typeof body.recharge_credits === 'number' || typeof body.total_bonus_credits === 'number' ? a + b : null
  }
}

async function buildProvider(): Promise<XProvider | null> {
  const key = await getApiKey()
  if (!key) return null
  const base = ((await readConfig(X_PROVIDER_BASE_KEY)) ?? DEFAULT_PROVIDER_BASE).replace(/\/$/, '')
  // Only ever call an https provider: the key travels in a header.
  if (!/^https:\/\//i.test(base)) return null
  return new TwitterApiIoProvider(base, key)
}

// ── X follow tasks (Platform Tasks) ──────────────────────────────────────────

const RESERVED_X_PATHS = new Set(['home', 'i', 'intent', 'share', 'search', 'hashtag', 'settings', 'explore', 'messages', 'notifications', 'compose', 'login', 'signup'])
const X_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/

/** `https://x.com/RupChain` → `RupChain`. Null for anything that is not a bare profile link. */
export function parseXProfileHandle(url: string | null | undefined): string | null {
  const m = /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?(?:[?#].*)?$/i.exec((url ?? '').trim())
  return m && m[1] && !RESERVED_X_PATHS.has(m[1].toLowerCase()) ? m[1] : null
}

/** What a member typed (`@name`, `name` or a profile link) → a bare handle, or null if invalid. */
export function normaliseXHandle(input: string | null | undefined): string | null {
  const raw = (input ?? '').trim()
  const fromUrl = parseXProfileHandle(raw)
  const h = (fromUrl ?? raw.replace(/^@/, '')).trim()
  return X_HANDLE_RE.test(h) ? h : null
}

/**
 * Per-member code the member puts in their X bio. A follow alone proves nothing (follower lists are
 * public, so anyone could type another follower's handle); the code proves they own the account.
 * Stateless: derived from the user id, so there is nothing to store or expire.
 */
export function xOwnershipCode(userId: string): string {
  return `RC-${createHmac('sha256', env.JWT_SECRET).update(`x-task-owner:${userId}`).digest('hex').slice(0, 8).toUpperCase()}`
}

export type XTaskCheck = 'ok' | 'not_following' | 'code_missing' | 'not_found' | 'unavailable'

/** Spend `n` provider lookups from today's shared budget. False when the day's budget is used up. */
async function takeLookups(n: number): Promise<boolean> {
  const raw = Number((await readConfig(X_VERIFY_DAILY_BUDGET_KEY)) ?? '200')
  const cap = Number.isFinite(raw) && raw > 0 ? raw : 200
  const key = `xtask:lookups:${new Date().toISOString().slice(0, 10)}`
  const used = await redis.incrby(key, n)
  if (used === n) await redis.expire(key, 2 * 86_400)
  if (used > cap) {
    await recordError('Daily verification budget reached; X follow tasks cannot be checked until tomorrow.')
    return false
  }
  return true
}

/** Whether a provider key is saved (used to refuse publishing an X task that could never verify). */
export async function hasXProviderKey(): Promise<boolean> {
  return !!(await getApiKey())
}

/**
 * Checks (1) the account exists and its bio carries the member's code, then (2) that it follows
 * `target`. A provider failure is `unavailable`, never "not following".
 */
export async function checkXFollowTask(handle: string, target: string, userId: string): Promise<XTaskCheck> {
  const provider = await buildProvider()
  if (!provider) return 'unavailable'
  if (!(await takeLookups(2))) return 'unavailable'
  try {
    let bio: string | null
    try {
      bio = await provider.getProfileBio(handle)
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'not_found') return 'not_found'
      throw err
    }
    if (bio === null) return 'not_found'
    if (!bio.toUpperCase().includes(xOwnershipCode(userId))) return 'code_missing'
    const following = await provider.isFollowing(handle, target)
    if (following === null) {
      await recordError('The provider did not return follow data.')
      return 'unavailable'
    }
    await recordError(null)
    return following ? 'ok' : 'not_following'
  } catch (err) {
    logger.warn({ err }, 'x follow task check failed')
    await recordError(err instanceof Error ? err.message : 'Provider error')
    return 'unavailable'
  }
}

// ── Pure checks (unit-testable) ──────────────────────────────────────────────

export interface CheckInput {
  post: XPost
  orderRef: string
  handle: string | null
  windowStart: Date
  windowEnd: Date
}

export interface CheckResult {
  outcome: 'passed' | 'failed' | 'inconclusive'
  /** Problems the user can fix by editing or reposting. */
  issues: string[]
  /** Things we could not verify (shown to admins only). */
  unknown: string[]
}

export function checkPost(i: CheckInput): CheckResult {
  const issues: string[] = []
  const unknown: string[] = []
  const text = i.post.text

  if (i.post.isRetweet) issues.push('Post your own message, not a repost.')
  if (i.post.isReply) issues.push('Post it as a new post, not a reply.')

  if (i.handle) {
    const re = new RegExp(`(^|[^A-Za-z0-9_])@${i.handle.replace(/[^A-Za-z0-9_]/g, '')}(?![A-Za-z0-9_])`, 'i')
    if (!re.test(text)) issues.push(`Mention @${i.handle} in the post.`)
  }
  if (!/(^|\s)#rupchain\b/i.test(text)) issues.push('Include the #RupChain hashtag.')
  if (!/(^|\s)#ad\b/i.test(text)) issues.push('Keep the #ad disclosure in the post.')

  if (i.post.urls === null) {
    unknown.push('Could not read link details from the provider.')
  } else if (!i.post.urls.some((u) => u.includes(`/s/${i.orderRef}`))) {
    issues.push('Keep the link to your order from the suggested post.')
  }

  if (!i.post.createdAt) {
    unknown.push('Could not read when the post was published.')
  } else {
    const t = i.post.createdAt.getTime()
    if (t < i.windowStart.getTime()) issues.push('The post must be published after your order was delivered.')
    else if (t > i.windowEnd.getTime() + WINDOW_GRACE_MS) issues.push('The post was published after the offer ended.')
  }
  if (!i.post.authorHandle) unknown.push('Could not read the post author.')

  if (issues.length) return { outcome: 'failed', issues, unknown }
  if (unknown.length) return { outcome: 'inconclusive', issues, unknown }
  return { outcome: 'passed', issues, unknown }
}

// ── Orchestration ────────────────────────────────────────────────────────────

async function usageToday(): Promise<number> {
  const start = new Date()
  start.setUTCHours(0, 0, 0, 0)
  return db.gasShareReward.count({ where: { verifyCheckedAt: { gte: start } } })
}

async function recordError(msg: string | null): Promise<void> {
  await writeConfig(X_VERIFY_LAST_ERROR_KEY, msg ? `${new Date().toISOString()} ${msg}` : '').catch(() => {})
}

export interface VerifyOutcome {
  ran: boolean
  outcome?: CheckResult['outcome']
  reason?: string
}

/**
 * Look the submitted post up and record the result. Safe to call repeatedly: attempts are capped
 * per reward and per day, and an atomic counter claim stops two requests from both spending credits.
 */
export async function verifyShareReward(rewardId: string, opts: { force?: boolean } = {}): Promise<VerifyOutcome> {
  const enabled = (await readConfig(X_VERIFY_ENABLED_KEY)) === 'true'
  if (!enabled) return { ran: false, reason: 'Automatic verification is off.' }
  const provider = await buildProvider()
  if (!provider) return { ran: false, reason: 'No provider API key is configured.' }

  const budget = Number((await readConfig(X_VERIFY_DAILY_BUDGET_KEY)) ?? '200')
  if ((await usageToday()) >= (Number.isFinite(budget) ? budget : 200)) {
    await recordError('Daily verification budget reached; new posts wait for manual review.')
    return { ran: false, reason: 'Daily verification budget reached.' }
  }

  const reward = await db.gasShareReward.findUnique({ where: { id: rewardId } })
  if (!reward || !['submitted', 'changes_required'].includes(reward.status)) return { ran: false, reason: 'Nothing to verify.' }
  // Atomic claim: only one caller wins the next attempt number.
  const claim = await db.gasShareReward.updateMany({
    where: { id: rewardId, verifyAttempts: { lt: opts.force ? MAX_ATTEMPTS_PER_REWARD + 3 : MAX_ATTEMPTS_PER_REWARD }, OR: [{ verifyCheckedAt: null }, { verifyCheckedAt: { lt: new Date(Date.now() - 20_000) } }] },
    data: { verifyAttempts: { increment: 1 }, verifyCheckedAt: new Date() },
  })
  if (claim.count === 0) return { ran: false, reason: 'Checked too recently or too many attempts.' }

  const order = await db.gasFeeOrder.findUnique({ where: { id: reward.sourceOrderId } })
  if (!order) return { ran: false, reason: 'Order missing.' }

  let post: XPost | null
  try {
    post = await provider.getPost(reward.postKey)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Provider error'
    logger.warn({ err, rewardId }, 'x verification lookup failed')
    await recordError(msg)
    await db.gasShareReward.update({ where: { id: rewardId }, data: { verifyStatus: 'inconclusive', verifyIssues: [] } })
    return { ran: true, outcome: 'inconclusive', reason: msg }
  }
  if (!post) {
    const issues = ['We could not find that post. Make sure it is public and the link is correct.']
    await db.gasShareReward.update({ where: { id: rewardId }, data: { status: 'changes_required', verifyStatus: 'failed', verifyIssues: issues } })
    return { ran: true, outcome: 'failed' }
  }

  const windowHours = Number((await readConfig('share_reward_window_hours')) ?? '1')
  const start = order.deliveredAt ?? order.updatedAt
  const handle = (await readConfig('share_reward_x_handle'))?.replace(/^@/, '') ?? null
  const result = checkPost({
    post, orderRef: order.orderRef, handle,
    windowStart: start,
    windowEnd: new Date(start.getTime() + (Number.isFinite(windowHours) ? windowHours : 1) * 3_600_000),
  })

  await db.gasShareReward.update({
    where: { id: rewardId },
    data: {
      verifyStatus: result.outcome,
      verifyIssues: result.outcome === 'failed' ? result.issues : result.unknown,
      postAuthor: post.authorHandle,
      postCreatedAt: post.createdAt,
      ...(result.outcome === 'failed' ? { status: 'changes_required' } : {}),
    },
  })
  await recordError(null)
  // Every tenth lookup of the day, refresh the balance so admins hear about low credits in time.
  if ((await usageToday()) % 10 === 0) {
    provider.getCredits().then(async (c) => { await writeConfig(X_VERIFY_LAST_CREDITS_KEY, c === null ? '' : String(c)); await alertIfLow(c) }).catch(() => {})
  }
  return { ran: true, outcome: result.outcome }
}

export interface XSettingsView {
  enabled: boolean
  autoApprove: boolean
  provider: string
  baseUrl: string
  hasKey: boolean
  keyHint: string | null
  dailyBudget: number
  usedToday: number
  lowCreditsAlert: number
  officialHandle: string | null
  lastError: string | null
  lastCredits: number | null
}

export async function getXSettings(): Promise<XSettingsView> {
  const [enabled, auto, base, enc, budget, low, handle, lastError, lastCredits, used] = await Promise.all([
    readConfig(X_VERIFY_ENABLED_KEY), readConfig(X_VERIFY_AUTO_APPROVE_KEY), readConfig(X_PROVIDER_BASE_KEY),
    readConfig(X_PROVIDER_KEY_ENC), readConfig(X_VERIFY_DAILY_BUDGET_KEY), readConfig(X_VERIFY_LOW_CREDITS_KEY),
    readConfig('share_reward_x_handle'), readConfig(X_VERIFY_LAST_ERROR_KEY), readConfig(X_VERIFY_LAST_CREDITS_KEY), usageToday(),
  ])
  const key = await getApiKey()
  return {
    enabled: enabled === 'true',
    autoApprove: auto === 'true',
    provider: 'twitterapi.io',
    baseUrl: base ?? DEFAULT_PROVIDER_BASE,
    hasKey: !!key || !!enc,
    // Only the last four characters, never the key itself.
    keyHint: key ? `••••${key.slice(-4)}` : null,
    dailyBudget: Number(budget ?? '200') || 200,
    usedToday: used,
    lowCreditsAlert: Number(low ?? '10000') || 10000,
    officialHandle: handle?.replace(/^@/, '') ?? null,
    lastError,
    lastCredits: lastCredits !== null && lastCredits !== '' ? Number(lastCredits) : null,
  }
}

export interface XSettingsInput {
  enabled?: boolean | undefined
  autoApprove?: boolean | undefined
  apiKey?: string | undefined
  baseUrl?: string | undefined
  dailyBudget?: number | undefined
  lowCreditsAlert?: number | undefined
  officialHandle?: string | undefined
}

export async function saveXSettings(i: XSettingsInput): Promise<void> {
  if (i.enabled !== undefined) await writeConfig(X_VERIFY_ENABLED_KEY, String(i.enabled))
  if (i.autoApprove !== undefined) await writeConfig(X_VERIFY_AUTO_APPROVE_KEY, String(i.autoApprove))
  if (i.dailyBudget !== undefined) await writeConfig(X_VERIFY_DAILY_BUDGET_KEY, String(Math.max(1, Math.min(100_000, Math.floor(i.dailyBudget)))))
  if (i.lowCreditsAlert !== undefined) await writeConfig(X_VERIFY_LOW_CREDITS_KEY, String(Math.max(0, Math.floor(i.lowCreditsAlert))))
  if (i.officialHandle !== undefined) {
    const h = i.officialHandle.trim().replace(/^@/, '')
    if (h && !/^[A-Za-z0-9_]{1,15}$/.test(h)) throw new AppError('VALIDATION_ERROR', 'That is not a valid X handle', 400)
    await writeConfig('share_reward_x_handle', h)
  }
  if (i.baseUrl !== undefined) {
    const b = i.baseUrl.trim().replace(/\/$/, '')
    if (b && !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(b)) throw new AppError('VALIDATION_ERROR', 'The provider URL must start with https://', 400)
    await writeConfig(X_PROVIDER_BASE_KEY, b)
  }
  if (i.apiKey !== undefined && i.apiKey.trim()) await writeConfig(X_PROVIDER_KEY_ENC, encryptSecret(i.apiKey.trim()))
}

async function alertIfLow(credits: number | null): Promise<void> {
  if (credits === null) return
  const low = Number((await readConfig(X_VERIFY_LOW_CREDITS_KEY)) ?? '10000') || 10000
  if (credits >= low) return
  void createAdminNotif({
    category: 'GAS',
    title: 'X verification credits are low',
    body: `Only ${credits.toLocaleString('en-US')} provider credits are left. Top up so Share & Earn posts keep being checked automatically.`,
    href: '/admin/gas/share-rewards',
    roles: ['admin', 'super_admin'],
    telegram: false,
  })
}

/** Calls the provider once to prove the key works and read the remaining credits. */
export async function testXConnection(): Promise<{ ok: boolean; credits: number | null; message: string }> {
  const provider = await buildProvider()
  if (!provider) return { ok: false, credits: null, message: 'No API key is saved yet.' }
  try {
    const credits = await provider.getCredits()
    await writeConfig(X_VERIFY_LAST_CREDITS_KEY, credits === null ? '' : String(credits))
    await recordError(null)
    await alertIfLow(credits)
    return { ok: true, credits, message: credits === null ? 'Connected. The provider did not report a credit balance.' : `Connected. ${credits.toLocaleString('en-US')} credits left.` }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not reach the provider'
    await recordError(message)
    return { ok: false, credits: null, message }
  }
}
