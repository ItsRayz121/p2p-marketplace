import { db } from './prisma'
import { logger } from './logger'

/**
 * Verify the generated Prisma client has every model we rely on at runtime.
 * Catches the "build skipped prisma generate" failure mode before traffic
 * arrives instead of when a webhook tries to write a Deposit row.
 *
 * Returns true if everything is present. Logs structured warnings (not
 * errors) for missing models so boot still proceeds — the operator can see
 * the gap in logs and trigger a redeploy with `prisma generate` rerun.
 *
 * Does NOT exit on its own — calling code decides whether to refuse traffic.
 */
export function validatePrismaSchemaAtStartup(): { ok: boolean; missing: string[] } {
  const required = [
    'user',
    'wallet',
    'transaction',
    'withdrawal',
    'depositAddress',
    'deposit',
    'moralisStreamSubscription',
    'platformConfig',
    'auditLog',
  ] as const

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = db as any
  const missing = required.filter((m) => !dbAny[m])
  if (missing.length === 0) {
    logger.info({ models: required.length }, 'Prisma schema validation passed')
    return { ok: true, missing: [] }
  }
  logger.error(
    { missing },
    'Prisma client is missing one or more required models — rerun `prisma generate` and redeploy',
  )
  return { ok: false, missing }
}
