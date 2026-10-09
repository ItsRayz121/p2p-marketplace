import { Prisma } from '@prisma/client'
import { db } from './prisma'

// ─── Contact details shared across accounts ──────────────────────────────────
//
// The KYC review already flags the same ID document on two accounts (CNIC hash).
// One person running several maker accounts usually reuses something else too:
// the WhatsApp number or the community (WhatsApp/Telegram group) they list for
// Level 2. This finds OTHER accounts that use the same number or community link,
// so the reviewer sees it next to the ID warning. It only informs; it never blocks.

export interface SharedAccount { userId: string; username: string | null; email: string | null }
export interface SharedContacts {
  whatsapp: SharedAccount[]
  community: Array<SharedAccount & { url: string }>
}

const HOST_ALIASES: Record<string, string> = {
  'telegram.me': 't.me', 'telegram.dog': 't.me', 'www.t.me': 't.me',
  'www.whatsapp.com': 'whatsapp.com',
}

/**
 * Comparison key for a community link: same group/channel → same key, whatever
 * the host alias, letter case, trailing slash, query string or fragment.
 */
export function communityKey(raw: string): string | null {
  let u: URL
  try { u = new URL(raw.trim()) } catch { return null }
  const host = u.hostname.toLowerCase()
  const path = u.pathname.replace(/\/+$/, '').toLowerCase()
  if (path.replace(/\//g, '').length < 2) return null
  return `${HOST_ALIASES[host] ?? host}${path}`
}

function lastSegment(key: string): string {
  const parts = key.split('/').filter(Boolean)
  return (parts[parts.length - 1] ?? '').replace(/^\+/, '')
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

function readLinks(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((l) => (l && typeof l === 'object' ? (l as { url?: unknown }).url : null)).filter((x): x is string => typeof x === 'string')
}

/**
 * For each submission (keyed by its `id`), list the other accounts that share its WhatsApp number or
 * any of its community links. Batched: a fixed number of queries per page,
 * however many submissions are passed.
 */
export async function findSharedContacts(
  items: Array<{ id: string; userId: string; whatsappNumber: string | null; communityLinks: unknown }>,
): Promise<Map<string, SharedContacts>> {
  const out = new Map<string, SharedContacts>()
  for (const it of items) out.set(it.id, { whatsapp: [], community: [] })
  if (items.length === 0) return out

  // ── WhatsApp: stored normalised (+digits) on both the submission and the user.
  const numbers = [...new Set(items.map((i) => i.whatsappNumber).filter((n): n is string => !!n))]
  const ownersByNumber = new Map<string, Set<string>>()
  if (numbers.length) {
    const [subs, users] = await Promise.all([
      db.kycSubmission.findMany({ where: { whatsappNumber: { in: numbers } }, select: { userId: true, whatsappNumber: true } }),
      db.user.findMany({ where: { whatsappNumber: { in: numbers } }, select: { id: true, whatsappNumber: true } }),
    ])
    for (const r of [...subs.map((s) => ({ userId: s.userId, n: s.whatsappNumber })), ...users.map((u) => ({ userId: u.id, n: u.whatsappNumber }))]) {
      if (!r.n) continue
      const set = ownersByNumber.get(r.n) ?? new Set<string>()
      set.add(r.userId)
      ownersByNumber.set(r.n, set)
    }
  }

  // ── Community links: pre-filter in SQL on the link's last path segment, then
  // compare normalised keys in JS so aliases and case differences still match.
  const keysByItem = new Map<string, Map<string, string>>() // item id → key → original url
  for (const it of items) {
    const m = new Map<string, string>()
    for (const url of readLinks(it.communityLinks)) {
      const k = communityKey(url)
      if (k) m.set(k, url)
    }
    keysByItem.set(it.id, m)
  }
  const allKeys = new Set<string>([...keysByItem.values()].flatMap((m) => [...m.keys()]))
  const ownersByKey = new Map<string, Set<string>>()
  const patterns = [...new Set([...allKeys].map(lastSegment).filter((s) => s.length >= 3))].map((s) => `%${likeEscape(s)}%`)
  if (patterns.length) {
    const rows = await db.$queryRaw<Array<{ userId: string; communityLinks: unknown }>>(Prisma.sql`
      SELECT "userId", "communityLinks" FROM "KycSubmission"
      WHERE "communityLinks"::text ILIKE ANY(${patterns}::text[])
    `)
    for (const r of rows) {
      for (const url of readLinks(r.communityLinks)) {
        const k = communityKey(url)
        if (!k || !allKeys.has(k)) continue
        const set = ownersByKey.get(k) ?? new Set<string>()
        set.add(r.userId)
        ownersByKey.set(k, set)
      }
    }
  }

  // ── Resolve the other accounts' names in one query.
  const otherIds = new Set<string>()
  for (const s of [...ownersByNumber.values(), ...ownersByKey.values()]) for (const id of s) otherIds.add(id)
  const users = otherIds.size
    ? await db.user.findMany({ where: { id: { in: [...otherIds] } }, select: { id: true, username: true, email: true } })
    : []
  const info = new Map(users.map((u) => [u.id, { userId: u.id, username: u.username, email: u.email }]))

  for (const it of items) {
    const entry = out.get(it.id)!
    if (it.whatsappNumber) {
      for (const id of ownersByNumber.get(it.whatsappNumber) ?? []) {
        if (id !== it.userId && info.has(id) && !entry.whatsapp.some((w) => w.userId === id)) entry.whatsapp.push(info.get(id)!)
      }
    }
    for (const [k, url] of keysByItem.get(it.id) ?? []) {
      for (const id of ownersByKey.get(k) ?? []) {
        if (id !== it.userId && info.has(id) && !entry.community.some((c) => c.userId === id && c.url === url)) entry.community.push({ ...info.get(id)!, url })
      }
    }
  }
  return out
}
