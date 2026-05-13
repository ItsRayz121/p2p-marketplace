'use client'
import { forwardRef } from 'react'
import { cn } from '@/lib/utils'
import { Spinner } from './Spinner'

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'link'
type ButtonSize = 'sm' | 'md' | 'lg'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  fullWidth?: boolean
}

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-white hover:bg-primary-hover active:scale-[0.98]',
  secondary: 'bg-white text-text-primary border border-border hover:bg-surface-alt',
  danger: 'bg-danger text-white hover:bg-danger-hover active:scale-[0.98]',
  ghost: 'text-text-secondary hover:bg-surface-alt hover:text-text-primary',
  link: 'text-primary hover:underline p-0 h-auto',
}

const sizes: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-sm rounded-md min-h-[36px]',
  md: 'px-4 py-2 text-sm rounded-lg min-h-[40px]',
  lg: 'px-6 py-3 text-base rounded-lg min-h-[48px]',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({
  variant = 'primary', size = 'md', loading = false, fullWidth = false,
  disabled, children, className, ...props
}, ref) => (
  <button
    ref={ref}
    disabled={disabled || loading}
    className={cn(
      'inline-flex items-center justify-center gap-2 font-medium transition-all',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2',
      'disabled:pointer-events-none disabled:opacity-50',
      variants[variant], sizes[size],
      fullWidth && 'w-full',
      className,
    )}
    {...props}
  >
    {loading && <Spinner size="sm" />}
    {children}
  </button>
))
Button.displayName = 'Button'
