'use client'
import { cn } from '@/lib/utils'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'

interface CopyButtonProps {
  text: string
  size?: 'sm' | 'md'
  className?: string
}

export function CopyButton({ text, size = 'md', className }: CopyButtonProps) {
  const { copy, copied } = useCopyToClipboard()

  const iconSize = size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4'
  const buttonSize = size === 'sm' ? 'p-1' : 'p-1.5'

  return (
    <button
      type="button"
      onClick={() => copy(text)}
      className={cn(
        'inline-flex items-center justify-center rounded-md transition-colors',
        'text-text-muted hover:text-text-primary hover:bg-surface',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        buttonSize,
        className,
      )}
      aria-label={copied ? 'Copied' : 'Copy to clipboard'}
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
    </button>
  )
}
