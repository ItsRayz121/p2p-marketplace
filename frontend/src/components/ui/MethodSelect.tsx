'use client'
import { useState, useRef, useEffect } from 'react'
import { EntityLogo } from './EntityLogo'
import type { EntityType } from '@/lib/logoRegistry'

export interface MethodOption {
  id: string
  label: string
  /** Secondary line under the label — e.g. the account number / UID. */
  sublabel?: string
  logo: { type: EntityType; slug: string; logoUrl?: string | null }
}

/**
 * Single-select payment-method picker. Short lists (≤ `inlineThreshold`, default 2)
 * render as inline chips exactly like the rest of the app; longer lists collapse
 * into a dropdown so a 6-option method list no longer fills the whole screen. The
 * caller can't advance until a method is chosen (empty `value`). The selected row
 * can show a `sublabel` (account number / UID) beneath the method name.
 */
export function MethodSelect({
  options, value, onChange, placeholder = 'Select payment method…', inlineThreshold = 2, allowDeselect = true,
}: {
  options: MethodOption[]
  value: string
  onChange: (id: string) => void
  placeholder?: string
  inlineThreshold?: number
  allowDeselect?: boolean
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // Small lists stay as inline chips — a dropdown for 1–2 options is overkill.
  if (options.length <= inlineThreshold) {
    return (
      <div className="flex flex-wrap gap-2">
        {options.map((m) => {
          const sel = value === m.id
          return (
            <button
              type="button"
              key={m.id}
              onClick={() => onChange(sel && allowDeselect ? '' : m.id)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${sel ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-surface text-text-primary hover:border-primary/50'}`}
            >
              <EntityLogo type={m.logo.type} slug={m.logo.slug} logoUrl={m.logo.logoUrl} size="xs" className="flex-shrink-0" />
              <span className="text-left leading-tight">
                {m.label}
                {m.sublabel && <span className="block text-[11px] text-text-muted font-normal">{m.sublabel}</span>}
              </span>
              {sel && <span className="ml-0.5 text-xs">✓</span>}
            </button>
          )
        })}
      </div>
    )
  }

  const selected = options.find((o) => o.id === value)

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border border-border bg-surface text-sm text-left hover:border-primary/50 transition-colors"
      >
        {selected ? (
          <>
            <EntityLogo type={selected.logo.type} slug={selected.logo.slug} logoUrl={selected.logo.logoUrl} size="xs" className="flex-shrink-0" />
            <span className="flex-1 min-w-0 leading-tight">
              <span className="font-medium text-text-primary">{selected.label}</span>
              {selected.sublabel && <span className="block text-[11px] text-text-muted truncate">{selected.sublabel}</span>}
            </span>
          </>
        ) : (
          <span className="flex-1 text-text-muted">{placeholder}</span>
        )}
        <svg className={`w-4 h-4 text-text-muted flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
          <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-xl border border-border bg-surface shadow-card max-h-64 overflow-y-auto">
          {options.map((m) => {
            const sel = value === m.id
            return (
              <button
                type="button"
                key={m.id}
                onClick={() => { onChange(m.id); setOpen(false) }}
                className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left hover:bg-surface-alt/60 transition-colors ${sel ? 'bg-primary/5' : ''}`}
              >
                <EntityLogo type={m.logo.type} slug={m.logo.slug} logoUrl={m.logo.logoUrl} size="xs" className="flex-shrink-0" />
                <span className="flex-1 min-w-0 leading-tight">
                  <span className={`font-medium ${sel ? 'text-primary' : 'text-text-primary'}`}>{m.label}</span>
                  {m.sublabel && <span className="block text-[11px] text-text-muted truncate">{m.sublabel}</span>}
                </span>
                {sel && <span className="text-primary text-xs">✓</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
