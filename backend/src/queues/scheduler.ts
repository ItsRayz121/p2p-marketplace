import { logger } from '../lib/logger'
import { createAdminNotif } from '../services/adminNotification.service'

// Lightweight replacement for a BullMQ Queue+Worker pair, used ONLY for jobs
// that are pure fixed-interval sweeps with no job payload. Every sweep moved
// onto this scheduler already ran with BullMQ `attempts: 1` — i.e. BullMQ's
// retry-on-failure was never doing anything extra for them — so this is a
// behavior-preserving swap, not a functional change.
//
// Do NOT move a job here if it (a) carries event/job data, (b) relies on
// BullMQ retry/backoff, or (c) must survive a process restart mid-flight —
// those still belong in queues/definitions.ts + workers.ts.

const activeIntervals: NodeJS.Timeout[] = []

export function scheduleSweep(name: string, fn: () => Promise<unknown>, intervalMs: number): void {
  let running = false

  const tick = async () => {
    // Overlap guard — mirrors the `{ max: 1, duration }` concurrency limiter
    // the BullMQ worker used, so a slow run can never stack with the next tick.
    if (running) return
    running = true
    try {
      await fn()
    } catch (err) {
      logger.error({ err, sweep: name }, `Scheduled sweep failed: ${name}`)
      // Every Group-A sweep ran with attempts:1 in BullMQ, so a failure was
      // already "final" on first occurrence and triggered an admin alert.
      // Preserve that exact behavior here.
      void createAdminNotif({
        category: 'SYSTEM',
        title: `Background sweep failed: ${name}`,
        body: `Sweep: ${name}\nError: ${err instanceof Error ? err.message : String(err)}`,
        href: '/admin',
        telegram: true,
      })
    } finally {
      running = false
    }
  }

  // No immediate first run — matches BullMQ's `repeat: { every }` behavior,
  // which (without `immediately: true`, never set here) fires its first
  // iteration after one full interval, not at registration time.
  const handle = setInterval(() => { void tick() }, intervalMs)
  activeIntervals.push(handle)
}

export function stopAllSweeps(): void {
  for (const handle of activeIntervals) clearInterval(handle)
  activeIntervals.length = 0
}
