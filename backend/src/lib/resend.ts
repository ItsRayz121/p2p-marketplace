import { Resend } from 'resend'
import { env } from './env'
import { logger } from './logger'

export const resend = new Resend(env.RESEND_API_KEY)

// Accepts either:
//   - `email@domain.tld`
//   - `Display Name <email@domain.tld>`
// Returns the original string if valid, or null if missing/malformed.
function parseEmailFrom(raw: string | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Simple email
  const bareEmail = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/
  if (bareEmail.test(trimmed)) return trimmed

  // "Name <email@domain>" — angle brackets MUST contain a valid email
  const named = /^(.+?)\s*<\s*([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)\s*>$/
  const m = named.exec(trimmed)
  if (m && m[1]?.trim().length && m[2]) return trimmed

  return null
}

const validated = parseEmailFrom(env.EMAIL_FROM)

if (!validated && env.RESEND_API_KEY) {
  logger.warn(
    { rawEmailFrom: env.EMAIL_FROM },
    'EMAIL_FROM is missing or malformed — transactional emails are DISABLED. ' +
      'Set EMAIL_FROM to a Resend-verified sender, e.g. ' +
      '"PakSwap <noreply@yourdomain.com>" or "noreply@yourdomain.com".',
  )
} else if (validated && !env.RESEND_API_KEY) {
  logger.warn(
    'RESEND_API_KEY is not set — transactional emails are DISABLED even though EMAIL_FROM is valid.',
  )
} else if (validated) {
  logger.info({ emailFrom: validated }, 'Resend email sender configured')
}

/**
 * Resolved sender. `null` when EMAIL_FROM is missing/malformed —
 * callers must check before sending and skip with a warning.
 */
export const EMAIL_FROM: string | null = validated

export function isEmailConfigured(): boolean {
  return Boolean(EMAIL_FROM && env.RESEND_API_KEY)
}
