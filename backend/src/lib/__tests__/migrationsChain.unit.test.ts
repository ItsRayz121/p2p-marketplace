import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Guards the migration chain without needing a database: every table a migration alters, indexes or
 * references must be created by some migration. A migration that points at a table the chain never
 * creates cannot run on an empty database (a new environment, a disaster-recovery rebuild, CI).
 *
 * KNOWN_GAPS lists problems that already exist in applied migrations. Applied migrations must not be
 * edited, so they are listed here instead; the test fails if a NEW gap appears, and also if a listed
 * gap disappears (so the list cannot go stale). See backend/scripts/local-stack/README.md.
 */
const KNOWN_GAPS: Record<string, string> = {
  ctm_trades: 'migrations 20260520220000 and 20261011110000 alter "ctm_trades", but the table created by 20260520200000 is "CtmTrade"',
}

const root = path.resolve(__dirname, '../../../prisma/migrations')
const dirs = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'migration.sql'))).sort()

function scan() {
  const created = new Set<string>()
  const used = new Map<string, string>()
  for (const d of dirs) {
    const sql = fs.readFileSync(path.join(root, d, 'migration.sql'), 'utf8').replace(/--[^\n]*/g, '') // comments are not SQL
    for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"?(\w+)"?/gi)) created.add(m[1]!)
    const uses = [
      ...sql.matchAll(/ALTER TABLE (?:ONLY )?(?:IF EXISTS )?"?(\w+)"?/gi),
      ...sql.matchAll(/CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?"?\w+"? ON "?(\w+)"?/gi),
      ...sql.matchAll(/REFERENCES "?(\w+)"?/gi),
    ]
    for (const m of uses) if (!used.has(m[1]!)) used.set(m[1]!, d)
  }
  return { created, used }
}

describe('migration chain', () => {
  const { created, used } = scan()
  const missing = [...used].filter(([t]) => !created.has(t)).map(([t, d]) => ({ table: t, firstUsedIn: d }))

  it('has migrations to scan', () => { expect(dirs.length).toBeGreaterThan(100) })

  it('no NEW migration points at a table that no migration creates', () => {
    const fresh = missing.filter((m) => !(m.table in KNOWN_GAPS))
    expect(fresh, `new gap(s): ${JSON.stringify(fresh)}`).toEqual([])
  })

  it('the list of known gaps is exactly the gaps that still exist (remove an entry when it is fixed)', () => {
    expect(missing.map((m) => m.table).sort()).toEqual(Object.keys(KNOWN_GAPS).sort())
  })
})
