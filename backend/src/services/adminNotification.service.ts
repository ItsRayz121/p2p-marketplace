import { db } from '../lib/prisma'
import type { AdminNotifCategory, UserRole } from '@prisma/client'
import { logger } from '../lib/logger'
import { Prisma } from '@prisma/client'
import { sendPushToRoles } from '../lib/push.service'
import { sendTelegramAdminAlert } from '../lib/telegram.notify'
import { sendAdminAlertEmail } from './email.service'
import { FLAGS, isFlagEnabled } from './platformFlags.service'

export interface AdminNotifPayload {
  category: AdminNotifCategory
  title: string
  body: string
  href?: string
  metadata?: Record<string, unknown>
  /**
   * Staff roles that should receive this externally (push + Telegram). Defaults
   * to a per-category map so sub-admins only get their own domain's events
   * (e.g. kyc_reviewer → KYC only). super_admin + admin are ALWAYS included.
   */
  roles?: UserRole[]
  /**
   * Force the Telegram DM channel on/off. When omitted, defaults from the
   * category (action-required categories DM; high-volume routine ones do not).
   */
  telegram?: boolean
  /**
   * Mark this as email-eligible. Even when true, an email is only sent if the
   * `admin_email_notifs_enabled` flag is ON — so email stays OFF (free) by
   * default and is reserved for critical events. Emails go to ADMIN_ALERT_EMAIL.
   */
  email?: boolean
}

/**
 * Which staff roles receive each category by default. super_admin + admin see
 * everything (added below); sub-admins are scoped to their own domain so they
 * are not buzzed for irrelevant events.
 */
const CATEGORY_ROLES: Record<AdminNotifCategory, UserRole[]> = {
  KYC:        ['kyc_reviewer'],
  DISPUTE:    ['dispute_agent'],
  TRADE:      ['dispute_agent'],
  CTM:        ['dispute_agent'],
  WITHDRAWAL: [],
  DEPOSIT:    [],
  GAS:        [],
  SYSTEM:     [],
}

/**
 * Categories that DM staff on Telegram by default. Action-required / money /
 * security events DM; high-volume routine ones (TRADE ratings, DEPOSIT credited,
 * generic SYSTEM ticks) stay bell + web-push only. Any call may override with
 * `telegram: true|false`. Keeps Telegram volume low (ban-safe).
 */
const TELEGRAM_CATEGORIES = new Set<AdminNotifCategory>(['KYC', 'DISPUTE', 'WITHDRAWAL', 'GAS', 'CTM'])

function targetRoles(payload: AdminNotifPayload): UserRole[] {
  const base = payload.roles ?? CATEGORY_ROLES[payload.category]
  return Array.from(new Set<UserRole>([...base, 'admin', 'super_admin']))
}

/**
 * Fire-and-forget helper — writes an admin notification row, then fans it out to
 * the in-app bell (row), OS-level web push, and (for important categories) a
 * Telegram DM to every targeted staff member who linked Telegram. Critical
 * payloads may also email ADMIN_ALERT_EMAIL when the email flag is enabled.
 *
 * Never throws; logs errors so callers don't need try/catch.
 */
export async function createAdminNotif(payload: AdminNotifPayload): Promise<void> {
  try {
    await db.adminNotification.create({
      data: {
        category: payload.category,
        title:    payload.title,
        body:     payload.body,
        href:     payload.href ?? null,
        metadata: (payload.metadata ?? {}) as Prisma.InputJsonValue,
      },
    })
  } catch (err) {
    logger.error({ err, category: payload.category, title: payload.title }, 'Failed to create admin notification')
  }

  // External fan-out — fully fire-and-forget so callers never block on it.
  void dispatchExternal(payload)
}

async function dispatchExternal(payload: AdminNotifPayload): Promise<void> {
  const roles = targetRoles(payload)
  const href  = payload.href ?? '/admin'

  // 1) OS-level web push, scoped to the targeted roles.
  void sendPushToRoles(roles, { title: payload.title, body: payload.body, url: href })

  // 2) Telegram DM to targeted staff who linked Telegram (important categories).
  const wantsTelegram = payload.telegram ?? TELEGRAM_CATEGORIES.has(payload.category)
  if (wantsTelegram) {
    try {
      const staff = await db.user.findMany({
        where: { role: { in: roles }, telegramId: { not: null }, telegramBlockedAt: null },
        select: { telegramId: true },
      })
      for (const s of staff) {
        if (!s.telegramId) continue
        const tgId = s.telegramId
        sendTelegramAdminAlert(tgId, payload.title, payload.body, href)
          .then((r) => {
            if (r.blocked) {
              db.user.updateMany({ where: { telegramId: tgId }, data: { telegramBlockedAt: new Date() } }).catch(() => {})
            }
          })
          .catch(() => {})
      }
    } catch (err) {
      logger.warn({ err, title: payload.title }, 'Admin Telegram fan-out failed')
    }
  }

  // 3) Email — critical, opt-in, single inbox. Only when the payload is marked
  //    email-eligible AND the flag is ON (so it stays free by default).
  if (payload.email) {
    try {
      if (await isFlagEnabled(FLAGS.ADMIN_EMAIL_NOTIFS)) {
        await sendAdminAlertEmail(payload.title, payload.body)
      }
    } catch (err) {
      logger.warn({ err, title: payload.title }, 'Admin alert email failed')
    }
  }
}
