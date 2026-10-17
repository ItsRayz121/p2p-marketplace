import { describe, it, expect, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'

/**
 * Builds a complete database from nothing with `npm run db:bootstrap`, on a scratch database next to
 * TEST_DATABASE_URL, then drops it. Skipped unless TEST_DATABASE_URL is set; local hosts only.
 * See vitest.integration.config.ts.
 */
const url = process.env.TEST_DATABASE_URL
const host = url ? (() => { try { return new URL(url).hostname } catch { return '' } })() : ''
if (url && host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') throw new Error(`Refusing to run integration tests against non-local database host "${host}"`)

describe.skipIf(!url)('db:bootstrap on a brand-new database', () => {
  const name = `boot_${Math.random().toString(36).slice(2, 10)}`
  const fresh = (() => { if (!url) return ''; const u = new URL(url); u.pathname = `/${name}`; return u.toString() })()
  const backendDir = path.resolve(__dirname, '../../..')
  const env = { ...process.env, DATABASE_URL: fresh, DIRECT_DATABASE_URL: fresh }
  const admin = url ? new PrismaClient({ datasources: { db: { url } } }) : (null as never)

  afterAll(async () => {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {})
    await admin.$disconnect()
  })

  it('refuses without the explicit flag', () => {
    expect(() => execSync('npx tsx scripts/db-bootstrap.ts', { cwd: backendDir, env, stdio: 'pipe' })).toThrow()
  })

  it('creates every table, records every migration as applied, and leaves nothing pending', () => {
    const out = execSync('npx tsx scripts/db-bootstrap.ts --yes-this-is-a-new-empty-database', { cwd: backendDir, env, stdio: 'pipe', timeout: 150_000 }).toString()
    expect(out).toMatch(/Database schema is up to date/)
    expect(out).toMatch(/No difference detected/)
    const migrations = fs.readdirSync(path.join(backendDir, 'prisma/migrations')).filter((d) => fs.existsSync(path.join(backendDir, 'prisma/migrations', d, 'migration.sql')))
    expect(out).toContain(`Recorded ${migrations.length} migrations as applied`)
    expect(execSync('npx prisma migrate deploy', { cwd: backendDir, env, stdio: 'pipe' }).toString()).toMatch(/No pending migrations/)
  }, 180_000)

  it('refuses to run again on a database that now has tables (it can never touch an existing database)', () => {
    let message = ''
    try { execSync('npx tsx scripts/db-bootstrap.ts --yes-this-is-a-new-empty-database', { cwd: backendDir, env, stdio: 'pipe' }) } catch (e) { message = String((e as { stderr?: Buffer }).stderr) }
    expect(message).toMatch(/already has \d+ table/)
  }, 60_000)
})
