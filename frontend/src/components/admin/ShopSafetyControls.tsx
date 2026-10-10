'use client'
import { useCallback, useEffect, useState } from 'react'
import { apiRequest } from '@/lib/api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

type BoostState = { enabled: boolean; activeBoosts: number }

function Switch({ on, busy, onClick, label }: { on: boolean; busy: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={busy} onClick={onClick}
      className={cn('relative h-6 w-11 flex-shrink-0 rounded-full transition-colors disabled:opacity-50', on ? 'bg-success' : 'bg-border')}>
      <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', on ? 'left-[22px]' : 'left-0.5')} />
    </button>
  )
}

/** Master switch for Points-bought boosts, plus refunding running boosts. */
export function ShopSafetyControls() {
  const [boost, setBoost] = useState<BoostState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setBoost(await apiRequest<BoostState>('/admin/boost'))
    } catch (e) { toast.error('Could not load shop controls', e instanceof Error ? e.message : undefined) }
  }, [])
  useEffect(() => { void load() }, [load])

  async function flip(enabled: boolean) {
    setBusy('boost')
    try {
      await apiRequest('/admin/boost', { method: 'PUT', body: JSON.stringify({ enabled }) })
      toast.success(`Boosting ${enabled ? 'resumed' : 'paused'}`)
      await load()
    } catch (e) { toast.error('Update failed', e instanceof Error ? e.message : undefined) }
    finally { setBusy(null) }
  }

  async function refund() {
    if (!window.confirm(`End all ${boost?.activeBoosts ?? 0} running boosts and refund the unused Points to their owners? This cannot be undone.`)) return
    setBusy('refund')
    try {
      const r = await apiRequest<{ refunded: number; users: number; listings: number }>('/admin/boost/refund', { method: 'POST' })
      toast.success(`Ended ${r.listings} boost${r.listings === 1 ? '' : 's'} and refunded ${r.refunded.toLocaleString()} points to ${r.users} user${r.users === 1 ? '' : 's'}`)
      await load()
    } catch (e) { toast.error('Refund failed', e instanceof Error ? e.message : undefined) }
    finally { setBusy(null) }
  }

  if (!boost) return null

  return (
    <div>
      <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-text-primary">Listing boosts</h2>
            <p className="mt-0.5 text-xs text-text-secondary">When paused, nobody can buy a boost or be charged. Boosts already running keep going unless you refund them.</p>
          </div>
          <Switch on={boost.enabled} busy={busy === 'boost'} onClick={() => void flip(!boost.enabled)} label="Boosting enabled" />
        </div>
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <p className="text-xs text-text-muted">{boost.activeBoosts} running now</p>
          <button type="button" onClick={() => void refund()} disabled={busy === 'refund' || boost.activeBoosts === 0}
            className="rounded-lg border border-danger px-3 py-1.5 text-xs font-semibold text-danger hover:bg-danger/5 disabled:opacity-50">
            {busy === 'refund' ? 'Refunding…' : 'End all & refund unused'}
          </button>
        </div>
      </section>
    </div>
  )
}
