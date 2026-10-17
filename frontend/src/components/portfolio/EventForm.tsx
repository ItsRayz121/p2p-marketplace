'use client'

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { Currency, PortfolioEvent, PortfolioEventInput, PortfolioEventType, PriceBasis } from '@/lib/portfolio/types'
import { D } from '@/lib/portfolio/engine/decimal'
import { convertAmount } from '@/lib/portfolio/engine/currency'
import { AMOUNT_RE, formatDecimal, formatQuantity, isZeroAmount } from '@/lib/portfolio/format'
import { InfoTip } from './InfoTip'

export const RECORD_ONLY_NOTICE =
  'This only adds a record to your own tracker. It does not buy or sell anything on RupChain and never changes your wallet balance.'

const TYPE_LABEL: Record<PortfolioEventType, string> = { BUY: 'Buy', SELL: 'Sell', OPENING: 'Previous holding' }

/** A record dated within this long of now may use the latest RupChain price (it is not a historical price). */
const PLATFORM_PRICE_WINDOW_MS = 24 * 60 * 60 * 1000

type Field = 'quantity' | 'consideration' | 'fee' | 'basis' | 'occurredAt'

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

const segCls = (on: boolean) =>
  `flex-1 px-3 py-1.5 text-sm font-semibold transition ${on ? 'bg-primary text-white' : 'bg-surface text-text-secondary hover:bg-surface-hover'}`

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
  platformPrices?: Partial<Record<Currency, string>> | null
  /** Values to start from when recording something that is already known (for example a RupChain trade). */
  prefill?: Partial<Pick<PortfolioEventInput, 'type' | 'occurredAt' | 'quantity' | 'consideration' | 'quote'>>
  /** The type cannot be changed (a trade was a buy or a sell for you, whichever you prefer). */
  lockType?: boolean
  /** Extra line shown under the standard notice. */
  extraNotice?: string
  /** Correct an existing entry instead of recording a new one. */
  initial?: PortfolioEvent
  /** Today's RupChain rate (PKR per 1 USDT), used only to show what an entry dated now comes to in the other currency. */
  usdtPkr?: string | null
  /** Returns a warning to show before saving (the user can still save anyway), or null. */
  warn?: (input: PortfolioEventInput) => string | null
  /** The moment a new entry starts from instead of "now" (for example just before the earliest record, for a previous holding). */
  defaultWhen?: Date
}

export function EventForm({ assetName, defaultType = 'BUY', defaultCurrency = 'PKR', onSubmit, onCancel, initial, warn, prefill, lockType, extraNotice, platformPrices, usdtPkr, defaultWhen }: Props) {
  const uid = useId()
  const id = (k: string) => `${uid}-${k}`
  const requestId = useRef(newRequestId())
  // Start on the quantity: it is the first thing every entry needs.
  useEffect(() => { document.getElementById(`${uid}-quantity`)?.focus() }, [uid])

  // The moment the form starts from: the entry being corrected, or the trade being recorded.
  const seedAt = initial?.occurredAt ?? prefill?.occurredAt
  const initialWhen = seedAt ? localValue(new Date(seedAt)) : ''
  const [type, setType] = useState<PortfolioEventType>(initial?.type ?? prefill?.type ?? defaultType)
  const [quote, setQuote] = useState<Currency>(initial?.quote ?? prefill?.quote ?? defaultCurrency)
  const [when, setWhen] = useState(seedAt ? initialWhen : defaultWhen ? localValue(defaultWhen) : nowLocal)
  const [quantity, setQuantity] = useState(initial?.quantity ?? prefill?.quantity ?? '')
  const [consideration, setConsideration] = useState(initial?.consideration ?? prefill?.consideration ?? '')
  const [fee, setFee] = useState(initial?.fee && !isZeroAmount(initial.fee) ? initial.fee : '')
  const [basis, setBasis] = useState(initial && !initial.zeroCost ? (initial.basis ?? '') : '')
  const [zeroCost, setZeroCost] = useState(initial?.zeroCost ?? false)
  const [note, setNote] = useState(initial?.note ?? '')
  const [warning, setWarning] = useState<string | null>(null)
  const [basisChoice, setBasisChoice] = useState<PriceBasis>(platformPrices && !initial && !prefill ? 'platform' : 'own')
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The date is "now" unless the user asks otherwise. Existing entries, trades being recorded and previous holdings show it.
  const [showWhen, setShowWhen] = useState(Boolean(seedAt) || defaultType === 'OPENING' || Boolean(defaultWhen))
  const [moreOpen, setMoreOpen] = useState(Boolean(initial?.fee && !isZeroAmount(initial.fee)) || Boolean(initial?.note) || Boolean(prefill))

  const trade = type !== 'OPENING'
  // The RupChain price is offered for a new buy/sell dated about now, in the currency that price is quoted in.
  const whenMs = Date.parse(when)
  const nowish = !Number.isNaN(whenMs) && whenMs <= Date.now() + 5 * 60 * 1000 && Date.now() - whenMs <= PLATFORM_PRICE_WINDOW_MS
  const platformPrice = platformPrices?.[quote]
  const offerPlatform = platformPrice !== undefined && !initial && !prefill && trade && nowish
  const usePlatform = offerPlatform && basisChoice === 'platform'
  const AMOUNT_OK = (v: string) => AMOUNT_RE.test(v) && !isZeroAmount(v)
  // quantity x RupChain price, exact, to 8 places (the same precision quantities are shown with).
  const platformTotal = usePlatform && AMOUNT_OK(quantity.trim()) ? new D(quantity.trim()).times(platformPrice!).toDecimalPlaces(8).toFixed() : null
  // What the user's own total works out to per token, shown so the two prices can be compared.
  const ownUnit = trade && !usePlatform && AMOUNT_OK(quantity.trim()) && AMOUNT_RE.test(consideration.trim()) && !isZeroAmount(consideration.trim())
    ? new D(consideration.trim()).div(quantity.trim()).toDecimalPlaces(8).toFixed().replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
    : null
  // What this entry comes to in the other currency, from RupChain's own rate. Only for entries dated now:
  // an older date has no rate stored, and today's rate is never passed off as the rate of that day.
  const otherQuote: Currency = quote === 'PKR' ? 'USDT' : 'PKR'
  const enteredTotal = usePlatform ? platformTotal : AMOUNT_RE.test(consideration.trim()) ? consideration.trim() : null
  const converted = trade && enteredTotal && usdtPkr && nowish ? convertAmount(enteredTotal, quote, otherQuote, usdtPkr) : null
  const conversionNote: string | null = !trade || !enteredTotal || initial ? null
    : converted !== null ? `About ${otherQuote} ${formatDecimal(converted, otherQuote === 'USDT' ? 4 : 2)} at today's RupChain rate (${formatDecimal(usdtPkr!)} PKR per USDT).`
    : !nowish && !prefill ? `No exchange rate is stored for past dates, so this entry will be shown in ${quote} only.`
    : null
  const amountLabel = type === 'BUY' ? `Amount paid (${quote})` : `Amount received (${quote})`

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setFormError(null)
    const errs: Partial<Record<Field, string>> = {}
    const q = quantity.trim(), f = fee.trim(), b = basis.trim()
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
    if (Object.keys(errs).length) {
      setErrors(errs)
      // The field with the problem may be tucked away; open it so the message is visible.
      if (errs.occurredAt) setShowWhen(true)
      if (errs.fee) setMoreOpen(true)
      const order: Field[] = ['occurredAt', 'quantity', 'consideration', 'fee', 'basis']
      const first = order.find((k) => errs[k])
      if (first) setTimeout(() => document.getElementById(id(first))?.focus(), 0)
      return
    }
    setErrors({})

    // An untouched date keeps its exact original time (the picker only has minute precision).
    const occurredAt = seedAt && when === initialWhen ? seedAt : new Date(when).toISOString()
    const input: PortfolioEventInput = { type, occurredAt, quantity: q, quote }
    if (!initial) input.clientRequestId = requestId.current
    // The rate is never typed: a rate the user entered earlier is kept, anything else is stamped by the server from the platform rate.
    if (initial?.fxSource === 'manual' && initial.fxRate) input.fxRate = initial.fxRate
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

  const currencyToggle = (
    <div role="radiogroup" aria-label="Currency" className="inline-flex flex-shrink-0 overflow-hidden rounded-lg border border-border">
      {(['PKR', 'USDT'] as const).map((c) => (
        <button
          key={c} type="button" role="radio" aria-checked={quote === c} onClick={() => setQuote(c)}
          className={`px-3 py-1 text-xs font-semibold ${quote === c ? 'bg-primary text-white' : 'bg-surface text-text-secondary hover:bg-surface-hover'}`}
        >
          {c}
        </button>
      ))}
    </div>
  )
  const hasMore = fee.trim() !== '' || note.trim() !== ''

  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label={initial ? `Correct an entry for ${assetName}` : `Record an entry for ${assetName}`}>
      {(initial || extraNotice) && (
        <p className="text-xs text-text-muted">{[initial ? 'The earlier version of this entry is kept in its history.' : '', extraNotice ?? ''].filter(Boolean).join(' ')}</p>
      )}

      {type === 'OPENING' || lockType ? (
        <p className="text-sm font-semibold text-text-primary">
          {TYPE_LABEL[type]}
          <InfoTip text={type === 'OPENING' ? 'Units you already held before your first record. Add their cost if you know it; an unknown cost is never counted as zero.' : RECORD_ONLY_NOTICE} />
        </p>
      ) : (
        <div role="radiogroup" aria-label="Type" className="flex overflow-hidden rounded-lg border border-border">
          {(['BUY', 'SELL'] as const).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={type === t} onClick={() => setType(t)} className={segCls(type === t)}>{TYPE_LABEL[t]}</button>
          ))}
        </div>
      )}

      <Row id={id('quantity')} label="Quantity" error={errors.quantity}>
        <input id={id('quantity')} type="text" inputMode="decimal" autoComplete="off" value={quantity} onChange={(e) => setQuantity(e.target.value)} className={inputCls(!!errors.quantity)} {...d('quantity', false)} />
      </Row>

      {trade ? (
        <>
          {offerPlatform && platformPrice !== undefined && (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-text-primary" id={id('basis-label')}>
                Price
                <InfoTip text={`RupChain price is the latest community-market trade price (${quote} ${formatQuantity(platformPrice)} per token). It is a platform reference, not an on-chain price. Choose My actual price to enter what you really paid or received.`} />
              </span>
              <div role="radiogroup" aria-labelledby={id('basis-label')} className="flex overflow-hidden rounded-lg border border-border">
                <button type="button" role="radio" aria-checked={basisChoice === 'platform'} onClick={() => setBasisChoice('platform')} className={segCls(basisChoice === 'platform')}>RupChain price</button>
                <button type="button" role="radio" aria-checked={basisChoice === 'own'} onClick={() => setBasisChoice('own')} className={segCls(basisChoice === 'own')}>My actual price</button>
              </div>
            </div>
          )}
          {usePlatform ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-text-primary">{amountLabel}</p>
                {currencyToggle}
              </div>
              <p className="rounded-lg border border-border bg-surface-hover/40 px-3 py-2.5 text-base text-text-primary tabular-nums" data-testid="platform-total">
                {platformTotal === null ? 'Enter a quantity to see the amount' : `${formatDecimal(platformTotal)} ${quote}`}
              </p>
              <p className="text-xs text-text-muted">{quote} {formatQuantity(platformPrice!)} per token, before the fee.</p>
              {errors.consideration && <p role="alert" className="text-sm text-danger">{errors.consideration}</p>}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={id('consideration')} className="text-sm font-medium text-text-primary">{amountLabel}</label>
                {currencyToggle}
              </div>
              <input id={id('consideration')} type="text" inputMode="decimal" autoComplete="off" value={consideration} onChange={(e) => setConsideration(e.target.value)} className={inputCls(!!errors.consideration)} {...d('consideration')} />
              <p id={`${id('consideration')}-help`} className="text-xs text-text-muted">{ownUnit ? `${quote} ${ownUnit} per token, before the fee.` : 'Total for the whole quantity, before the fee.'}</p>
              {errors.consideration && <p id={`${id('consideration')}-error`} role="alert" className="text-sm text-danger">{errors.consideration}</p>}
            </div>
          )}
          {conversionNote && <p data-testid="conversion-note" className="-mt-2 text-xs text-text-secondary">{conversionNote}</p>}
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={id('basis')} className="text-sm font-medium text-text-primary">Total cost ({quote}), optional</label>
              {currencyToggle}
            </div>
            <input id={id('basis')} type="text" inputMode="decimal" autoComplete="off" disabled={zeroCost} value={zeroCost ? '' : basis} onChange={(e) => setBasis(e.target.value)} className={inputCls(!!errors.basis)} {...d('basis')} />
            <p id={`${id('basis')}-help`} className="text-xs text-text-muted">Leave blank if unknown. It is never counted as zero.</p>
            {errors.basis && <p id={`${id('basis')}-error`} role="alert" className="text-sm text-danger">{errors.basis}</p>}
          </div>
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input type="checkbox" checked={zeroCost} onChange={(e) => setZeroCost(e.target.checked)} />
            These units cost me nothing
          </label>
        </>
      )}

      {showWhen ? (
        <Row id={id('occurredAt')} label={type === 'OPENING' ? 'Held since (before your first record)' : 'Date and time'} error={errors.occurredAt}>
          <input id={id('occurredAt')} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className={inputCls(!!errors.occurredAt)} {...d('occurredAt', false)} />
        </Row>
      ) : (
        <p className="text-sm text-text-secondary">
          Now{' · '}
          <button type="button" onClick={() => setShowWhen(true)} className="font-medium text-primary hover:underline">Different date</button>
        </p>
      )}

      {trade && (
        <div>
          <button type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
            More options{hasMore && !moreOpen ? ' •' : ''} <span aria-hidden className={`transition-transform ${moreOpen ? 'rotate-90' : ''}`}>›</span>
          </button>
        </div>
      )}
      {(moreOpen || !trade) && (
        <div className="space-y-4">
          {trade && (
            <Row id={id('fee')} label={`Fee (${quote}), optional`} error={errors.fee} help={type === 'BUY' ? 'Added to your cost.' : 'Deducted from what you received.'}>
              <input id={id('fee')} type="text" inputMode="decimal" autoComplete="off" value={fee} onChange={(e) => setFee(e.target.value)} className={inputCls(!!errors.fee)} {...d('fee')} />
            </Row>
          )}
          <Row id={id('note')} label="Note, optional">
            <input id={id('note')} type="text" maxLength={200} autoComplete="off" value={note} onChange={(e) => setNote(e.target.value)} className={inputCls(false)} />
          </Row>
        </div>
      )}

      {warning && <p role="alert" className="text-sm text-amber-800 bg-amber-500/10 border border-amber-500/40 rounded-lg px-3 py-2">{warning}</p>}
      {formError && <p role="alert" className="text-sm text-danger">{formError}</p>}

      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm font-semibold rounded-lg border border-border text-text-secondary hover:bg-surface-hover">Cancel</button>
        <button type="submit" disabled={busy} className="px-4 py-2 text-sm font-semibold rounded-lg bg-primary text-white disabled:opacity-60">
          {busy ? 'Saving…' : warning ? 'Save anyway' : initial ? 'Save changes' : 'Save'}
        </button>
      </div>
    </form>
  )
}
