import { cleanText } from '../customAsset'
import type { Currency, PortfolioEventInput } from '../types'

/**
 * The same rules the server applies to a recorded entry (backend/src/lib/portfolio/eventInput.ts),
 * for the local-only tracker. A server-side parity test runs both against the same cases.
 */
const AMOUNT_RE = /^\d{1,28}(\.\d{1,18})?$/
const RATE_RE = /^\d{1,10}(\.\d{1,18})?$/
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const EARLIEST = Date.parse('2009-01-03T00:00:00Z')
const FUTURE_SLACK_MS = 5 * 60 * 1000
const ALLOWED = new Set(['type', 'occurredAt', 'quantity', 'consideration', 'fee', 'basis', 'zeroCost', 'quote', 'fxRate', 'note', 'priceBasis', 'clientRequestId'])

const isZero = (s: string) => /^0+(\.0+)?$/.test(s)

export interface CleanEvent {
  type: 'BUY' | 'SELL' | 'OPENING'
  occurredAt: string
  quantity: string
  consideration: string | null
  fee: string | null
  basis: string | null
  zeroCost: boolean
  quote: Currency
  fxRate: string | null
  note: string | null
  priceBasis: 'platform' | 'own' | null
  clientRequestId: string | null
}

export type EventCheck = { ok: true; value: CleanEvent } | { ok: false; error: string }

const present = (v: unknown): v is string => v !== undefined && v !== null

/** True when the calendar date in an ISO string is real (2026-02-31 is not). */
function realDate(iso: string): boolean {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return false
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)!
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
}

export function validateEventInput(input: PortfolioEventInput, nowMs: number): EventCheck {
  const bad = (error: string): EventCheck => ({ ok: false, error })
  const raw = input as unknown as Record<string, unknown>
  for (const k of Object.keys(raw)) if (!ALLOWED.has(k)) return bad('Invalid record')

  const { type } = input
  if (type !== 'BUY' && type !== 'SELL' && type !== 'OPENING') return bad('Invalid record')
  if (typeof input.occurredAt !== 'string' || !ISO_RE.test(input.occurredAt) || !realDate(input.occurredAt)) return bad('Enter a valid date and time')
  for (const k of ['quantity', 'consideration', 'fee', 'basis'] as const) {
    const v = raw[k]
    if (present(v) && (typeof v !== 'string' || !AMOUNT_RE.test(v))) return bad('Enter a plain number, for example 1250.5')
  }
  if (typeof input.quantity !== 'string') return bad('Enter a plain number, for example 1250.5')
  if (input.quote !== undefined && input.quote !== 'PKR' && input.quote !== 'USDT') return bad('Invalid record')
  if (present(input.fxRate)) {
    if (typeof input.fxRate !== 'string' || !RATE_RE.test(input.fxRate)) return bad('Enter the exchange rate as a plain number, for example 280.5')
    if (isZero(input.fxRate)) return bad('Exchange rate must be greater than zero')
  }
  if (input.zeroCost !== undefined && typeof input.zeroCost !== 'boolean') return bad('Invalid record')
  if (present(input.priceBasis) && input.priceBasis !== 'platform' && input.priceBasis !== 'own') return bad('Invalid record')
  if (present(input.note) && (typeof input.note !== 'string' || input.note.length > 1000)) return bad('Invalid record')
  if (present(input.clientRequestId) && (typeof input.clientRequestId !== 'string' || !REQUEST_ID_RE.test(input.clientRequestId))) return bad('Invalid record')

  const t = Date.parse(input.occurredAt)
  if (t < EARLIEST) return bad('Date is too far in the past')
  if (t > nowMs + FUTURE_SLACK_MS) return bad('Date cannot be in the future')
  if (isZero(input.quantity)) return bad('Quantity must be greater than zero')

  if (type === 'OPENING') {
    if (present(input.consideration) || present(input.fee)) return bad('An opening holding has no consideration or fee')
    if (present(input.priceBasis)) return bad('An opening holding has no price')
    if (present(input.basis) && isZero(input.basis) && !input.zeroCost) return bad('A zero cost must be confirmed explicitly')
    if (input.zeroCost && (!present(input.basis) || !isZero(input.basis))) return bad('Zero cost requires a basis of 0')
  } else {
    if (!present(input.consideration)) return bad('Enter the amount paid or received')
    if (present(input.basis) || input.zeroCost) return bad('Cost basis applies to opening holdings only')
  }

  const note = cleanText(input.note ?? '')
  return {
    ok: true,
    value: {
      type,
      occurredAt: new Date(t).toISOString(),
      quantity: input.quantity,
      consideration: type === 'OPENING' ? null : (input.consideration ?? null),
      fee: type === 'OPENING' ? null : (input.fee ?? '0'),
      basis: type === 'OPENING' ? (input.basis ?? null) : null,
      zeroCost: type === 'OPENING' ? Boolean(input.zeroCost) : false,
      quote: input.quote ?? 'PKR',
      fxRate: input.fxRate ?? null,
      note: note ? note.slice(0, 200) : null,
      priceBasis: type === 'OPENING' ? null : (input.priceBasis ?? null),
      clientRequestId: input.clientRequestId ?? null,
    },
  }
}
