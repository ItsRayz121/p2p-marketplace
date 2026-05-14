'use client'
import { useEffect } from 'react'
import { Button } from '@/components/ui/Button'

export default function AdminPageError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
      <div className="w-12 h-12 rounded-full bg-danger/10 flex items-center justify-center">
        <svg className="w-6 h-6 text-danger" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      </div>
      <div>
        <h2 className="text-lg font-semibold text-text-primary">Page error</h2>
        <p className="text-sm text-text-muted mt-1 max-w-sm">
          {error.message || 'Something went wrong loading this page.'}
        </p>
        {error.digest && (
          <p className="text-xs text-text-muted mt-1 font-mono">ref: {error.digest}</p>
        )}
      </div>
      <Button onClick={reset}>Try Again</Button>
    </div>
  )
}

