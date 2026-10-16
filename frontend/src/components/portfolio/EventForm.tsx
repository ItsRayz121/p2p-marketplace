'use client'

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { PortfolioEventInput, PortfolioEventType } from '@/lib/portfolio/types'
import { AMOUNT_RE, isZeroAmount } from '@/lib/portfolio/format'

export const RECORD_ONLY_NOTICE =
  'This only adds a record to your own tracker. It does not buy or sell anything on RupChain and never changes your wallet balance.'

const TYPE_LABEL: Record<PortfolioEventType, string> = { BUY: 'Buy', SELL: 'Sell', OPENING: 'Opening holding' }

type Field = 'quantity' | 'consideration' | 'fee' | 'basis' | 'occurredAt'

function newRequestId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined
  return c?.randomUUID ? c.randomUUID() : `r${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

/** `datetime-local` value (local time, minute precision) for "now". */
function nowLocal(): string {
  const d = new Date()
  d.setSeconds(0, 0)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

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
  onSubmit: (input: PortfolioEventInput) => Promise<void> | void
  onCancel: () => void
}

export function EventForm({ assetName, defaultType = 'BUY', onSubmit, onCancel }: Props) {
  const uid = useId()
  const id = (k: string) => `${uid}-${k}`
  const requestId = useRef(newRequestId())
  const firstRef = useRef<HTMLSelectElement>(null)
  useEffect(() => { firstRef.current?.focus() }, [])

  const [type, setType] = useState<PortfolioEventType>(defaultType)
  const [when, setWhen] = useState(nowLocal)
  const [quantity, setQuantity] = useState('')
  const [consideration, setConsideration] = useState('')
  const [fee, setFee] = useState('')
  const [basis, setBasis] = useState('')
  const [zeroCost, setZeroCost] = useState(false)
  const [note, setNote] = useState('')
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const trade = type !== 'OPENING'
  const amountLabel = type === 'BUY' ? 'Amount paid (PKR)' : 'Amount received (PKR)'

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setFormError(null)
    const errs: Partial<Record<Field, string>> = {}
    const q = quantity.trim(), c = consideration.trim(), f = fee.trim(), b = basis.trim()

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
      const order: Field[] = ['occurredAt', 'quantity', 'consideration', 'fee', 'basis']
      const first = order.find((k) => errs[k])
      if (first) document.getElementById(id(first))?.focus()
      return
    }
    setErrors({})

    const input: PortfolioEventInput = { type, occurredAt: new Date(when).toISOString(), quantity: q, clientRequestId: requestId.current }
    if (trade) {
      input.consideration = c
      if (f) input.fee = f
    } else if (zeroCost) {
      input.basis = '0'
      input.zeroCost = true
    } else if (b) {
      input.basis = b
    }
    const n = note.trim()
    if (n) input.note = n

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
    <form onSubmit={submit} noValidate className="space-y-4" aria-label={`Record an entry for ${assetName}`}>
      <p className="text-xs text-text-muted">{RECORD_ONLY_NOTICE}</p>

      <Row id={id('type')} label="Type">
        <select
          ref={firstRef} id={id('type')} value={type} className={inputCls(false)}
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

      {trade ? (
        <>
          <Row id={id('consideration')} label={amountLabel} help="Total for the whole quantity, before the fee." error={errors.consideration}>
            <input id={id('consideration')} type="text" inputMode="decimal" autoComplete="off" value={consideration} onChange={(e) => setConsideration(e.target.value)} className={inputCls(!!errors.consideration)} {...d('consideration')} />
          </Row>
          <Row
            id={id('fee')} label="Fee (PKR), optional" error={errors.fee}
            help={type === 'BUY' ? 'Added to your cost.' : 'Deducted from what you received.'}
          >
            <input id={id('fee')} type="text" inputMode="decimal" autoComplete="off" value={fee} onChange={(e) => setFee(e.target.value)} className={inputCls(!!errors.fee)} {...d('fee')} />
          </Row>
        </>
      ) : (
        <>
          <Row
            id={id('basis')} label="Total cost (PKR), optional" error={errors.basis}
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

      <Row id={id('note')} label="Note, optional">
        <input id={id('note')} type="text" maxLength={200} autoComplete="off" value={note} onChange={(e) => setNote(e.target.value)} className={inputCls(false)} />
      </Row>

      {formError && <p role="alert" className="text-sm text-danger">{formError}</p>}

      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm font-semibold rounded-lg border border-border text-text-secondary hover:bg-surface-hover">Cancel</button>
        <button type="submit" disabled={busy} className="px-4 py-2 text-sm font-semibold rounded-lg bg-primary text-white disabled:opacity-60">
          {busy ? 'Saving…' : 'Save entry'}
        </button>
      </div>
    </form>
  )
}
