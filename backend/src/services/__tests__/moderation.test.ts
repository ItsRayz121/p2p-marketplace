/**
 * Unit tests for the moderation status derivation (Admin Audit Phase 1).
 * Pure logic — no DB/RPC. Covers status precedence: ban > suspend > review > active,
 * and temporary vs permanent ban classification.
 */
import { describe, it, expect } from 'vitest'
import { computeModerationStatus, moderationStatusLabel } from '../../lib/moderation'

const base = { isBanned: false, isSuspended: false, bannedUntil: null, underReview: false }

describe('computeModerationStatus', () => {
  it('returns active for an unrestricted user', () => {
    expect(computeModerationStatus({ ...base })).toBe('active')
  })

  it('classifies a permanent ban (no bannedUntil)', () => {
    expect(computeModerationStatus({ ...base, isBanned: true })).toBe('permanently_banned')
  })

  it('classifies a temporary ban (bannedUntil set)', () => {
    expect(computeModerationStatus({ ...base, isBanned: true, bannedUntil: new Date() })).toBe('temporarily_banned')
  })

  it('returns suspended when suspended and not banned', () => {
    expect(computeModerationStatus({ ...base, isSuspended: true })).toBe('suspended')
  })

  it('returns under_review when only the review flag is set', () => {
    expect(computeModerationStatus({ ...base, underReview: true })).toBe('under_review')
  })

  it('prioritises ban over suspension', () => {
    expect(computeModerationStatus({ ...base, isBanned: true, isSuspended: true })).toBe('permanently_banned')
  })

  it('prioritises suspension over review', () => {
    expect(computeModerationStatus({ ...base, isSuspended: true, underReview: true })).toBe('suspended')
  })

  it('temporary ban classification wins even if suspended flags linger', () => {
    expect(computeModerationStatus({ ...base, isBanned: true, bannedUntil: new Date(), isSuspended: true })).toBe('temporarily_banned')
  })
})

describe('moderationStatusLabel', () => {
  it('maps every status to a human label', () => {
    expect(moderationStatusLabel('active')).toBe('Active')
    expect(moderationStatusLabel('suspended')).toBe('Suspended')
    expect(moderationStatusLabel('temporarily_banned')).toBe('Temporarily Banned')
    expect(moderationStatusLabel('permanently_banned')).toBe('Permanently Banned')
    expect(moderationStatusLabel('under_review')).toBe('Under Review')
  })
})
