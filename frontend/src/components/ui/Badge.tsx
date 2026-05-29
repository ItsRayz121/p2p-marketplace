import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export type BadgeVariant = 'default' | 'success' | 'warning' | 'info' | 'danger' | 'gold' | 'outline'
type BadgeSize = 'sm' | 'md'

interface BadgeProps {
  variant?: BadgeVariant
  size?: BadgeSize
  /** Lucide icon rendered before the label at 12px */
  icon?: LucideIcon
  /** Renders a colored dot before the label instead of an icon */
  dot?: boolean
  children: React.ReactNode
  className?: string
}

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-surface-alt text-text-secondary',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  info:    'bg-info/10 text-info',
  danger:  'bg-danger/10 text-danger',
  gold:    'bg-gold/10 text-gold',
  outline: 'border border-border text-text-secondary bg-transparent',
}

const dotClasses: Record<BadgeVariant, string> = {
  default: 'bg-text-muted',
  success: 'bg-success',
  warning: 'bg-warning',
  info:    'bg-info',
  danger:  'bg-danger',
  gold:    'bg-gold',
  outline: 'bg-text-muted',
}

const sizeClasses: Record<BadgeSize, string> = {
  sm: 'px-2 py-0.5 text-xs gap-1',
  md: 'px-2.5 py-1 text-sm gap-1.5',
}

const iconSizeClasses: Record<BadgeSize, number> = {
  sm: 11,
  md: 13,
}

export function Badge({
  variant = 'default',
  size = 'md',
  icon: Icon,
  dot,
  children,
  className,
}: BadgeProps) {
  const iconPx = iconSizeClasses[size]

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full font-medium',
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
    >
      {dot && !Icon && (
        <span className={cn('rounded-full flex-shrink-0', dotClasses[variant])}
          style={{ width: 6, height: 6 }}
        />
      )}
      {Icon && !dot && (
        <Icon size={iconPx} className="flex-shrink-0" aria-hidden />
      )}
      {children}
    </span>
  )
}
