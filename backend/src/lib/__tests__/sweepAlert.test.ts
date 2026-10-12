import { describe, it, expect } from 'vitest'
import { shouldAlertSweepFailure, SWEEP_ALERT_COOLDOWN_MS } from '../../queues/sweepAlert'

describe('shouldAlertSweepFailure', () => {
  it('alerts on the first failure', () => {
    expect(shouldAlertSweepFailure(null, 1_000)).toBe(true)
  })
  it('stays quiet while the same sweep keeps failing inside the cooldown', () => {
    expect(shouldAlertSweepFailure(1_000, 1_000 + SWEEP_ALERT_COOLDOWN_MS - 1)).toBe(false)
  })
  it('alerts again once the cooldown has passed', () => {
    expect(shouldAlertSweepFailure(1_000, 1_000 + SWEEP_ALERT_COOLDOWN_MS)).toBe(true)
  })
})
