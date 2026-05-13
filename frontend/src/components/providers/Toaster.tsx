'use client'
import * as ToastPrimitive from '@radix-ui/react-toast'
import { cn } from '@/lib/utils'

export default function Toaster() {
  return (
    <ToastPrimitive.Viewport
      className={cn(
        'fixed z-50 flex flex-col gap-2 p-4',
        'bottom-0 left-0 right-0 items-center',
        'sm:left-auto sm:right-4 sm:bottom-4 sm:items-end',
        'max-w-full sm:max-w-sm w-full sm:w-auto',
        'list-none outline-none',
      )}
    />
  )
}
