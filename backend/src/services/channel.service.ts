import { randomBytes } from 'crypto'
import { Prisma } from '@prisma/client'
import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { assertCloudinaryUrl } from '../lib/upload'
import { assertSafeChannelText } from '../lib/channelTextSafety'
import { notify } from '../lib/notify'
import {
  CHANNELS_MAX_PER_USER_KEY, CHANNELS_MAX_PER_USER_DEFAULT,
  CHANNELS_MAX_MEMBERS_KEY, CHANNELS_MAX_MEMBERS_DEFAULT,
  getNumberConfig,
} from './platformFlags.service'
import { resolveSharedAdPreviews, type Market } from './chatThread.service'
import { slugify as baseSlugify } from './blog.service'
import { logger } from '../lib/logger'

/**
 * Telegram-style broadcast Channels. One owner posts text-only updates; every
 * other member is read-only (see the Channel/ChannelMember/ChannelMessage
 * comments in schema.prisma for why this is a separate model from ChatThread,
 * which is always a 2-person DM).
 */

const MESSAGE_MAX_LEN = 4000

// Static path segments registered under /channels/:idOrSlug in channel.routes.ts
// (e.g. GET /channels/directory) always win over the parametric route, so a
// channel slug equal to one of these would be permanently unreachable by slug.
const RESERVED_SLUGS = new Set(['directory'])

/** Base slug + a short random suffix, retried on the rare collision. Reuses
 *  blog.service.ts's slugify (diacritic-stripping etc.) rather than a second,
 *  divergent implementation — only the collision-retry strategy differs (blog
 *  posts append -2/-3…, channels get a short random suffix). */
async function generateUniqueSlug(name: string): Promise<string> {
  const base = baseSlugify(name).slice(0, 40)
  const baseIsReserved = RESERVED_SLUGS.has(base)
  for (let attempt = 0; attempt < 8; attempt++) {
    const suffix = randomBytes(3).toString('hex') // 24 bits — plenty once combined with a retry loop
    const slug = attempt === 0 && !baseIsReserved ? base : `${base}-${suffix}`
    if (RESERVED_SLUGS.has(slug)) continue
    const existing = await db.channel.findUnique({ where: { slug }, select: { id: true } })
    if (!existing) return slug
  }
  // Practically unreachable — fall back to a fully random slug.
  return randomBytes(8).toString('hex')
}

function assertOwner(channel: { ownerId: string }, userId: string): void {
  if (channel.ownerId !== userId) throw new AppError('FORBIDDEN', 'Only the channel owner can do that', 403)
}

const CHANNEL_CARD_SELECT = {
  id: true, name: true, description: true, slug: true, visibility: true, avatarUrl: true,
  memberCount: true, ownerId: true, lastMessageAt: true, createdAt: true,
  owner: { select: { id: true, username: true, fullName: true, avatarUrl: true } },
} as const

/** Channels the user owns or has joined, newest activity first. */
export async function listMyChannels(userId: string) {
  const memberships = await db.channelMember.findMany({
    where: { userId },
    select: { role: true, channel: { select: CHANNEL_CARD_SELECT } },
    orderBy: { channel: { lastMessageAt: 'desc' } },
  })
  return memberships.map((m) => ({ ...m.channel, myRole: m.role as 'owner' | 'subscriber' }))
}

/** Public directory search — never surfaces private (invite-link-only) channels. */
export async function searchChannelDirectory(userId: string, rawQuery: string) {
  const q = rawQuery.trim()
  const channels = await db.channel.findMany({
    where: {
      visibility: 'public',
      ...(q.length >= 2 ? { name: { contains: q, mode: 'insensitive' as const } } : {}),
    },
    select: CHANNEL_CARD_SELECT,
    orderBy: q.length >= 2 ? { memberCount: 'desc' } : { lastMessageAt: 'desc' },
    take: 50,
  })
  // Batch-check membership so the directory can show "Joined" vs "Join" without
  // an extra round trip per row.
  const memberships = await db.channelMember.findMany({
    where: { userId, channelId: { in: channels.map((c) => c.id) } },
    select: { channelId: true },
  })
  const joined = new Set(memberships.map((m) => m.channelId))
  return channels.map((c) => ({ ...c, isMember: joined.has(c.id) }))
}

export async function createChannel(userId: string, input: { name: string; description?: string | undefined; visibility: 'public' | 'private' }): Promise<{ id: string; slug: string }> {
  const name = input.name.trim()
  if (name.length < 3) throw new AppError('VALIDATION_ERROR', 'Channel name must be at least 3 characters', 400)
  const description = input.description?.trim() || null

  // Known race (not fixed, low priority): this is check-then-act, so two
  // near-simultaneous creates from the same user right at the cap could both
  // pass. Requires deliberate double-tap/multi-tab abuse of a soft, non-
  // financial limit — same risk tolerance as other pre-existing checks in this
  // codebase (e.g. gas.freeCode.ts's first-order eligibility check).
  const maxPerUser = await getNumberConfig(CHANNELS_MAX_PER_USER_KEY, CHANNELS_MAX_PER_USER_DEFAULT)
  const ownedCount = await db.channel.count({ where: { ownerId: userId } })
  if (ownedCount >= maxPerUser) {
    throw new AppError('VALIDATION_ERROR', `You can own at most ${maxPerUser} channels`, 400)
  }

  const slug = await generateUniqueSlug(name)
  try {
    const channel = await db.channel.create({
      data: {
        ownerId: userId, name, description, slug, visibility: input.visibility,
        members: { create: { userId, role: 'owner' } },
      },
      select: { id: true, slug: true },
    })
    return channel
  } catch (err) {
    // Same-name race: another create() committed the same slug between our
    // uniqueness check and this insert (see generateUniqueSlug's check-then-act
    // comment above).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError('VALIDATION_ERROR', 'A channel with that name was just created — try a different name', 400)
    }
    throw err
  }
}

/** Full channel view — meta always returned; `messages` only populated for members (or the public preview caller explicitly opts out of via listMessages). */
export async function getChannel(userId: string, idOrSlug: string) {
  const channel = await db.channel.findFirst({
    where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    select: CHANNEL_CARD_SELECT,
  })
  if (!channel) throw new AppError('NOT_FOUND', 'Channel not found', 404)
  const membership = await db.channelMember.findUnique({
    where: { channelId_userId: { channelId: channel.id, userId } },
    select: { role: true },
  })
  if (!membership && channel.visibility === 'private' && idOrSlug !== channel.slug) {
    // A private channel previews fine to a non-member who arrived via its
    // CURRENT invite slug (so the Join button can render) — but not to someone
    // who only has its id (e.g. a kicked ex-member, or a stale cached link), and
    // not after the owner rotates the slug. See joinChannel's matching check.
    throw new AppError('NOT_FOUND', 'Channel not found', 404)
  }
  return { ...channel, myRole: (membership?.role as 'owner' | 'subscriber' | undefined) ?? null, isMember: !!membership }
}

const CHANNEL_MESSAGE_SELECT = {
  id: true, senderId: true, body: true, attachmentUrl: true, deletedAt: true, editedAt: true, isSystem: true, createdAt: true,
  clientId: true, sharedAdMarket: true, sharedAdId: true,
} as const

/** Message history — members only (a non-member must join first, matching the invite-link model). */
export async function listChannelMessages(userId: string, channelId: string) {
  const membership = await db.channelMember.findUnique({
    where: { channelId_userId: { channelId, userId } },
    select: { id: true },
  })
  if (!membership) throw new AppError('FORBIDDEN', 'Join this channel to see its messages', 403)
  // Newest 500, not oldest — `desc` + reverse. A channel that outlives 500
  // broadcasts must keep showing its LATEST posts, not get stuck showing only
  // whatever happened to be sent first.
  const rows = await db.channelMessage.findMany({
    where: { channelId },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: CHANNEL_MESSAGE_SELECT,
  })
  rows.reverse()
  const messages = rows.map((m) => (m.deletedAt ? { ...m, body: '', attachmentUrl: null, sharedAdMarket: null, sharedAdId: null } : m))

  // Resolve one-tap-shared listings to their CURRENT live state, same as the DM
  // inbox (see resolveSharedAdPreviews) — a shared card should never show a
  // stale send-time price.
  const refs = messages
    .filter((m): m is typeof m & { sharedAdMarket: string; sharedAdId: string } => !!m.sharedAdMarket && !!m.sharedAdId)
    .map((m) => ({ market: m.sharedAdMarket as Market, id: m.sharedAdId }))
  const sharedAdMap = await resolveSharedAdPreviews(refs)
  return messages.map((m) => ({
    ...m,
    sharedAd: m.sharedAdMarket && m.sharedAdId
      ? sharedAdMap.get(`${m.sharedAdMarket}:${m.sharedAdId}`) ?? { market: m.sharedAdMarket as Market, id: m.sharedAdId, deleted: true }
      : null,
  }))
}

/**
 * Join by id (public channels — freely discoverable via the directory) OR by
 * slug (required for a private channel: knowing only its id, e.g. from having
 * been a member before, must NOT be enough — otherwise a kicked member could
 * just rejoin, and kickMember would provide no real ban).
 */
export async function joinChannel(userId: string, idOrSlug: string): Promise<void> {
  const channel = await db.channel.findFirst({
    where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    select: { id: true, visibility: true, slug: true, memberCount: true },
  })
  if (!channel) throw new AppError('NOT_FOUND', 'Channel not found', 404)
  if (channel.visibility === 'private' && idOrSlug !== channel.slug) {
    throw new AppError('NOT_FOUND', 'Channel not found', 404)
  }
  const existing = await db.channelMember.findUnique({ where: { channelId_userId: { channelId: channel.id, userId } }, select: { id: true } })
  if (existing) return // idempotent

  const maxMembers = await getNumberConfig(CHANNELS_MAX_MEMBERS_KEY, CHANNELS_MAX_MEMBERS_DEFAULT)
  // Guarded atomic increment — updateMany only touches the row (and only
  // increments) while still under the cap, closing the check-then-act race two
  // concurrent joins on an almost-full channel could otherwise both slip through.
  const capped = await db.channel.updateMany({
    where: { id: channel.id, memberCount: { lt: maxMembers } },
    data: { memberCount: { increment: 1 } },
  })
  if (capped.count === 0) throw new AppError('VALIDATION_ERROR', 'This channel is full', 400)
  try {
    await db.channelMember.create({ data: { channelId: channel.id, userId, role: 'subscriber' } })
  } catch (err) {
    // Roll back the increment — either member creation genuinely failed, or a
    // concurrent duplicate-join race lost to another request past the
    // `existing` check above (P2002 on the channelId+userId unique constraint).
    // Logged rather than silently swallowed: if THIS also fails, memberCount is
    // left one over actual membership, which is worth knowing about even though
    // there's no automatic retry for it.
    await db.channel.update({ where: { id: channel.id }, data: { memberCount: { decrement: 1 } } })
      .catch((rollbackErr) => logger.warn({ err: rollbackErr, channelId: channel.id }, 'joinChannel: memberCount rollback failed (non-fatal, count may now be inflated)'))
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return
    throw err
  }
}

export async function leaveChannel(userId: string, channelId: string): Promise<void> {
  const channel = await db.channel.findUnique({ where: { id: channelId }, select: { ownerId: true } })
  if (!channel) throw new AppError('NOT_FOUND', 'Channel not found', 404)
  if (channel.ownerId === userId) {
    throw new AppError('VALIDATION_ERROR', 'Delete the channel instead of leaving your own channel', 400)
  }
  const membership = await db.channelMember.findUnique({ where: { channelId_userId: { channelId, userId } }, select: { id: true } })
  if (!membership) return // idempotent
  await db.$transaction([
    db.channelMember.delete({ where: { id: membership.id } }),
    db.channel.update({ where: { id: channelId }, data: { memberCount: { decrement: 1 } } }),
  ])
}

export async function updateChannel(userId: string, channelId: string, input: { name?: string | undefined; description?: string | undefined; visibility?: 'public' | 'private' | undefined; avatarUrl?: string | undefined }) {
  const channel = await db.channel.findUnique({ where: { id: channelId }, select: { ownerId: true } })
  if (!channel) throw new AppError('NOT_FOUND', 'Channel not found', 404)
  assertOwner(channel, userId)
  const name = input.name?.trim()
  if (name !== undefined && name.length < 3) throw new AppError('VALIDATION_ERROR', 'Channel name must be at least 3 characters', 400)
  // Only our own Cloudinary uploads — same rule as user avatars — prevents
  // storing arbitrary third-party image URLs (tracking pixels, phishing).
  if (input.avatarUrl !== undefined) assertCloudinaryUrl(input.avatarUrl, 'avatarUrl')
  const updated = await db.channel.update({
    where: { id: channelId },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(input.description !== undefined ? { description: input.description.trim() || null } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
    },
    select: CHANNEL_CARD_SELECT,
  })
  return updated
}

/** Revokes every previously-shared invite link by rotating the slug. Owner only. */
export async function regenerateInvite(userId: string, channelId: string): Promise<{ slug: string }> {
  const channel = await db.channel.findUnique({ where: { id: channelId }, select: { ownerId: true, name: true } })
  if (!channel) throw new AppError('NOT_FOUND', 'Channel not found', 404)
  assertOwner(channel, userId)
  const slug = await generateUniqueSlug(channel.name)
  await db.channel.update({ where: { id: channelId }, data: { slug } })
  return { slug }
}

export async function deleteChannel(userId: string, channelId: string): Promise<void> {
  const channel = await db.channel.findUnique({ where: { id: channelId }, select: { ownerId: true } })
  if (!channel) throw new AppError('NOT_FOUND', 'Channel not found', 404)
  assertOwner(channel, userId)
  await db.channel.delete({ where: { id: channelId } }) // cascades members + messages
}

/**
 * Remove a subscriber. Owner only; cannot kick yourself (delete the channel
 * instead). For a PRIVATE channel this also rotates the invite slug — it's the
 * only join gate a private channel has (see joinChannel), so without rotating
 * it the kicked member could just reuse the same invite link to rejoin
 * immediately, making the kick a no-op. A public channel's slug is left alone:
 * it isn't a join gate there (the directory is), so rotating it would only
 * break links for no security benefit.
 */
export async function kickMember(userId: string, channelId: string, targetUserId: string): Promise<void> {
  const channel = await db.channel.findUnique({ where: { id: channelId }, select: { ownerId: true, visibility: true, name: true } })
  if (!channel) throw new AppError('NOT_FOUND', 'Channel not found', 404)
  assertOwner(channel, userId)
  if (targetUserId === userId) throw new AppError('VALIDATION_ERROR', "You can't remove yourself as owner", 400)
  const membership = await db.channelMember.findUnique({ where: { channelId_userId: { channelId, userId: targetUserId } }, select: { id: true } })
  if (!membership) return // idempotent
  const newSlug = channel.visibility === 'private' ? await generateUniqueSlug(channel.name) : undefined
  await db.$transaction([
    db.channelMember.delete({ where: { id: membership.id } }),
    db.channel.update({
      where: { id: channelId },
      data: { memberCount: { decrement: 1 }, ...(newSlug ? { slug: newSlug } : {}) },
    }),
  ])
}

export async function listMembers(userId: string, channelId: string) {
  const channel = await db.channel.findUnique({ where: { id: channelId }, select: { ownerId: true } })
  if (!channel) throw new AppError('NOT_FOUND', 'Channel not found', 404)
  assertOwner(channel, userId)
  // Capped at the CONFIGURED member ceiling (not a fixed 500) so an owner can
  // always see and moderate every member a channel is actually allowed to have.
  // Floored — getNumberConfig parses the raw PlatformConfig string and Prisma's
  // `take` rejects a non-integer.
  const maxMembers = Math.max(1, Math.floor(await getNumberConfig(CHANNELS_MAX_MEMBERS_KEY, CHANNELS_MAX_MEMBERS_DEFAULT)))
  return db.channelMember.findMany({
    where: { channelId },
    orderBy: { joinedAt: 'asc' },
    take: maxMembers,
    select: { role: true, joinedAt: true, user: { select: { id: true, username: true, fullName: true, avatarUrl: true } } },
  })
}

/**
 * Post a broadcast message. Owner-only (broadcast, not group chat — see the
 * Channel model comment). `sharedAd` mirrors ChatThreadMessage's one-tap
 * "share my listing", validated the same way: must be the owner's own active
 * listing.
 */
export async function postChannelMessage(
  userId: string,
  channelId: string,
  body: string,
  clientId?: string,
  sharedAd?: { market: Market; id: string },
  attachmentUrl?: string,
) {
  const text = body.trim()
  if (!text && !sharedAd && !attachmentUrl) throw new AppError('VALIDATION_ERROR', 'Message is empty', 400)
  if (text.length > MESSAGE_MAX_LEN) throw new AppError('VALIDATION_ERROR', 'Message too long', 400)
  if (text) assertSafeChannelText(text)
  // Broadcasts fan out to every member (up to the channel cap), unlike a DM —
  // only our own Cloudinary uploads are allowed, so nobody can post an arbitrary
  // third-party URL (tracking pixel, phishing image) to a public audience.
  if (attachmentUrl) assertCloudinaryUrl(attachmentUrl, 'attachmentUrl')

  const channel = await db.channel.findUnique({ where: { id: channelId }, select: { ownerId: true, name: true, slug: true } })
  if (!channel) throw new AppError('NOT_FOUND', 'Channel not found', 404)
  assertOwner(channel, userId)

  if (sharedAd) {
    if (sharedAd.market === 'usdt') {
      const ad = await db.ad.findUnique({ where: { id: sharedAd.id }, select: { userId: true, status: true } })
      if (!ad || ad.userId !== userId) throw new AppError('FORBIDDEN', 'You can only share your own listings', 403)
      if (ad.status !== 'active') throw new AppError('VALIDATION_ERROR', 'This listing is no longer active', 400)
    } else {
      const listing = await db.ctmListing.findUnique({ where: { id: sharedAd.id }, select: { status: true, merchantProfile: { select: { userId: true } } } })
      if (!listing || listing.merchantProfile.userId !== userId) throw new AppError('FORBIDDEN', 'You can only share your own listings', 403)
      if (listing.status !== 'active') throw new AppError('VALIDATION_ERROR', 'This listing is no longer active', 400)
    }
  }

  try {
    const [message] = await db.$transaction([
      db.channelMessage.create({
        data: {
          channelId, senderId: userId, body: text, clientId: clientId ?? null,
          ...(attachmentUrl ? { attachmentUrl } : {}),
          ...(sharedAd ? { sharedAdMarket: sharedAd.market, sharedAdId: sharedAd.id } : {}),
        },
        select: CHANNEL_MESSAGE_SELECT,
      }),
      db.channel.update({ where: { id: channelId }, data: { lastMessageAt: new Date() } }),
    ])
    // Broadcast a bell + push to every member (Telegram-style — every post
    // buzzes, since only the owner can post so volume is inherently low).
    // Fire-and-forget: never block the owner's send on a large member fan-out.
    void notifyChannelMembers(channelId, channel.name, channel.slug, userId, text, attachmentUrl)
    return message
  } catch (err) {
    if (clientId && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await db.channelMessage.findUnique({
        where: { channelId_senderId_clientId: { channelId, senderId: userId, clientId } },
        select: CHANNEL_MESSAGE_SELECT,
      })
      if (existing) return existing
    }
    throw err
  }
}

/**
 * Fan the "new broadcast" bell + web-push out to every member except the
 * owner who just posted it. Best-effort and never throws — a notification
 * failure must never surface as an error on the owner's send.
 */
async function notifyChannelMembers(
  channelId: string,
  channelName: string,
  channelSlug: string,
  ownerId: string,
  text: string,
  attachmentUrl?: string,
) {
  try {
    const preview = text.length > 60 ? text.slice(0, 57) + '…' : text || (attachmentUrl ? 'Sent a photo' : 'New broadcast')
    const members = await db.channelMember.findMany({
      where: { channelId, userId: { not: ownerId } },
      select: { userId: true },
    })
    for (const { userId } of members) {
      // Channel broadcasts are never important enough for a Telegram DM —
      // telegram: false keeps them web-push + in-app bell only.
      notify(userId, 'channel_broadcast', channelName, preview, { channelId }, undefined, `/messages/channels/${channelSlug}`, { telegram: false })
    }
  } catch (err) {
    logger.warn({ err, channelId }, 'Failed to fan out channel broadcast notifications (non-fatal)')
  }
}

// Shared by delete and edit — an owner can fix a typo or pull a broadcast
// shortly after sending, but not rewrite history long after members have read it.
const MESSAGE_MUTATE_WINDOW_MS = 15 * 60 * 1000

export async function deleteChannelMessage(userId: string, channelId: string, messageId: string) {
  const message = await db.channelMessage.findUnique({
    where: { id: messageId },
    select: { id: true, channelId: true, senderId: true, isSystem: true, deletedAt: true, createdAt: true },
  })
  if (!message || message.channelId !== channelId || message.senderId !== userId || message.isSystem) {
    throw new AppError('NOT_FOUND', 'Message not found', 404)
  }
  if (message.deletedAt) return { ok: true }
  if (Date.now() - message.createdAt.getTime() > MESSAGE_MUTATE_WINDOW_MS) {
    throw new AppError('VALIDATION_ERROR', 'Messages can only be deleted within 15 minutes of sending.', 400)
  }
  await db.channelMessage.update({ where: { id: messageId }, data: { deletedAt: new Date() } })
  return { ok: true }
}

export async function editChannelMessage(userId: string, channelId: string, messageId: string, body: string) {
  const text = body.trim()
  if (!text) throw new AppError('VALIDATION_ERROR', 'Message is empty', 400)
  if (text.length > MESSAGE_MAX_LEN) throw new AppError('VALIDATION_ERROR', 'Message too long', 400)
  assertSafeChannelText(text)

  const message = await db.channelMessage.findUnique({
    where: { id: messageId },
    select: { id: true, channelId: true, senderId: true, isSystem: true, deletedAt: true, createdAt: true },
  })
  if (!message || message.channelId !== channelId || message.senderId !== userId || message.isSystem) {
    throw new AppError('NOT_FOUND', 'Message not found', 404)
  }
  if (message.deletedAt) throw new AppError('VALIDATION_ERROR', 'This broadcast was deleted', 400)
  if (Date.now() - message.createdAt.getTime() > MESSAGE_MUTATE_WINDOW_MS) {
    throw new AppError('VALIDATION_ERROR', 'Messages can only be edited within 15 minutes of sending.', 400)
  }
  const updated = await db.channelMessage.update({
    where: { id: messageId },
    data: { body: text, editedAt: new Date() },
    select: CHANNEL_MESSAGE_SELECT,
  })
  return updated
}
