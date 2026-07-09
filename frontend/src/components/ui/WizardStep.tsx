'use client'
import { ChevronDown } from 'lucide-react'

/**
 * Collapsible step header for the Start-Trade wizards (USDT marketplace + CTM).
 * Defined once and shared so both markets read as the same guided 3-step flow.
 * Keep it OUTSIDE the page component so inputs inside a step body are not
 * remounted every render (which would drop focus while typing).
 */
export function WizardStepHeader({ n, title, subtitle, done, open, onClick }: {
  n: number; title: string; subtitle?: string; done: boolean; open: boolean; onClick: () => void
}) {
  return (
    <button type="button" onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-colors ${open ? 'border-primary bg-primary/5' : 'border-border bg-surface hover:border-primary/40'}`}>
      <span className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${done ? 'bg-green-600 text-white' : open ? 'bg-primary text-white' : 'bg-surface-alt text-text-secondary'}`}>
        {done ? '✓' : n}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-semibold text-text-primary">{title}</span>
        {subtitle && <span className="block text-xs text-text-muted truncate">{subtitle}</span>}
      </span>
      <ChevronDown size={18} className={`flex-shrink-0 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
  )
}
