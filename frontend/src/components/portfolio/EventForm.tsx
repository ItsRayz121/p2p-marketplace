'use client'

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { Currency, PortfolioEvent, PortfolioEventInput, PortfolioEventType, PriceBasis } from '@/lib/portfolio/types'
import { D } from '@/lib/portfolio/engine/decimal'
import { AMOUNT_RE, formatDecimal, formatQuantity, isZeroAmount } from '@/lib/portfolio/format'

export const RECORD_ONLY_NOTICE =
  'This only adds a record to your own tracker. It does not buy or sell anything on RupChain and never changes your wallet balance.'

export const RATE_HELP =
  "Used to show this entry in the other currency. Leave blank to use RupChain's current rate for entries dated now. For older entries, enter the rate for that date, otherwise this entry cannot be shown in the other currency."

const TYPE_LABEL: Record<PortfolioEventType, string> = { BUY: 'Buy', SELL: 'Sell', OPENING: 'Opening holding' }

/** A record dated within this long of now may use the latest RupChain price (it is not a historical price). */
const PLATFORM_PRICE_WINDOW_MS = 24 * 60 * 60 * 1000

type Field = 'quantity' | 'consideration' | 'fee' | 'basis' | 'occurredAt' | 'fxRate'

function newRequestId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined
  return c?.randomUUID ? c.randomUUID() : `r${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

/** `datetime-local` value (local time, minute precision) for a moment, default "now". */
function localValue(d: Date = new Date()): string {
  const x = new Date(d)
  x.setSeconds(0, 0)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`
}
const nowLocal = () => localValue()

const inputCls = (bad: boolean) =>
  `w-full rounded-lg border bg-surface text-text-primary text-base px-3 py-2.5 focus:outline-none focus:ring-2 ${
    bad ? 'border-danger focus:ring-danger/30' : 'border-border focus:ring-primary/30 focus:border-primary'
  }`

function Row({ id, label, help, error, children }: { id: string; label: string; help?: string; error?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-text-primary">{label}</label>
      {children}
      {help && <p id={`${id}-help`} className="text-xs text-text-muted">{help}</p>}
      {error && <p id={`${id}-error`} role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  )
}

interface Props {
  assetName: string
  defaultType?: PortfolioEventType
  /** Pre-selected currency: the one the portfolio is currently shown in. */
  defaultCurrency?: Currency
  onSubmit: (input: PortfolioEventInput) => Promise<void> | void
  onCancel: () => void
  /** The latest proven RupChain price per token, if the token has one. Offered only for new entries dated now. */
  platformPrice?: { price: string; quote: Currency } | null
  /** Values to start from when recording something that is already known (for example a RupChain trade). */
  prefill?: Partial<Pick<PortfolioEventInput, 'type' | 'occurredAt' | 'quantity' | 'consideration' | 'quote'>>
  /** The type cannot be changed (a trade was a buy or a sell for you, whichever you prefer). */
  lockType?: boolean
  /** Extra line shown under the standard notice. */
  extraNotice?: string
  /** Correct an existing entry instead of recording a new one. */
  initial?: PortfolioEvent
  /** Returns a warning to show before saving (the user can still save anyway), or null. */
  warn?: (input: PortfolioEventInput) => string | null
}

export function EventForm({ assetName, defaultType = 'BUY', defaultCurrency = 'PKR', onSubmit, onCancel, initial, warn, prefill, lockType, extraNotice, platformPrice }: Props) {
  const uid = useId()
  const id = (k: string) => `${uid}-${k}`
  const requestId = useRef(newRequestId())
  const firstRef = useRef<HTMLSelectElement>(null)
  useEffect(() => { firstRef.current?.focus() }, [])

  // The moment the form starts from: the entry being corrected, or the trade being recorded.
  const seedAt = initial?.occurredAt ?? prefill?.occurredAt
  const initialWhen = seedAt ? localValue(new Date(seedAt)) : ''
  const [type, setType] = useState<PortfolioEventType>(initial?.type ?? prefill?.type ?? defaultType)
  const [quote, setQuote] = useState<Currency>(initial?.quote ?? prefill?.quote ?? defaultCurrency)
  const [when, setWhen] = useState(seedAt ? initialWhen : nowLocal)
  const [quantity, setQuantity] = useState(initial?.quantity ?? prefill?.quantity ?? '')
  const [consideration, setConsideration] = useState(initial?.consideration ?? prefill?.consideration ?? '')
  const [fee, setFee] = useState(initial?.fee && !isZeroAmount(initial.fee) ? initial.fee : '')
  const [basis, setBasis] = useState(initial && !initial.zeroCost ? (initial.basis ?? '') : '')
  // A rate the user typed is shown for correction; one stamped from the platform stays on the entry unless a new one is typed.
  const [fxRate, setFxRate] = useState(initial?.fxSource === 'manual' ? (initial.fxRate ?? '') : '')
  const [zeroCost, setZeroCost] = useState(initial?.zeroCost ?? false)
  const [note, setNote] = useState(initial?.note ?? '')
  const [warning, setWarning] = useState<string | null>(null)
  const [basisChoice, setBasisChoice] = useState<PriceBasis>(platformPrice && !initial && !prefill ? 'platform' : 'own')
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const trade = type !== 'OPENING'
  // The RupChain price is offered for a new buy/sell dated about now, in the currency that price is quoted in.
  const whenMs = Date.parse(when)
  const nowish = !Number.isNaN(whenMs) && whenMs <= Date.now() + 5 * 60 * 1000 && Date.now() - whenMs <= PLATFORM_PRICE_WINDOW_MS
  const offerPlatform = Boolean(platformPrice) && !initial && !prefill && trade && quote === platformPrice?.quote && nowish
  const usePlatform = offerPlatform && basisChoice === 'platform'
  const AMOUNT_OK = (v: string) => AMOUNT_RE.test(v) && !isZeroAmount(v)
  // quantity x RupChain price, exact, to 8 places (the same precision quantities are shown with).
  const platformTotal = usePlatform && AMOUNT_OK(quantity.trim()) ? new D(quantity.trim()).times(platformPrice!.price).toDecimalPlaces(8).toFixed() : null
  // What the user's own total works out to per token, shown so the two prices can be compared.
  const ownUnit = trade && !usePlatform && AMOUNT_OK(quantity.trim()) && AMOUNT_RE.test(consideration.trim()) && !isZeroAmount(consideration.trim())
    ? new D(consideration.trim()).div(quantity.trim()).toDecimalPlaces(8).toFixed().replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
    : null
  const amountLabel = type === 'BUY' ? `Amount paid (${quote})` : `Amount received (${quote})`

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setFormError(null)
    const errs: Partial<Record<Field, string>> = {}
    const q = quantity.trim(), f = fee.trim(), b = basis.trim(), r = fxRate.trim()
    const c = usePlatform ? (platformTotal ?? '') : consideration.trim()

    const ts = new Date(when).getTime()
    if (!when || Number.isNaN(ts)) errs.occurredAt = 'Enter a valid date and time.'
    else if (ts > Date.now() + 5 * 60 * 1000) errs.occurredAt = 'Date cannot be in the future.'

    if (!AMOUNT_RE.test(q) || isZeroAmount(q)) errs.quantity = 'Enter a quantity greater than zero, for example 12.5.'
    if (trade) {
      if (!AMOUNT_RE.test(c)) errs.consideration = 'Enter the amount as a plain number, for example 25000.'
      if (f && !AMOUNT_RE.test(f)) errs.fee = 'Enter the fee as a plain number, or leave it blank.'
    } else if (!zeroCost && b && !AMOUNT_RE.test(b)) {
      errs.basis = 'Enter the total cost as a plain number, or leave it blank if unknown.'
    }
    if (r && (!AMOUNT_RE.test(r) || isZeroAmount(r))) {
      errs.fxRate = 'Enter the rate as a plain number greater than zero, for example 280.5, or leave it blank.'
    }
    if (Object.keys(errs).length) {
      setErrors(errs)
      const order: Field[] = ['occurredAt', 'quantity', 'consideration', 'fee', 'basis', 'fxRate']
      const first = order.find((k) => errs[k])
      if (first) document.getElementById(id(first))?.focus()
      return
    }
    setErrors({})

    // An untouched date keeps its exact original time (the picker only has minute precision).
    const occurredAt = seedAt && when === initialWhen ? seedAt : new Date(when).toISOString()
    const input: PortfolioEventInput = { type, occurredAt, quantity: q, quote }
    if (!initial) input.clientRequestId = requestId.current
    if (r) input.fxRate = r
    if (trade) {
      input.consideration = c
      if (offerPlatform) input.priceBasis = basisChoice
      else if (initial?.priceBasis) input.priceBasis = initial.priceBasis
      if (f) input.fee = f
    } else if (zeroCost) {
      input.basis = '0'
      input.zeroCost = true
    } else if (b) {
      input.basis = b
    }
    const n = note.trim()
    if (n) input.note = n

    // Show a warning once; saving again confirms exactly that warning. If the values changed so the
    // warning is different, the new one is shown first.
    const w = warn ? warn(input) : null
    if (w !== warning) {
      setWarning(w)
      if (w) return
    }

    setBusy(true)
    try {
      await onSubmit(input)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not save this entry. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const d = (k: Field, helpId = true) => ({
    'aria-invalid': errors[k] ? true : undefined,
    'aria-describedby': [helpId ? `${id(k)}-help` : '', errors[k] ? `${id(k)}-error` : ''].filter(Boolean).join(' ') || undefined,
  })

  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label={initial ? `Correct an entry for ${assetName}` : `Record an entry for ${assetName}`}>
      <p className="text-xs text-text-muted">{RECORD_ONLY_NOTICE}</p>
      {initial && <p className="text-xs text-text-muted">The earlier version of this entry is kept in its history.</p>}
      {extraNotice && <p className="text-xs text-text-muted">{extraNotice}</p>}

      <Row id={id('type')} label="Type">
        <select
          ref={firstRef} id={id('type')} value={type} className={inputCls(false)} disabled={lockType}
          onChange={(e) => setType(e.target.value as PortfolioEventType)}
        >
          {(Object.keys(TYPE_LABEL) as PortfolioEventType[]).map((t) => (
            <option key={t} value={t}>{TYPE_LABEL[t]}</option>
          ))}
        </select>
      </Row>

      <Row id={id('occurredAt')} label="Date and time" error={errors.occurredAt}>
        <input id={id('occurredAt')} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className={inputCls(!!errors.occurredAt)} {...d('occurredAt', false)} />
      </Row>

      <Row id={id('quantity')} label="Quantity" error={errors.quantity}>
        <input id={id('quantity')} type="text" inputMode="decimal" autoComplete="off" value={quantity} onChange={(e) => setQuantity(e.target.value)} className={inputCls(!!errors.quantity)} {...d('quantity', false)} />
      </Row>

      <Row id={id('quote')} label="Currency of the amounts">
        <select id={id('quote')} value={quote} onChange={(e) => setQuote(e.target.value as Currency)} className={inputCls(false)}>
          <option value="PKR">PKR</option>
          <option value="USDT">USDT</option>
        </select>
      </Row>

      {trade ? (
        <>
          {offerPlatform && platformPrice && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-text-primary">Price used</legend>
              <label className="flex items-start gap-2 text-sm text-text-primary">
                <input type="radio" name={id('basis')} checked={basisChoice === 'platform'} onChange={() => setBasisChoice('platform')} className="mt-1" />
                <span>RupChain price <span className="text-text-muted">({platformPrice.quote} {formatQuantity(platformPrice.price)} per token, latest trade)</span></span>
              </label>
              <label className="flex items-start gap-2 text-sm text-text-primary">
                <input type="radio" name={id('basis')} checked={basisChoice === 'own'} onChange={() => setBasisChoice('own')} className="mt-1" />
                <span>Price I got <span className="text-text-muted">(a different price, for example from a trade outside RupChain)</span></span>
              </label>
            </fieldset>
          )}
          {usePlatform ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium text-text-primary">{amountLabel}</p>
              <p className="text-sm text-text-primary" data-testid="platform-total">
                {platformTotal === null ? 'Enter a quantity to see the amount' : `${formatDecimal(platformTotal)} ${quote}`}
              </p>
              <p className="text-xs text-text-muted">Quantity times the RupChain price, before the fee.</p>
              {errors.consideration && <p role="alert" className="text-sm text-danger">{errors.consideration}</p>}
            </div>
          ) : (
            <Row id={id('consideration')} label={amountLabel} help={ownUnit ? `That is ${quote} ${ownUnit} per token. Total for the whole quantity, before the fee.` : 'Total for the whole quantity, before the fee.'} error={errors.consideration}>
              <input id={id('consideration')} type="text" inputMode="decimal" autoComplete="off" value={consideration} onChange={(e) => setConsideration(e.target.value)} className={inputCls(!!errors.consideration)} {...d('consideration')} />
            </Row>
          )}
          <Row
            id={id('fee')} label={`Fee (${quote}), optional`} error={errors.fee}
            help={type === 'BUY' ? 'Added to your cost.' : 'Deducted from what you received.'}
          >
            <input id={id('fee')} type="text" inputMode="decimal" autoComplete="off" value={fee} onChange={(e) => setFee(e.target.value)} className={inputCls(!!errors.fee)} {...d('fee')} />
          </Row>
        </>
      ) : (
        <>
          <Row
            id={id('basis')} label={`Total cost (${quote}), optional`} error={errors.basis}
            help="Leave blank if you do not know. An unknown cost is never treated as zero, so profit and loss for these units stays unavailable."
          >
            <input id={id('basis')} type="text" inputMode="decimal" autoComplete="off" disabled={zeroCost} value={zeroCost ? '' : basis} onChange={(e) => setBasis(e.target.value)} className={inputCls(!!errors.basis)} {...d('basis')} />
          </Row>
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input type="checkbox" checked={zeroCost} onChange={(e) => setZeroCost(e.target.checked)} />
            These units cost me nothing (confirmed zero cost)
          </label>
        </>
      )}

      <Row id={id('fxRate')} label="USDT/PKR rate for this date (PKR per 1 USDT), optional" help={RATE_HELP} error={errors.fxRate}>
        <input id={id('fxRate')} type="text" inputMode="decimal" autoComplete="off" value={fxRate} onChange={(e) => setFxRate(e.target.value)} className={inputCls(!!errors.fxRate)} {...d('fxRate')} />
      </Row>

      <Row id={id('note')} label="Note, optional">
        <input id={id('note')} type="text" maxLength={200} autoComplete="off" value={note} onChange={(e) => setNote(e.target.value)} className={inputCls(false)} />
      </Row>

      {warning && <p role="alert" className="text-sm text-amber-800 bg-amber-500/10 border border-amber-500/40 rounded-lg px-3 py-2">{warning}</p>}
      {formError && <p role="alert" className="text-sm text-danger">{formError}</p>}

      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm font-semibold rounded-lg border border-border text-text-secondary hover:bg-surface-hover">Cancel</button>
        <button type="submit" disabled={busy} className="px-4 py-2 text-sm font-semibold rounded-lg bg-primary text-white disabled:opacity-60">
          {busy ? 'Saving…' : warning ? 'Save anyway' : initial ? 'Save changes' : 'Save entry'}
        </button>
      </div>
    </form>
  )
}
