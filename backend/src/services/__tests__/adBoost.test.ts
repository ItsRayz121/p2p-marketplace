import { describe, it, expect } from 'vitest'
import { MAX_BOOST_HOURS, nextBoostEnd, validPlan } from '../adBoost.rules'

const now = new Date('2026-10-10T00:00:00Z')
const h = (n: number) => new Date(now.getTime() + n * 3_600_000)

describe('nextBoostEnd', () => {
  it('starts from now when there is no boost or it already expired', () => {
    expect(nextBoostEnd(now, null, 24)).toEqual(h(24))
    expect(nextBoostEnd(now, h(-5), 24)).toEqual(h(24))
  })
  it('extends from the current end while a boost is still running', () => {
    expect(nextBoostEnd(now, h(10), 24)).toEqual(h(34))
  })
  it('refuses to stack beyond the cap but allows exactly the cap', () => {
    expect(nextBoostEnd(now, h(MAX_BOOST_HOURS - 1), 24)).toBeNull()
    expect(nextBoostEnd(now, null, MAX_BOOST_HOURS)).toEqual(h(MAX_BOOST_HOURS))
  })
})

describe('validPlan', () => {
  it('accepts a sane plan and rejects bad cost, hours or key', () => {
    expect(validPlan({ key: 'day', hours: 24, cost: 60 })).toMatchObject({ key: 'day', hours: 24, cost: 60 })
    expect(validPlan({ key: 'day', hours: 24, cost: 0 })).toBeNull()
    expect(validPlan({ key: 'day', hours: 0, cost: 5 })).toBeNull()
    expect(validPlan({ key: 'day', hours: MAX_BOOST_HOURS + 1, cost: 5 })).toBeNull()
    expect(validPlan({ key: 'Bad Key', hours: 24, cost: 5 })).toBeNull()
  })
})
