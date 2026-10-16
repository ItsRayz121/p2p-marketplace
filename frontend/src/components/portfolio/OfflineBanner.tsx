'use client'

import type { QueuedEntry } from '@/lib/portfolio/offline/cache'
import { formatDecimal, formatQuantity } from '@/lib/portfolio/format'

interface Props {
  online: boolean
  /** When set, the numbers on screen are a saved copy from this time, not live. */
  cachedAt: string | null
  queue: QueuedEntry[]
  syncing: boolean
  onSync: () => void
  onRetryFailed: () => void
  onDiscard: (id: string) => void
}

const when = (iso: string) => new Date(iso).toLocaleString()

/** Honest status: offline, showing a saved copy (never "live"), and entries waiting to be sent. */
export function OfflineBanner({ online, cachedAt, queue, syncing, onSync, onRetryFailed, onDiscard }: Props) {
  const pending = queue.filter((q) => q.status === 'pending')
  const failed = queue.filter((q) => q.status === 'failed')
  if (online && !cachedAt && queue.length === 0) return null

  return (
    <section aria-label="Connection status" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 space-y-2 text-sm text-amber-900">
      {!online && (
        <p role="status">
          <strong>You are offline.</strong>{' '}
          {cachedAt
            ? `You are looking at a copy saved on this device on ${when(cachedAt)}. Prices and results are as of then, not live.`
            : 'You can still record entries; they are kept on this device and sent when you are back online. Prices and anything else need a connection.'}
        </p>
      )}
      {online && cachedAt && (
        <p role="status">
          Showing a copy saved on this device on {when(cachedAt)}. It could not be refreshed just now, so prices and results are as of then, not live.
        </p>
      )}

      {pending.length > 0 && (
        <div className="space-y-1">
          <p className="font-medium">
            {pending.length} {pending.length === 1 ? 'entry is' : 'entries are'} waiting to be sent{syncing ? ' (sending now…)' : ''}
          </p>
          <ul className="text-xs space-y-1">
            {pending.map((q) => (
              <li key={q.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="break-words">
                  {q.input.type === 'BUY' ? 'Buy' : q.input.type === 'SELL' ? 'Sell' : 'Opening holding'} {formatQuantity(q.input.quantity)} {q.assetName}
                  {q.input.consideration ? ` for ${formatDecimal(q.input.consideration)} ${q.input.quote ?? 'PKR'}` : ''}
                </span>
                <button type="button" onClick={() => onDiscard(q.id)} className="underline">Discard</button>
              </li>
            ))}
          </ul>
          {online && !syncing && <button type="button" onClick={onSync} className="font-medium underline">Send now</button>}
        </div>
      )}

      {failed.length > 0 && (
        <div className="space-y-1" role="alert">
          <p className="font-medium">{failed.length} {failed.length === 1 ? 'entry was' : 'entries were'} refused and not saved</p>
          <ul className="text-xs space-y-1">
            {failed.map((q) => (
              <li key={q.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="break-words">{q.assetName}: {q.error ?? 'Could not be saved'}</span>
                <button type="button" onClick={() => onDiscard(q.id)} className="underline">Discard</button>
              </li>
            ))}
          </ul>
          <button type="button" onClick={onRetryFailed} className="font-medium underline">Try again</button>
        </div>
      )}
    </section>
  )
}
