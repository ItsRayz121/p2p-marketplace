// A sweep that keeps failing (DB down, bad config) would otherwise raise one admin
// alert per tick — every minute for the fast sweeps. Alert on the first failure,
// then at most once per window while it keeps failing; a success re-arms it.
export const SWEEP_ALERT_COOLDOWN_MS = 30 * 60 * 1000

/** Pure so it can be tested: should this failure raise an admin alert? */
export function shouldAlertSweepFailure(lastAlertAt: number | null, now: number): boolean {
  return lastAlertAt === null || now - lastAlertAt >= SWEEP_ALERT_COOLDOWN_MS
}
