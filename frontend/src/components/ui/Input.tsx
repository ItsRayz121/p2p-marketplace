'use client'
import { forwardRef } from 'react'
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
  ...props
}, ref) => {
  const inputId = id ?? (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined)

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
          disabled={disabled}
          className={cn(
            'w-full rounded-lg border bg-white text-text-primary placeholder:text-text-muted',
            'text-base px-3 py-2.5',
            'transition-colors duration-150',
            'focus:outline-none focus:ring-2 focus:ring-offset-0',
            error
              ? 'border-danger focus:ring-danger/30'
              : 'border-border focus:ring-primary/30 focus:border-primary',
            leftIcon && 'pl-10',
            rightElement && 'pr-10',
            disabled && 'opacity-50 cursor-not-allowed bg-surface',
            className,
          )}
          {...props}
        />
        {rightElement && (
          <span className="absolute right-3 flex items-center">
            {rightElement}
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
