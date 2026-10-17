/**
 * Builds a COMPLETE database from nothing: a new environment, a disaster-recovery rebuild, CI.
 *
 * Why this exists: the migration chain cannot be replayed on an empty database (two migrations alter
 * "ctm_trades", but the table the first migration creates is "CtmTrade"; see
 * src/lib/__tests__/migrationsChain.unit.test.ts). Applied migrations must not be edited, so a fresh
 * database is made the other way round: the tables are created straight from prisma/schema.prisma (which
 * is what production's schema is meant to equal), then every existing migration is recorded as already
 * applied, exactly as `prisma migrate resolve --applied` would, so `prisma migrate deploy` works from then on.
 *
 * Safe by construction: it refuses unless the database is completely empty, and unless you pass the flag.
 * It never runs against an existing database, so it cannot change production.
 *
 *   DATABASE_URL=postgresql://... npx tsx scripts/db-bootstrap.ts --yes-this-is-a-new-empty-database
 */
import 'dotenv/config'
import { createHash, randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'

const FLAG = '--yes-this-is-a-new-empty-database'

function run(cmd: string) {
  execSync(cmd, { stdio: 'inherit', env: { ...process.env, DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL } })
}

async function main() {
  if (!process.argv.includes(FLAG)) {
    console.error(`Refusing to run without ${FLAG}. This script is only for a brand-new, empty database.`)
    process.exit(1)
  }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1) }

  // 1. The database must be empty (or not exist yet). Anything else: stop before touching it.
  const db = new PrismaClient()
  try {
    const rows = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public'`
    const n = Number(rows[0]?.n ?? 0)
    if (n > 0) { console.error(`Refusing: the database already has ${n} table(s). This script only builds a new, empty database.`); process.exit(1) }
  } catch (e) {
    // P1003: the database does not exist yet; `prisma db push` below creates it.
    const err = e as { errorCode?: string; code?: string; message?: string }
    if (err.errorCode !== 'P1003' && err.code !== 'P1003' && !/does not exist on the database server/.test(err.message ?? '')) throw e
  } finally {
    await db.$disconnect().catch(() => {})
  }

  // 2. Tables straight from the schema.
  run('npx prisma db push --skip-generate')

  // 3. Record every existing migration as applied (same rows `prisma migrate resolve --applied` writes).
  const dir = path.resolve(__dirname, '../prisma/migrations')
  const names = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'migration.sql'))).sort()
  const client = new PrismaClient()
  try {
    await client.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" VARCHAR(36) PRIMARY KEY NOT NULL, "checksum" VARCHAR(64) NOT NULL, "finished_at" TIMESTAMPTZ,
      "migration_name" VARCHAR(255) NOT NULL, "logs" TEXT, "rolled_back_at" TIMESTAMPTZ,
      "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "applied_steps_count" INTEGER NOT NULL DEFAULT 0)`)
    for (const name of names) {
      const checksum = createHash('sha256').update(fs.readFileSync(path.join(dir, name, 'migration.sql'))).digest('hex')
      await client.$executeRaw`INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "logs", "started_at", "applied_steps_count")
        VALUES (${randomUUID()}, ${checksum}, now(), ${name}, '', now(), 0)`
    }
  } finally {
    await client.$disconnect().catch(() => {})
  }
  console.log(`Recorded ${names.length} migrations as applied.`)

  // 4. Prove it with Prisma's own checks: no pending migrations, and no difference from the schema.
  run('npx prisma migrate status')
  run('npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code'.replace('"$DATABASE_URL"', JSON.stringify(process.env.DATABASE_URL)))
  console.log('Done: the database matches the schema and `prisma migrate deploy` will find nothing pending.')
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
