/**
 * Portfolio tracking-period cutover: backup, reconcile, start a new period for every user, and roll back.
 *
 * Nothing is deleted. Entries dated up to the cutover instant are archived (a marker on the row), what each
 * user held then becomes their opening baseline, and from that instant the portfolio's performance period
 * starts. Run it against production only with the owner's go-ahead and a database URL that has write access,
 * for example:   railway run npx tsx scripts/portfolio-cutover.ts --dry-run
 *
 *   --dry-run                          (default) read-only report of what would happen, per user
 *   --apply --backup-dir <dir>         1) write + verify a backup, 2) sync RupChain trades, 3) cut every user over
 *       [--at <ISO time>]              cutover instant (default: now; must be within the last 6 hours)
 *       [--user <id[,id...]>]          only these users (default: every user)
 *       [--no-sync-trades]             skip step 2
 *   --rollback (--user <ids> | --all)  undo the active period(s): entries become current again
 *   --verify-dump <file>               check a backup file against its checksum and against the database
 *   --restore-dump <file>              put back any row missing from the database (after a rollback); never deletes
 *   --confirm-production               required when DATABASE_URL is not on this machine
 *
 * Safe to re-run: a user who already has an active period is skipped, so an interrupted run resumes.
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { db } from '../src/lib/prisma'
import { cutoverUser, rollbackUser, type CutoverResult } from '../src/services/portfolioPeriod.service'
import { dumpPortfolioState, parseDump, restoreDump, serializeDump } from '../src/services/portfolioDump.service'
import { runCtmImport } from '../src/services/portfolioImport.service'
import { runUsdtImport } from '../src/services/portfolioUsdtImport.service'
import { mergeImportReports } from '../src/lib/portfolio/mergeImportReports'

const argv = process.argv.slice(2)
const has = (f: string) => argv.includes(f)
const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }

const MAX_ASSETS = 200
const MAX_EVENTS = 5000

function isLocal(): boolean {
  try { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(process.env.DATABASE_URL ?? '').hostname) } catch { return false }
}

async function targetUsers(): Promise<string[]> {
  const only = val('--user')
  if (only) return only.split(',').map((s) => s.trim()).filter(Boolean)
  const ids: string[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await db.user.findMany({ orderBy: { id: 'asc' }, take: 500, select: { id: true }, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) })
    if (page.length === 0) break
    ids.push(...page.map((u) => u.id))
    cursor = page[page.length - 1]!.id
  }
  return ids
}

/** Users that have any portfolio rows at all: the ones whose state is worth backing up. */
async function usersWithPortfolioData(ids: string[]): Promise<string[]> {
  const found = new Set<string>()
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const [a, e, p] = await Promise.all([
      db.portfolioAsset.findMany({ where: { userId: { in: chunk } }, select: { userId: true }, distinct: ['userId'] }),
      db.portfolioEvent.findMany({ where: { userId: { in: chunk } }, select: { userId: true }, distinct: ['userId'] }),
      db.portfolioPriceObservation.findMany({ where: { userId: { in: chunk } }, select: { userId: true }, distinct: ['userId'] }),
    ])
    for (const r of [...a, ...e, ...p]) found.add(r.userId)
  }
  return [...found]
}

function stamp(d: Date) { return d.toISOString().replace(/[:.]/g, '-') }

async function writeBackup(dir: string, userIds: string[]): Promise<{ file: string; sha: string; counts: Record<string, number> }> {
  fs.mkdirSync(dir, { recursive: true })
  const dump = await dumpPortfolioState(userIds)
  const { text, sha256 } = serializeDump(dump)
  const file = path.join(dir, `portfolio-backup-${stamp(new Date())}.json`)
  fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' })
  fs.writeFileSync(`${file}.sha256`, `${sha256}  ${path.basename(file)}\n`, 'utf8')
  // Verify what is on disk, not what is in memory: re-read, check the checksum, and check it matches the database.
  const again = parseDump(fs.readFileSync(file, 'utf8'), sha256)
  const live = await dumpPortfolioState(userIds)
  for (const k of Object.keys(again.counts) as Array<keyof typeof again.counts>) {
    if (again.counts[k] !== live.counts[k]) throw new Error(`backup verification failed: ${k} has ${live.counts[k]} rows in the database but ${again.counts[k]} in the file`)
  }
  return { file, sha: sha256, counts: again.counts }
}

/** The same rule the app applies when someone opens their portfolio: keep an existing import up to date, never start one silently. */
async function syncTrades(userId: string): Promise<'synced' | 'nothing' | 'skipped'> {
  const limits = { dryRun: true, maxAssets: MAX_ASSETS, maxEvents: MAX_EVENTS }
  const dry = mergeImportReports(await runCtmImport(userId, limits), await runUsdtImport(userId, limits))
  if (!dry.hasImportedBefore) return 'skipped'
  if (dry.created + dry.restored + dry.voided === 0) return 'nothing'
  const real = { ...limits, dryRun: false }
  await runCtmImport(userId, real)
  await runUsdtImport(userId, real)
  return 'synced'
}

function brief(r: CutoverResult) {
  return { status: r.status, version: r.version, assets: r.assetsInBaseline, archived: r.entriesArchived, discrepancies: r.discrepancies.length }
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1) }
  if (!isLocal() && !has('--confirm-production')) {
    console.error('DATABASE_URL is not on this machine. Re-run with --confirm-production once you are sure this is the database you mean.')
    process.exit(1)
  }

  if (has('--verify-dump') || has('--restore-dump')) {
    const file = (val('--verify-dump') ?? val('--restore-dump'))!
    const sha = fs.existsSync(`${file}.sha256`) ? fs.readFileSync(`${file}.sha256`, 'utf8').split(/\s+/)[0] : undefined
    const dump = parseDump(fs.readFileSync(file, 'utf8'), sha)
    console.log(`Backup ${path.basename(file)} is intact (${dump.userIds.length} users, rows: ${JSON.stringify(dump.counts)}).`)
    if (has('--restore-dump')) {
      const res = await restoreDump(dump)
      console.log('Restored (rows that were missing):', JSON.stringify(res.created), '\nAlready present (left untouched):', JSON.stringify(res.alreadyThere))
    } else {
      const live = await dumpPortfolioState(dump.userIds)
      console.log('Database now has rows:', JSON.stringify(live.counts))
    }
    return
  }

  if (has('--rollback')) {
    const users = has('--all')
      ? (await db.portfolioTrackingPeriod.findMany({ where: { status: 'active', reason: 'cutover' }, select: { userId: true } })).map((p) => p.userId)
      : (val('--user')?.split(',').map((s) => s.trim()).filter(Boolean) ?? [])
    if (users.length === 0) { console.error('Nothing to roll back: pass --user <ids> or --all.'); process.exit(1) }
    let n = 0, restored = 0
    for (const u of users) { const r = await rollbackUser(u); if (r.status === 'rolled_back') { n += 1; restored += r.entriesRestored } }
    console.log(`Rolled back ${n} period(s); ${restored} entries are current again. Nothing was deleted.`)
    return
  }

  const apply = has('--apply')
  const at = val('--at') ? new Date(val('--at')!) : new Date()
  if (Number.isNaN(at.getTime())) { console.error('--at is not a valid time.'); process.exit(1) }
  if (Date.now() - at.getTime() > 6 * 60 * 60 * 1000) { console.error('--at is more than 6 hours ago: opening values use the latest quotes, which would no longer describe that moment.'); process.exit(1) }

  const users = await targetUsers()
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${users.length} user(s), cutover at ${at.toISOString()}`)
  const report: Record<string, unknown> = { at: at.toISOString(), apply, startedAt: new Date().toISOString(), users: {} as Record<string, unknown> }

  if (apply) {
    const dir = val('--backup-dir')
    if (!dir) { console.error('--apply needs --backup-dir <dir>. No backup, no cutover.'); process.exit(1) }
    const withData = await usersWithPortfolioData(users)
    const b = await writeBackup(dir, withData)
    report.backup = { file: b.file, sha256: b.sha, counts: b.counts }
    console.log(`Backup written and verified: ${b.file}\n  rows: ${JSON.stringify(b.counts)}`)

    if (!has('--no-sync-trades')) {
      const counts: Record<string, number> = { synced: 0, nothing: 0, skipped: 0, failed: 0 }
      for (const u of withData) {
        try { counts[await syncTrades(u)]! += 1 } catch (err) { counts.failed! += 1; console.warn(`  trade sync failed for ${u}: ${(err as Error).message}`) }
      }
      report.tradeSync = counts
      console.log('Trade sync:', JSON.stringify(counts))
    }
  }

  const tally: Record<string, number> = { created: 0, exists: 0, dry_run: 0, failed: 0 }
  let discrepancies = 0
  for (const u of users) {
    try {
      const r = await cutoverUser(u, { at, dryRun: !apply })
      tally[r.status]! += 1
      discrepancies += r.discrepancies.length
      ;(report.users as Record<string, unknown>)[u] = { ...brief(r), details: r.discrepancies }
    } catch (err) {
      tally.failed! += 1
      ;(report.users as Record<string, unknown>)[u] = { status: 'failed', error: (err as Error).message }
      console.warn(`  cutover failed for ${u}: ${(err as Error).message}`)
    }
  }
  report.tally = tally
  report.discrepancies = discrepancies
  console.log('Result:', JSON.stringify(tally), `| discrepancies recorded: ${discrepancies}`)

  if (apply) {
    const out = path.join(val('--backup-dir')!, `cutover-report-${stamp(new Date())}.json`)
    fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8')
    console.log(`Report: ${out}`)
    if (tally.failed) { console.error('Some users failed. Fix the cause and re-run: finished users are skipped.'); process.exitCode = 2 }
  } else {
    console.log('Nothing was written. Re-run with --apply --backup-dir <dir> to perform the cutover.')
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1 }).finally(() => db.$disconnect())
