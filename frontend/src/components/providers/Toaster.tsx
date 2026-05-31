'use client'
import * as ToastPrimitive from '@radix-ui/react-toast'
import { cn } from '@/lib/utils'
import { useToastStore, type ToastVariant } from '@/lib/toast'
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react'

const ICON: Record<ToastVariant, React.ReactNode> = {
  success: <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0" />,
  error:   <XCircle     className="w-4 h-4 text-danger  flex-shrink-0" />,
  warning: <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0" />,
  default: <Info        className="w-4 h-4 text-primary  flex-shrink-0" />,
}

const BORDER: Record<ToastVariant, string> = {
  success: 'border-success/20 bg-success/5',
  error:   'border-danger/20  bg-danger/5',
  warning: 'border-warning/20 bg-warning/5',
  default: 'border-border     bg-surface',
}

export default function Toaster() {
  const { toasts, remove } = useToastStore()

  return (
    <>
      {toasts.map((t) => (
        <ToastPrimitive.Root
          key={t.id}
          open
          duration={t.duration}
          onOpenChange={(open) => { if (!open) remove(t.id) }}
          className={cn(
            'flex items-start gap-3 rounded-xl border px-4 py-3 shadow-card-md',
            'data-[state=open]:animate-slide-up data-[state=closed]:animate-fade-out',
            'max-w-sm w-full',
            BORDER[t.variant],
          )}
        >
          {ICON[t.variant]}
          <div className="flex-1 min-w-0">
            <ToastPrimitive.Title className="text-sm font-semibold text-text-primary">
              {t.title}
            </ToastPrimitive.Title>
            {t.description && (
              <ToastPrimitive.Description className="text-xs text-text-muted mt-0.5">
                {t.description}
              </ToastPrimitive.Description>
            )}
          </div>
          <ToastPrimitive.Close
            onClick={() => remove(t.id)}
            className="text-text-muted hover:text-text-primary transition-colors flex-shrink-0 mt-0.5"
            aria-label="Dismiss notification"
          >
            <X className="w-4 h-4" />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport
        className={cn(
          'fixed z-50 flex flex-col gap-2 p-4',
          'bottom-0 left-0 right-0 items-center',
          'sm:left-auto sm:right-4 sm:bottom-4 sm:items-end',
          'max-w-full sm:max-w-sm w-full sm:w-auto',
          'list-none outline-none',
        )}
      />
    </>
  )
}
