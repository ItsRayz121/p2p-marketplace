/**
 * Pure rules for the Community Tasks workspace (no DB, no env) so they can be unit tested.
 * The service layer (platformTask.service.ts / platformTaskWorkspace.service.ts) applies them.
 */

export const PROOF_FOLDER = 'rupchain/task-proof'
export const MAX_ATTACHMENTS = 4
export const MAX_LINKS = 3
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const ALLOWED_ATTACHMENT_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const
export const PLATFORMS = ['telegram', 'x', 'youtube', 'instagram', 'facebook', 'tiktok', 'discord', 'whatsapp', 'other'] as const

export type ClaimStatus = 'pending_review' | 'needs_changes' | 'awaiting_payout' | 'completed' | 'rejected'
export type Decision = 'approve' | 'request_changes' | 'reject'

export interface Attachment { url: string; name: string; size: number; mime: string }

/** Lifecycle shown to admins. Kept separate from submission status. */
export type TaskLifecycle = 'draft' | 'scheduled' | 'active' | 'paused' | 'ended' | 'archived'

export function taskLifecycle(
  t: { isDraft: boolean; archivedAt: Date | null; isActive: boolean; startsAt: Date | null; endsAt: Date | null },
  now: Date,
): TaskLifecycle {
  if (t.archivedAt) return 'archived'
  if (t.isDraft) return 'draft'
  if (!t.isActive) return 'paused'
  if (t.endsAt && t.endsAt <= now) return 'ended'
  if (t.startsAt && t.startsAt > now) return 'scheduled'
  return 'active'
}

/** New participation is only possible while a task is live (not draft/paused/ended/archived/not-started). */
export const acceptsClaims = (l: TaskLifecycle): boolean => l === 'active'

export class RuleError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

const HTTPS = /^https:\/\/[^\s/$.?#][^\s]*$/i

/** Submitted links: https only, de-duplicated, capped. Returns the cleaned list. */
export function cleanLinks(input: unknown): string[] {
  if (input == null) return []
  if (!Array.isArray(input)) throw new RuleError('VALIDATION_ERROR', 'Links must be a list.')
  const out: string[] = []
  for (const raw of input) {
    if (typeof raw !== 'string') throw new RuleError('VALIDATION_ERROR', 'Each link must be text.')
    const v = raw.trim()
    if (!v) continue
    if (v.length > 300 || !HTTPS.test(v)) throw new RuleError('VALIDATION_ERROR', 'Links must be valid https:// addresses.')
    if (!out.includes(v)) out.push(v)
  }
  if (out.length > MAX_LINKS) throw new RuleError('VALIDATION_ERROR', `Add at most ${MAX_LINKS} links.`)
  return out
}

/**
 * Attachments must be our own private proof uploads: a Cloudinary URL inside the task-proof
 * folder, an image type we allow, within the size limit. Anything else is rejected, so a
 * member can never point the reviewer's browser at an arbitrary third-party URL.
 */
export function cleanAttachments(input: unknown, cloudHost = 'res.cloudinary.com'): Attachment[] {
  if (input == null) return []
  if (!Array.isArray(input)) throw new RuleError('VALIDATION_ERROR', 'Attachments must be a list.')
  if (input.length > MAX_ATTACHMENTS) throw new RuleError('VALIDATION_ERROR', `Attach at most ${MAX_ATTACHMENTS} files.`)
  const out: Attachment[] = []
  for (const a of input as Array<Record<string, unknown>>) {
    const url = typeof a?.url === 'string' ? a.url : ''
    let host = ''
    let path = ''
    try { const u = new URL(url); host = u.hostname; path = u.pathname } catch { /* invalid */ }
    if (host !== cloudHost || !path.includes(`/${PROOF_FOLDER}/`)) throw new RuleError('VALIDATION_ERROR', 'Attachments must be uploaded through RupChain.')
    const mime = typeof a.mime === 'string' ? a.mime : ''
    if (!(ALLOWED_ATTACHMENT_MIME as readonly string[]).includes(mime)) throw new RuleError('VALIDATION_ERROR', 'Only JPG, PNG or WebP images are allowed.')
    const size = Number(a.size)
    if (!Number.isFinite(size) || size <= 0 || size > MAX_ATTACHMENT_BYTES) throw new RuleError('VALIDATION_ERROR', 'Each file must be 10 MB or smaller.')
    const name = (typeof a.name === 'string' ? a.name : 'proof').replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'proof'
    if (out.some((o) => o.url === url)) continue
    out.push({ url, name, size, mime })
  }
  return out
}

/** A manual-review submission needs something to review, and a file if the task demands one. */
export function assertEvidence(
  task: { verifyMode: string; proofFileRequired: boolean },
  ev: { proof: string; links: string[]; attachments: Attachment[] },
): void {
  if (task.verifyMode !== 'manual_proof') return
  if (task.proofFileRequired && ev.attachments.length === 0) throw new RuleError('VALIDATION_ERROR', 'Attach a screenshot as proof for this task.')
  if (!ev.proof.trim() && ev.links.length === 0 && ev.attachments.length === 0) {
    throw new RuleError('VALIDATION_ERROR', 'Add your proof (username, link, screenshot or a short note).')
  }
  if (ev.proof.length > 500) throw new RuleError('VALIDATION_ERROR', 'Proof note must be 500 characters or fewer.')
}

/** Member-facing feedback is mandatory when asking for changes or rejecting. */
export function assertDecision(d: { decision: Decision; feedback?: string | null | undefined }): void {
  if (d.decision !== 'approve') {
    const f = (d.feedback ?? '').trim()
    if (f.length < 5) throw new RuleError('VALIDATION_ERROR', 'Write feedback the member will see (at least 5 characters).')
    if (f.length > 1000) throw new RuleError('VALIDATION_ERROR', 'Feedback must be 1000 characters or fewer.')
  }
}

/** Status the claim moves to for a decision, given what approving means for this task. */
export function nextStatus(d: Decision, finalOnApprove: 'completed' | 'awaiting_payout'): ClaimStatus {
  if (d === 'approve') return finalOnApprove
  return d === 'reject' ? 'rejected' : 'needs_changes'
}

export const canResubmit = (s: string): boolean => s === 'needs_changes'

/** Reviewers only act on revisions waiting in the queue. */
export const isReviewable = (s: string): boolean => s === 'pending_review'

export function waitingHours(submittedAt: Date, now: Date): number {
  return Math.max(0, (now.getTime() - submittedAt.getTime()) / 3_600_000)
}

/** Terms frozen at claim time so later edits to a task can't change an existing entitlement. */
export function buildSnapshot(t: {
  title: string; instructions: string | null; proofRequirements: string | null; proofFileRequired: boolean
  verifyMode: string; rewardType: string; rewardPoints: unknown; rewardUsdt: unknown; payoutMode: string; version: number
}): Record<string, unknown> {
  return {
    title: t.title, instructions: t.instructions, proofRequirements: t.proofRequirements, proofFileRequired: t.proofFileRequired,
    verifyMode: t.verifyMode, rewardType: t.rewardType, rewardPoints: t.rewardPoints != null ? String(t.rewardPoints) : null,
    rewardUsdt: t.rewardUsdt != null ? String(t.rewardUsdt) : null, payoutMode: t.payoutMode, version: t.version,
  }
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** UTC day key YYYY-MM-DD. */
export const dayKey = (d: Date): string => d.toISOString().slice(0, 10)

/** Continuous day buckets from..to inclusive (UTC), zero-filled, so charts have no gaps. */
export function dayBuckets(from: Date, to: Date, maxDays = 366): string[] {
  const out: string[] = []
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()))
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate())
  while (cur.getTime() <= end && out.length < maxDays) { out.push(dayKey(cur)); cur.setUTCDate(cur.getUTCDate() + 1) }
  return out
}

// ── Reporting helpers ─────────────────────────────────────────────────────────

export interface Period { from: Date; to: Date }

/** Parse ?from&to (ISO dates). Defaults to the last 30 days; caps the span at one year. */
export function parsePeriod(from?: string, to?: string, now = new Date()): Period {
  const end = to && !Number.isNaN(Date.parse(to)) ? new Date(to) : now
  const startDefault = new Date(end.getTime() - 29 * 86_400_000)
  let start = from && !Number.isNaN(Date.parse(from)) ? new Date(from) : startDefault
  if (start > end) start = startDefault
  if (end.getTime() - start.getTime() > 366 * 86_400_000) start = new Date(end.getTime() - 366 * 86_400_000)
  return { from: start, to: end }
}

export type PaymentState = 'credited' | 'awaiting_payment' | 'processing' | 'failed' | 'paid'

export function paymentState(c: { rewardType: string; payoutMode: string | null; status: string; txHash: string | null; payoutAttempt?: string | null }): PaymentState {
  if (c.rewardType === 'points') return 'credited'
  if (c.status === 'awaiting_payout') {
    return c.payoutAttempt === 'processing' ? 'processing' : c.payoutAttempt === 'failed' ? 'failed' : 'awaiting_payment'
  }
  // Completed USDT: either credited to the internal wallet automatically, or paid on-chain with a recorded hash.
  return c.payoutMode === 'manual' || c.txHash ? 'paid' : 'credited'
}

