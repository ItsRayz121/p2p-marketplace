'use client'
import { cn } from '@/lib/utils'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { hapticSelection } from '@/lib/telegram'

interface CopyButtonProps {
  text: string
  size?: 'sm' | 'md'
  className?: string
  /** Accessible name / tooltip, e.g. "Copy account number". */
  label?: string
  /** Show a visible "Copied" confirmation next to the icon for 2s after copying. */
  showCopiedText?: boolean
}

export function CopyButton({ text, size = 'md', className, label = 'Copy to clipboard', showCopiedText = false }: CopyButtonProps) {
  const { copy, copied } = useCopyToClipboard()

  const iconSize = size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4'
  const buttonSize = size === 'sm' ? 'p-1' : 'p-1.5'

  return (
    <button
      type="button"
      onClick={() => { hapticSelection(); void copy(text) }}
      className={cn(
        'inline-flex items-center justify-center gap-1 rounded-md transition-colors',
        'text-text-muted hover:text-text-primary hover:bg-surface',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        buttonSize,
        className,
      )}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
    >
      {copied ? (
        <svg className={cn(iconSize, 'text-success')} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className={iconSize} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
      {showCopiedText && copied && <span className="text-xs font-medium text-success" role="status">Copied</span>}
    </button>
  )
}
