'use client'
import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { EntityLogo } from '@/components/ui/EntityLogo'

export interface TokenOption {
  id: string
  name: string
  symbol: string
  logoUrl?: string | null
}

interface TokenSelectProps {
  tokens: TokenOption[]
  value: string
  onChange: (tokenId: string) => void
  /** Placeholder shown when nothing is selected. */
  placeholder?: string
  /** When set, an extra "all" entry (empty value) is prepended with this label — useful for filters. */
  allLabel?: string
  className?: string
  /** Smaller paddings/logo for compact filter bars. */
  compact?: boolean
  disabled?: boolean
}

/**
 * Custom token dropdown that renders each token's logo beside its name. A native
 * <select> cannot show images, so this is a lightweight click-to-open list with
 * the same selection semantics (controlled value + onChange with the token id).
 */
export function TokenSelect({
  tokens, value, onChange, placeholder = 'Select a token', allLabel, className = '', compact = false, disabled = false,
}: TokenSelectProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  const selected = tokens.find((t) => t.id === value) ?? null
  const logoSize = compact ? 'xs' : 'sm'
  const btnPad = compact ? 'px-3 py-2' : 'px-3 py-2.5'

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`w-full flex items-center gap-2 ${btnPad} text-sm bg-surface border border-border rounded-xl text-left focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60 ${open ? 'ring-2 ring-primary/30' : ''}`}
      >
        {selected ? (
          <>
            <EntityLogo type="token" slug={selected.symbol} size={logoSize} logoUrl={selected.logoUrl} className="flex-shrink-0" />
            <span className="flex-1 min-w-0 truncate text-text-primary">{selected.name} ({selected.symbol})</span>
          </>
        ) : (
          <span className="flex-1 min-w-0 truncate text-text-muted">{allLabel ?? placeholder}</span>
        )}
        <ChevronDown size={14} className={`flex-shrink-0 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full max-h-72 overflow-y-auto bg-surface border border-border rounded-xl shadow-card py-1">
          {allLabel && (
            <button
              type="button"
              onClick={() => { onChange(''); setOpen(false) }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-surface-alt transition-colors ${value === '' ? 'bg-primary/5 text-primary' : 'text-text-primary'}`}
            >
              <span className="w-6 flex-shrink-0" />
              {allLabel}
            </button>
          )}
          {tokens.map((t) => (
            <button
              type="button"
              key={t.id}
              onClick={() => { onChange(t.id); setOpen(false) }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-surface-alt transition-colors ${value === t.id ? 'bg-primary/5' : ''}`}
            >
              <EntityLogo type="token" slug={t.symbol} size="sm" logoUrl={t.logoUrl} className="flex-shrink-0" />
              <span className="flex-1 min-w-0 truncate text-text-primary">{t.name} <span className="text-text-muted">({t.symbol})</span></span>
            </button>
          ))}
          {tokens.length === 0 && (
            <p className="px-3 py-2 text-sm text-text-muted">No tokens available.</p>
          )}
        </div>
      )}
    </div>
  )
}
