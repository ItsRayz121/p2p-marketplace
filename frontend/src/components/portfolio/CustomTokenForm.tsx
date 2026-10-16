'use client'

import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  NAME_MAX, SYMBOL_MAX, validateCustomAsset,
  type CustomAssetField, type CustomAssetValue,
} from '@/lib/portfolio/customAsset'

export const NAME_HELP = 'Copy the exact token name from its official website or another trusted source.'
export const SOURCE_HELP = 'Helps identify similarly named tokens. Leave blank when unsure. A link does not verify the token.'

interface Props {
  /** Prefill when editing an existing tracked token. */
  initial?: Partial<CustomAssetValue>
  submitLabel?: string
  onSubmit: (value: CustomAssetValue) => Promise<void> | void
  onCancel: () => void
}

const inputCls = (invalid: boolean) =>
  `w-full rounded-lg border bg-surface text-text-primary placeholder:text-text-muted text-base px-3 py-2.5 transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-offset-0 ${
    invalid ? 'border-danger focus:ring-danger/30' : 'border-border focus:ring-primary/30 focus:border-primary'
  }`

function Field({ id, label, optional, help, error, children }: {
  id: string; label: string; optional?: boolean; help?: string; error?: string; children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-text-primary">
        {label}
        {optional && <span className="ml-1 font-normal text-text-muted">(optional)</span>}
      </label>
      {children}
      {help && <p id={`${id}-help`} className="text-xs text-text-muted">{help}</p>}
      {error && <p id={`${id}-error`} role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  )
}

export function CustomTokenForm({ initial, submitLabel = 'Add token', onSubmit, onCancel }: Props) {
  const uid = useId()
  const ids = {
    name: `${uid}-name`, symbol: `${uid}-symbol`, sourceUrl: `${uid}-source`,
    network: `${uid}-network`, contractAddress: `${uid}-contract`,
  } satisfies Record<CustomAssetField, string>

  const [values, setValues] = useState({
    name: initial?.name ?? '',
    symbol: initial?.symbol ?? '',
    sourceUrl: initial?.sourceUrl ?? '',
    network: initial?.network ?? '',
    contractAddress: initial?.contractAddress ?? '',
  })
  const [showIdentity, setShowIdentity] = useState(Boolean(initial?.network || initial?.contractAddress))
  const [errors, setErrors] = useState<Partial<Record<CustomAssetField, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)

  const set = (k: CustomAssetField) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [k]: e.target.value }))

  const aria = (k: CustomAssetField) => ({
    'aria-invalid': errors[k] ? true : undefined,
    'aria-describedby': [ids[k] + '-help', errors[k] ? ids[k] + '-error' : ''].filter(Boolean).join(' '),
  })

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setFormError(null)
    const r = validateCustomAsset(values)
    if (!r.ok) {
      setErrors(r.errors)
      const first = (Object.keys(ids) as CustomAssetField[]).find((k) => r.errors[k])
      if (first === 'network' || first === 'contractAddress') setShowIdentity(true)
      // wait a tick so a just-revealed field exists before focusing it
      setTimeout(() => first && formRef.current?.querySelector<HTMLElement>(`[id="${ids[first]}"]`)?.focus(), 0)
      return
    }
    setErrors({})
    setBusy(true)
    try {
      await onSubmit(r.value)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not save this token. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-4" aria-label={submitLabel === 'Add token' ? 'Add custom token' : 'Edit token details'}>
      <Field id={ids.name} label="Token name" help={NAME_HELP} error={errors.name}>
        <input
          id={ids.name} type="text" required autoComplete="off" maxLength={NAME_MAX * 2}
          value={values.name} onChange={set('name')} className={inputCls(!!errors.name)} {...aria('name')}
        />
      </Field>

      <Field id={ids.symbol} label="Symbol / ticker" optional error={errors.symbol}
        help="Optional. Used only to label this token for your own tracking.">
        <input
          id={ids.symbol} type="text" autoComplete="off" maxLength={SYMBOL_MAX * 2}
          value={values.symbol} onChange={set('symbol')} className={inputCls(!!errors.symbol)} {...aria('symbol')}
        />
      </Field>

      <Field id={ids.sourceUrl} label="Official website / source" optional help={SOURCE_HELP} error={errors.sourceUrl}>
        <input
          id={ids.sourceUrl} type="text" inputMode="url" autoComplete="off" placeholder="https://"
          value={values.sourceUrl} onChange={set('sourceUrl')} className={inputCls(!!errors.sourceUrl)} {...aria('sourceUrl')}
        />
      </Field>

      <div>
        <button
          type="button" aria-expanded={showIdentity} aria-controls={`${uid}-identity`}
          onClick={() => setShowIdentity((s) => !s)}
          className="text-sm font-medium text-primary hover:underline"
        >
          {showIdentity ? 'Hide network and contract details' : 'Add network and contract details (optional)'}
        </button>
        {showIdentity && (
          <div id={`${uid}-identity`} className="mt-3 space-y-4">
            <Field id={ids.network} label="Network" optional error={errors.network}
              help="For example BEP20, Ethereum or Solana. Leave blank if you do not know.">
              <input
                id={ids.network} type="text" autoComplete="off"
                value={values.network} onChange={set('network')} className={inputCls(!!errors.network)} {...aria('network')}
              />
            </Field>
            <Field id={ids.contractAddress} label="Contract address" optional error={errors.contractAddress}
              help="Without a network and contract, this token is tracked manually only.">
              <input
                id={ids.contractAddress} type="text" autoComplete="off" spellCheck={false}
                value={values.contractAddress} onChange={set('contractAddress')} className={inputCls(!!errors.contractAddress)} {...aria('contractAddress')}
              />
            </Field>
          </div>
        )}
      </div>

      <p className="text-xs text-text-muted">
        Tracked tokens are for your own records only. Adding one does not list it, enable trading, or verify it, and nothing is shared.
      </p>

      {formError && <p role="alert" className="text-sm text-danger">{formError}</p>}

      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm font-semibold rounded-lg border border-border text-text-secondary hover:bg-surface-hover">
          Cancel
        </button>
        <button type="submit" disabled={busy} className="px-4 py-2 text-sm font-semibold rounded-lg bg-primary text-white disabled:opacity-60">
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  )
}
