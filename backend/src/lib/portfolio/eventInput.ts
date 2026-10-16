import { z } from 'zod'
import { cleanText } from '../portfolioAsset'

/** Decimal STRING, never a JSON number: no exponent, no float rounding, bounded digits. */
export const AMOUNT_RE = /^\d{1,28}(\.\d{1,18})?$/

const amount = z.string().regex(AMOUNT_RE, 'Enter a plain number, for example 1250.5')
const isZero = (s: string) => /^0+(\.0+)?$/.test(s)
const EARLIEST = Date.parse('2009-01-03T00:00:00Z')
/** Clock-skew allowance; records dated in the future are rejected. */
const FUTURE_SLACK_MS = 5 * 60 * 1000

const quoteEnum = z.enum(['PKR', 'USDT'])
/** PKR per 1 USDT, plain positive decimal. */
const rate = z.string().regex(/^\d{1,10}(\.\d{1,18})?$/, 'Enter the exchange rate as a plain number, for example 280.5').refine((r) => !isZero(r), 'Exchange rate must be greater than zero')

export const eventSchema = z.object({
  type: z.enum(['BUY', 'SELL', 'OPENING']),
  occurredAt: z.string().datetime({ offset: true, message: 'Enter a valid date and time' }),
  quantity: amount,
  consideration: amount.nullish(),
  fee: amount.nullish(),
  basis: amount.nullish(),
  zeroCost: z.boolean().optional(),
  quote: quoteEnum.optional(),
  fxRate: rate.nullish(),
  note: z.string().max(1000).nullish(),
  priceBasis: z.enum(['platform', 'own']).nullish(),
  clientRequestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).nullish(),
}).strict().superRefine((e, ctx) => {
  const bad = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message })
  const t = Date.parse(e.occurredAt)
  if (t < EARLIEST) bad('occurredAt', 'Date is too far in the past')
  if (t > Date.now() + FUTURE_SLACK_MS) bad('occurredAt', 'Date cannot be in the future')
  if (isZero(e.quantity)) bad('quantity', 'Quantity must be greater than zero')

  if (e.type === 'OPENING') {
    if (e.consideration != null || e.fee != null) bad('consideration', 'An opening holding has no consideration or fee')
    if (e.priceBasis != null) bad('priceBasis', 'An opening holding has no price')
    if (e.basis != null && isZero(e.basis) && !e.zeroCost) bad('basis', 'A zero cost must be confirmed explicitly')
    if (e.zeroCost && (e.basis == null || !isZero(e.basis))) bad('zeroCost', 'Zero cost requires a basis of 0')
  } else {
    if (e.consideration == null) bad('consideration', 'Enter the amount paid or received')
    if (e.basis != null || e.zeroCost) bad('basis', 'Cost basis applies to opening holdings only')
  }
})

export type EventInput = z.infer<typeof eventSchema>

export function cleanNote(note: string | null | undefined): string | null {
  const c = cleanText(note ?? '')
  return c ? c.slice(0, 200) : null
}

/** Where a typed-in price came from. Free text is deliberately not accepted. */
export const PRICE_SOURCES = ['manual', 'p2p', 'exchange', 'other'] as const

export const priceSchema = z.object({
  price: amount.refine((p) => !isZero(p), 'Price must be greater than zero'),
  quote: quoteEnum.optional(),
  source: z.enum(PRICE_SOURCES).optional(),
}).strict()
