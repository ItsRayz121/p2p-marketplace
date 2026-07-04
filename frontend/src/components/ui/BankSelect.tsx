'use client'
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Check, Search } from 'lucide-react'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { cn } from '@/lib/utils'

/**
 * Custom bank picker — a native <select> cannot render bank logos and lets long
 * names wrap onto two lines. This dropdown shows each bank's logo, keeps the
 * name to a single truncated line, and adds a quick search for the ~20 PK banks.
 */
export function BankSelect({
  banks, value, onChange, placeholder = '— Choose a bank —',
}: {
  banks: readonly string[]
  value: string | null
  onChange: (bank: string) => void
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const filtered = query.trim()
    ? banks.filter((b) => b.toLowerCase().includes(query.trim().toLowerCase()))
    : banks

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm border border-border rounded-lg bg-surface text-left focus:outline-none focus:ring-2 focus:ring-primary"
      >
        {value ? (
          <>
            <EntityLogo type="bank" slug={value} size="xs" className="flex-shrink-0" />
            <span className="flex-1 min-w-0 truncate text-text-primary">{value}</span>
          </>
        ) : (
          <span className="flex-1 text-text-muted">{placeholder}</span>
        )}
        <ChevronDown size={16} className={cn('flex-shrink-0 text-text-muted transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full rounded-lg border border-border bg-surface shadow-lg max-h-72 overflow-hidden flex flex-col">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
            <Search size={14} className="text-text-muted flex-shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search bank…"
              className="flex-1 min-w-0 bg-transparent text-sm text-text-primary focus:outline-none"
            />
          </div>
          <div className="overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-3 text-xs text-text-muted">No banks match “{query}”.</p>
            ) : (
              filtered.map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => { onChange(b); setOpen(false); setQuery('') }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-alt transition-colors"
                >
                  <EntityLogo type="bank" slug={b} size="xs" className="flex-shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-sm text-text-primary">{b}</span>
                  {value === b && <Check size={14} className="flex-shrink-0 text-primary" />}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
