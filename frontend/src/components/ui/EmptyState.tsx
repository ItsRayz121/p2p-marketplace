import type { LucideIcon } from 'lucide-react'
import { Inbox } from 'lucide-react'
import Link from 'next/link'
import { Button } from './Button'

interface EmptyStateAction {
  label: string
  href?: string
  onClick?: () => void
}

interface EmptyStateProps {
  /** Lucide icon to display above the title. Defaults to Inbox. */
  icon?: LucideIcon
  title: string
  description?: string
  action?: EmptyStateAction
  className?: string
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center w-full gap-3 py-16 text-center px-4 ${className ?? ''}`}>
      <div className="w-14 h-14 rounded-2xl bg-surface-alt flex items-center justify-center">
        <Icon size={26} className="text-text-muted" aria-hidden />
      </div>
      <div className="flex flex-col gap-1 max-w-xs">
        <p className="font-semibold text-text-secondary">{title}</p>
        {description && (
          <p className="text-sm text-text-muted">{description}</p>
        )}
      </div>
      {action && (
        action.href ? (
          <Link href={action.href}>
            <Button variant="secondary" size="sm">{action.label}</Button>
          </Link>
        ) : (
          <Button variant="secondary" size="sm" onClick={action.onClick}>{action.label}</Button>
        )
      )}
    </div>
  )
}
