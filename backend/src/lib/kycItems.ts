/**
 * Document-level KYC review: which parts a submission has, what each decision means, and how the two
 * halves (Basic = identity, Enhanced = ad posting) settle. Pure functions only, so the rules are testable.
 */

export type KycItem = 'id_front' | 'id_back' | 'selfie' | 'legal_name' | 'social' | 'whatsapp' | 'community' | 'reference'
export type KycPart = 'basic' | 'enhanced'
/** What a reviewer can record about one item. `resubmitted` is written when the applicant replaces it. */
export type ItemDecision = 'approved' | 'resubmit' | 'rejected'
export type ItemStatus = ItemDecision | 'resubmitted' | 'pending'

const ITEM_PART: Record<KycItem, KycPart> = {
  id_front: 'basic', id_back: 'basic', selfie: 'basic', legal_name: 'basic', social: 'basic',
  whatsapp: 'enhanced', community: 'enhanced', reference: 'enhanced',
}

export const ITEM_LABEL: Record<KycItem, string> = {
  id_front: 'ID front', id_back: 'ID back', selfie: 'Selfie', legal_name: 'Full name', social: 'Social profiles',
  whatsapp: 'WhatsApp number', community: 'Community link', reference: 'Trusted reference',
}

export interface SubmissionShape {
  tier: 'basic' | 'enhanced'
  idType: string
  backUrl: string | null
  legalName: string | null
  socialLinks: unknown
  whatsappNumber: string | null
  communityLinks: unknown
  referenceUrl: string | null
}

const nonEmptyArray = (v: unknown) => Array.isArray(v) && v.length > 0

/** The parts of this submission that exist and can be reviewed. */
export function itemsOf(s: SubmissionShape): KycItem[] {
  const out: KycItem[] = ['id_front']
  if (s.idType !== 'passport' && s.backUrl) out.push('id_back')
  out.push('selfie')
  if (s.legalName?.trim()) out.push('legal_name')
  if (nonEmptyArray(s.socialLinks)) out.push('social')
  if (s.tier === 'enhanced') {
    out.push('whatsapp', 'community')
    if (s.referenceUrl?.trim()) out.push('reference')
  }
  return out
}

export interface ReviewEvent { item: string; status: string; reason: string | null; createdAt: Date }

/** Latest decision per item (events are append-only). An item with no event is `pending`. */
export function currentItems(items: KycItem[], events: ReviewEvent[]): Array<{ item: KycItem; part: KycPart; status: ItemStatus; reason: string | null; at: Date | null }> {
  const latest = new Map<string, ReviewEvent>()
  for (const e of [...events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) latest.set(e.item, e)
  return items.map((item) => {
    const e = latest.get(item)
    const status = (e?.status ?? 'pending') as ItemStatus
    return { item, part: ITEM_PART[item], status, reason: e?.reason ?? null, at: e?.createdAt ?? null }
  })
}

/** Needs the applicant to send something again. */
export const isFlagged = (s: ItemStatus) => s === 'resubmit' || s === 'rejected'

export interface Parts { basicState: string; enhancedState: string }

/**
 * Overall submission status from the two parts. A submission is `pending` while either part still
 * needs a decision (including one waiting for the applicant); `approved` once Basic is approved and
 * nothing else is open; `rejected` when Basic is rejected (Enhanced cannot stand without it).
 */
export function settleStatus(p: Parts): 'pending' | 'approved' | 'rejected' {
  if (p.basicState === 'rejected') return 'rejected'
  const open = (s: string) => s === 'pending' || s === 'changes_requested'
  if (open(p.basicState) || open(p.enhancedState)) return 'pending'
  return p.basicState === 'approved' ? 'approved' : 'rejected'
}

/** The submission is waiting on the applicant, not on a reviewer. */
export function waitingOnApplicant(p: Parts): boolean {
  const needsReview = p.basicState === 'pending' || p.enhancedState === 'pending'
  const waiting = p.basicState === 'changes_requested' || p.enhancedState === 'changes_requested'
  return waiting && !needsReview
}

/** Which approvals are allowed right now, and why not. */
export function approvalBlock(part: KycPart, p: Parts, items: Array<{ part: KycPart; status: ItemStatus; item: KycItem }>): string | null {
  const state = part === 'basic' ? p.basicState : p.enhancedState
  if (state === 'approved') return `${part === 'basic' ? 'Basic' : 'Enhanced'} is already approved.`
  if (state === 'rejected') return `${part === 'basic' ? 'Basic' : 'Enhanced'} was rejected.`
  if (state === 'not_requested') return 'The applicant did not apply for Enhanced.'
  if (part === 'enhanced' && p.basicState !== 'approved') return 'Approve Basic first: Enhanced builds on a verified identity.'
  const flagged = items.filter((i) => i.part === part && isFlagged(i.status))
  if (flagged.length > 0) return `Some items still need changes: ${flagged.map((i) => ITEM_LABEL[i.item]).join(', ')}.`
  return null
}
