'use client'
import * as Dialog from '@radix-ui/react-dialog'
import { cn } from '@/lib/utils'

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  title?: string
  size?: 'sm' | 'md' | 'lg'
  children: React.ReactNode
}

const sizeClasses: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'md:max-w-sm',
  md: 'md:max-w-md',
  lg: 'md:max-w-lg',
}

export function Modal({ isOpen, onClose, title, size = 'md', children }: ModalProps) {
  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            'fixed inset-0 bg-black/50 backdrop-blur-sm z-40',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          )}
        />
        <Dialog.Content
          className={cn(
            'fixed z-50 bg-white shadow-xl',
            'focus:outline-none',
            // Mobile: bottom sheet
            'bottom-0 inset-x-0 rounded-t-2xl',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
            // Desktop: centered dialog
            'md:bottom-auto md:inset-x-auto md:left-1/2 md:top-1/2 md:-translate-x-1/2 md:-translate-y-1/2',
            'md:rounded-2xl md:w-full',
            sizeClasses[size],
            'duration-200',
          )}
        >
          <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-border">
            {title ? (
              <Dialog.Title className="text-lg font-semibold text-text-primary">
                {title}
              </Dialog.Title>
            ) : (
              <div />
            )}
            <Dialog.Close
              onClick={onClose}
              className={cn(
                'rounded-lg p-1.5 text-text-muted hover:text-text-primary hover:bg-surface',
                'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              )}
              aria-label="Close"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </Dialog.Close>
          </div>
          <div className="px-6 py-6">
            {children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
