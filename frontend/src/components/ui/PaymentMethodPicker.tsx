'use client'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { PAYMENT_METHOD_GROUPS, PK_MOBILE_METHODS } from '@/lib/pkPaymentMethods'
import { EntityLogo } from '@/components/ui/EntityLogo'

interface PaymentMethodPickerProps {
  selected: string[]
  onChange: (methods: string[]) => void
  className?: string
}

export function PaymentMethodPicker({ selected, onChange, className }: PaymentMethodPickerProps) {
  // Banks group starts collapsed (14 methods); wallets start open
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(['Commercial Banks']))

  function toggle(method: string) {
    onChange(
      selected.includes(method)
        ? selected.filter((m) => m !== method)
        : [...selected, method],
    )
  }

  function toggleGroup(label: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

  return (
    <div className={cn('space-y-3', className)}>
      {PAYMENT_METHOD_GROUPS.map((group) => {
        const isCollapsed = collapsed.has(group.label)
        const groupSelected = group.methods.filter((m) => selected.includes(m))
        const hasSelection = groupSelected.length > 0

        return (
          <div key={group.label} className="border border-border rounded-xl overflow-hidden">
            {/* Group header */}
            <button
              type="button"
              onClick={() => toggleGroup(group.label)}
              className={cn(
                'w-full flex items-center justify-between px-4 py-2.5 text-left transition-colors',
                hasSelection ? 'bg-primary/5' : 'bg-surface hover:bg-surface/80',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-text-primary">{group.label}</span>
                {hasSelection && (
                  <span className="text-xs font-medium bg-primary text-white px-1.5 py-0.5 rounded-full">
                    {groupSelected.length}
                  </span>
                )}
              </div>
              <svg
                className={cn('w-4 h-4 text-text-muted transition-transform', isCollapsed ? '-rotate-90' : '')}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {/* Methods */}
            {!isCollapsed && (
              <div className="px-4 py-3 flex flex-wrap gap-2 border-t border-border bg-white">
                {group.methods.map((m) => {
                  const isMobile = PK_MOBILE_METHODS.includes(m)
                  return (
                    <button
                      type="button"
                      key={m}
                      onClick={() => toggle(m)}
                      className={cn(
                        'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors',
                        selected.includes(m)
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border bg-white text-text-primary hover:bg-surface',
                      )}
                    >
                      <EntityLogo
                        type={isMobile ? 'payment_method' : 'bank'}
                        slug={m}
                        size="xs"
                        className="flex-shrink-0"
                      />
                      {m}
                    </button>
                  )
                })}
              </div>
            )}

            {/* Collapsed summary */}
            {isCollapsed && hasSelection && (
              <div className="px-4 py-2 border-t border-border bg-white">
                <p className="text-xs text-text-muted">
                  Selected: <span className="text-primary font-medium">{groupSelected.join(', ')}</span>
                </p>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
