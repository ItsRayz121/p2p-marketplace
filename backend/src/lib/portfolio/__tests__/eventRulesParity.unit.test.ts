import { describe, it, expect } from 'vitest'
import { eventSchema } from '../eventInput'
// The browser copy of the same rules (used by the local-only guest tracker).
import { validateEventInput } from '../../../../../frontend/src/lib/portfolio/local/eventRules'

const past = '2026-01-02T00:00:00.000Z'
const base = { type: 'BUY', occurredAt: past, quantity: '1', consideration: '10' }
const now = () => Date.now()
const iso = (offsetMs: number) => new Date(now() + offsetMs).toISOString()

/** Each case is run through BOTH implementations; they must agree on accept / reject. */
const cases: Array<[string, Record<string, unknown>]> = [
  ['a plain buy', base],
  ['a plain sell with fee', { ...base, type: 'SELL', fee: '1.5' }],
  ['opening, unknown cost', { type: 'OPENING', occurredAt: past, quantity: '10' }],
  ['opening, known cost', { type: 'OPENING', occurredAt: past, quantity: '10', basis: '55.5' }],
  ['opening, explicit zero cost', { type: 'OPENING', occurredAt: past, quantity: '10', basis: '0', zeroCost: true }],
  ['opening, zero basis not confirmed', { type: 'OPENING', occurredAt: past, quantity: '10', basis: '0' }],
  ['opening, zeroCost without basis', { type: 'OPENING', occurredAt: past, quantity: '10', zeroCost: true }],
  ['opening with consideration', { type: 'OPENING', occurredAt: past, quantity: '10', consideration: '5' }],
  ['opening with fee', { type: 'OPENING', occurredAt: past, quantity: '10', fee: '1' }],
  ['buy with basis', { ...base, basis: '5' }],
  ['buy with zeroCost', { ...base, zeroCost: true }],
  ['buy without consideration', { type: 'BUY', occurredAt: past, quantity: '1' }],
  ['unknown type', { ...base, type: 'TRANSFER' }],
  ['missing type', { occurredAt: past, quantity: '1', consideration: '10' }],
  ['zero quantity', { ...base, quantity: '0' }],
  ['zero quantity with decimals', { ...base, quantity: '0.000' }],
  ['negative quantity', { ...base, quantity: '-1' }],
  ['NaN', { ...base, quantity: 'NaN' }],
  ['exponent', { ...base, quantity: '1e5' }],
  ['comma decimal', { ...base, quantity: '1,5' }],
  ['number instead of string', { ...base, quantity: 5 }],
  ['19 decimal places', { ...base, quantity: '0.0000000000000000001' }],
  ['18 decimal places', { ...base, quantity: '0.000000000000000001' }],
  ['29 integer digits', { ...base, quantity: '9'.repeat(29) }],
  ['28 integer digits', { ...base, quantity: '9'.repeat(28) }],
  ['negative consideration', { ...base, consideration: '-10' }],
  ['negative fee', { ...base, fee: '-1' }],
  ['zero consideration', { ...base, consideration: '0' }],
  ['date without time', { ...base, occurredAt: '2026-01-02' }],
  ['impossible date', { ...base, occurredAt: '2026-02-31T00:00:00Z' }],
  ['not a date', { ...base, occurredAt: 'yesterday' }],
  ['with a UTC offset', { ...base, occurredAt: '2026-01-02T10:00:00+05:00' }],
  ['before bitcoin', { ...base, occurredAt: '1999-01-01T00:00:00Z' }],
  ['far future', { ...base, occurredAt: '2999-01-01T00:00:00Z' }],
  ['one hour ahead', { ...base, occurredAt: iso(60 * 60 * 1000) }],
  ['one minute ahead (clock skew allowed)', { ...base, occurredAt: iso(60 * 1000) }],
  ['currency USDT', { ...base, quote: 'USDT' }],
  ['currency EUR', { ...base, quote: 'EUR' }],
  ['valid rate', { ...base, fxRate: '280.5' }],
  ['zero rate', { ...base, fxRate: '0' }],
  ['negative rate', { ...base, fxRate: '-1' }],
  ['rate with exponent', { ...base, fxRate: '1e3' }],
  ['rate with 11 integer digits', { ...base, fxRate: '12345678901' }],
  ['null rate', { ...base, fxRate: null }],
  ['valid request id', { ...base, clientRequestId: 'req-12345678' }],
  ['short request id', { ...base, clientRequestId: 'short' }],
  ['request id with a bad character', { ...base, clientRequestId: 'req 12345678' }],
  ['note', { ...base, note: 'hello' }],
  ['note that is too long', { ...base, note: 'x'.repeat(1001) }],
  ['unknown field', { ...base, userId: 'victim' }],
  ['unknown field "id"', { ...base, id: 'forced' }],
  ['zeroCost not a boolean', { type: 'OPENING', occurredAt: past, quantity: '1', basis: '0', zeroCost: 'true' }],
]

describe('the browser applies exactly the server\'s rules to a recorded entry', () => {
  it.each(cases)('%s', (_label, input) => {
    const server = eventSchema.safeParse(input).success
    const browser = validateEventInput(input as never, now()).ok
    expect(browser).toBe(server)
  })

  it('normalises the same way for an accepted entry', () => {
    const r = validateEventInput({ ...base, fee: undefined, note: 'a' + String.fromCodePoint(0x202e) + 'b' } as never, now())
    expect(r.ok && r.value).toMatchObject({ fee: '0', quote: 'PKR', basis: null, zeroCost: false, note: 'a b', occurredAt: past })
  })
})
