'use client'
import { useEffect, useState } from 'react'
import { makerApi, type MakerStatusView } from '@/lib/makerApi'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { MakerChecklist } from '@/components/maker/MakerChecklist'

export default function MakerPage() {
  const [status, setStatus] = useState<MakerStatusView | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    makerApi.getStatus().then(setStatus).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
  }, [])

  if (error) return <ErrorState title={error} onRetry={() => location.reload()} />
  if (!status) return <LoadingState message="Loading..." />

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      {!status.gateEnabled && (
        <p className="mb-4 text-sm text-text-muted bg-surface-alt border border-border rounded-lg p-3">
          Maker approval is not required right now — you can post ads as usual.
        </p>
      )}
      <MakerChecklist status={status} onChange={setStatus} />
    </div>
  )
}
