'use client'
import { forwardRef, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { cn } from '@/lib/utils'

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: string
  leftIcon?: React.ReactNode
  rightElement?: React.ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(({
  label,
  error,
  hint,
  leftIcon,
  rightElement,
  disabled,
  className,
  id,
  type,
  ...props
}, ref) => {
  const inputId = id ?? (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined)

  // Built-in show/hide toggle for password fields (unless the caller supplies its
  // own rightElement). Lets users verify what they typed — important on mobile
  // where mistypes are common. tabIndex={-1} keeps tab order on the inputs.
  const [reveal, setReveal] = useState(false)
  const isPassword = type === 'password'
  const effectiveType = isPassword && reveal ? 'text' : type
  const right = isPassword && !rightElement ? (
    <button
      type="button"
      onClick={() => setReveal((v) => !v)}
      className="text-text-muted hover:text-text-primary transition-colors"
      aria-label={reveal ? 'Hide password' : 'Show password'}
      tabIndex={-1}
    >
      {reveal ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
    </button>
  ) : rightElement

  return (
    <div className="flex flex-col gap-1.5 w-full">
      {label && (
        <label
          htmlFor={inputId}
          className="text-sm font-medium text-text-primary"
        >
          {label}
        </label>
      )}
      <div className="relative flex items-center">
        {leftIcon && (
          <span className="absolute left-3 flex items-center text-text-muted pointer-events-none">
            {leftIcon}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          type={effectiveType}
          disabled={disabled}
          className={cn(
            'w-full rounded-lg border bg-surface text-text-primary placeholder:text-text-muted',
            'text-base px-3 py-2.5',
            'transition-colors duration-150',
            'focus:outline-none focus:ring-2 focus:ring-offset-0',
            error
              ? 'border-danger focus:ring-danger/30'
              : 'border-border focus:ring-primary/30 focus:border-primary',
            leftIcon && 'pl-10',
            right && 'pr-10',
            disabled && 'opacity-50 cursor-not-allowed bg-surface',
            className,
          )}
          {...props}
        />
        {right && (
          <span className="absolute right-3 flex items-center">
            {right}
          </span>
        )}
      </div>
      {error && (
        <p className="text-sm text-danger">{error}</p>
      )}
      {hint && !error && (
        <p className="text-sm text-text-muted">{hint}</p>
      )}
    </div>
  )
})
Input.displayName = 'Input'
