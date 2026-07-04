// Social profile links for a user — the single source of truth is
// User.socialLinks (Json array). Links approved via KYC are marked `verified`
// and can never be deleted (only hidden); the user may add their own extra
// (unverified) links and toggle whether the set is shown publicly on their
// profile (User.socialLinksPublic).
import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'

export interface SocialLink {
  id: string
  platform: string   // e.g. "YouTube", "Instagram", "Facebook", "Twitter/X"
  url: string
  verified: boolean   // came from an approved KYC submission
  hidden: boolean      // user hid it (e.g. a dead link) — kept for verified ones
}

// Canonical platform key for de-duplication (case/spacing/alias-insensitive).
export function normalizePlatform(p: string): string {
  const s = (p || '').toLowerCase().trim()
  if (s === 'x' || s === 'twitter' || s === 'twitter/x') return 'twitter'
  if (s === 'ig') return 'instagram'
  if (s === 'fb') return 'facebook'
  return s.replace(/[^a-z0-9]/g, '')
}

function normalizeUrl(u: string): string {
  return (u || '').trim().replace(/\/+$/, '').toLowerCase()
}

function genId(): string {
  return Math.random().toString(36).slice(2, 10)
}

// Read + coerce the stored Json into a typed array (tolerant of legacy shapes).
export function parseSocialLinks(raw: unknown): SocialLink[] {
  if (!Array.isArray(raw)) return []
  const out: SocialLink[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const platform = typeof r.platform === 'string' ? r.platform : ''
    const url = typeof r.url === 'string' ? r.url : ''
    if (!platform || !url) continue
    out.push({
      id: typeof r.id === 'string' && r.id ? r.id : genId(),
      platform,
      url,
      verified: r.verified === true,
      hidden: r.hidden === true,
    })
  }
  return out
}

export async function getSocialProfile(userId: string): Promise<{ links: SocialLink[]; public: boolean }> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { socialLinks: true, socialLinksPublic: true } })
  return { links: parseSocialLinks(user?.socialLinks), public: user?.socialLinksPublic ?? false }
}

async function saveLinks(userId: string, links: SocialLink[]): Promise<SocialLink[]> {
  await db.user.update({ where: { id: userId }, data: { socialLinks: links as unknown as object } })
  return links
}

export async function setSocialPublic(userId: string, isPublic: boolean): Promise<void> {
  await db.user.update({ where: { id: userId }, data: { socialLinksPublic: isPublic } })
}

// Add a user-supplied (unverified) link. Rejects a duplicate of an existing link
// (same platform+url) — including verified ones ("you've already added this").
export async function addSocialLink(userId: string, platform: string, url: string): Promise<SocialLink[]> {
  const links = (await getSocialProfile(userId)).links
  const np = normalizePlatform(platform)
  const nu = normalizeUrl(url)
  if (links.some((l) => normalizePlatform(l.platform) === np && normalizeUrl(l.url) === nu)) {
    throw new AppError('DUPLICATE', 'You have already added this social profile.', 400)
  }
  if (links.length >= 15) throw new AppError('LIMIT', 'You can add up to 15 social profiles.', 400)
  links.push({ id: genId(), platform, url: url.trim(), verified: false, hidden: false })
  return saveLinks(userId, links)
}

export async function setSocialLinkHidden(userId: string, id: string, hidden: boolean): Promise<SocialLink[]> {
  const links = (await getSocialProfile(userId)).links
  const link = links.find((l) => l.id === id)
  if (!link) throw new AppError('NOT_FOUND', 'Social link not found', 404)
  link.hidden = hidden
  return saveLinks(userId, links)
}

// Delete a link — only allowed for UNVERIFIED links. Verified (KYC) links can be
// hidden but never removed, so the identity trail stays intact.
export async function deleteSocialLink(userId: string, id: string): Promise<SocialLink[]> {
  const links = (await getSocialProfile(userId)).links
  const link = links.find((l) => l.id === id)
  if (!link) throw new AppError('NOT_FOUND', 'Social link not found', 404)
  if (link.verified) throw new AppError('FORBIDDEN', 'Verified links cannot be deleted — hide it instead.', 400)
  return saveLinks(userId, links.filter((l) => l.id !== id))
}

// Merge KYC-submitted links into the user's set as VERIFIED (idempotent by
// platform+url). Called on KYC approval — verified links become the permanent,
// trusted base the user can hide but not delete.
export async function mergeVerifiedFromKyc(
  userId: string,
  incoming: Array<{ platform: string; url: string }>,
): Promise<void> {
  if (!incoming?.length) return
  const links = (await getSocialProfile(userId)).links
  for (const raw of incoming) {
    if (!raw?.platform || !raw?.url) continue
    const np = normalizePlatform(raw.platform)
    const nu = normalizeUrl(raw.url)
    const existing = links.find((l) => normalizePlatform(l.platform) === np && normalizeUrl(l.url) === nu)
    if (existing) { existing.verified = true }
    else links.push({ id: genId(), platform: raw.platform, url: raw.url.trim(), verified: true, hidden: false })
  }
  await saveLinks(userId, links)
}

// The set of platform keys the user has ALREADY verified — used to avoid asking
// for the same social again in a later KYC step.
export async function verifiedPlatforms(userId: string): Promise<string[]> {
  const links = (await getSocialProfile(userId)).links
  return [...new Set(links.filter((l) => l.verified).map((l) => normalizePlatform(l.platform)))]
}
