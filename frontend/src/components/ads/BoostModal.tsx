'use client'
import { useState, useEffect } from 'react'
import { adsApi, ctmApi, pointsShopApi } from '@/lib/api'
import type { AdBoostPlan } from '@/lib/api'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { toast } from '@/lib/toast'

/** Spend Points to boost a USDT ad (`kind="ad"`) or a Community Token listing (`kind="ctm"`). */
export function BoostModal({ kind = 'ad', id, boostedUntil, onClose, onDone }: {
  kind?: 'ad' | 'ctm'
  id: string
  boostedUntil?: string | null
  onClose: () => void
  onDone: () => void
}) {
  const [plans, setPlans] = useState<AdBoostPlan[] | null>(null)
  const [balance, setBalance] = useState<number | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let off = false
    adsApi.getBoostPlans().then((p) => { if (!off) setPlans(p) }).catch(() => { if (!off) setPlans([]) })
    adsApi.getBoostStatus().then((s) => { if (!off) setEnabled(s.enabled) }).catch(() => { /* server still enforces it */ })
    pointsShopApi.get().then((s) => { if (!off) setBalance(s.balance) }).catch(() => { if (!off) setBalance(null) })
    return () => { off = true }
  }, [])

  const running = boostedUntil && new Date(boostedUntil) > new Date() ? new Date(boostedUntil) : null
  const noun = kind === 'ctm' ? 'listing' : 'ad'

  async function pick(p: AdBoostPlan) {
    setBusy(p.key)
    try {
      const r = kind === 'ctm' ? await ctmApi.boostListing(id, p.key) : await adsApi.boostAd(id, p.key)
      toast.success(`Boosted until ${new Date(r.boostedUntil).toLocaleString()}`)
      onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Could not boost this ${noun}`)
    } finally { setBusy(null) }
  }

  return (
    <Modal isOpen onClose={onClose} title="Boost this listing" size="md">
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          A boosted {noun} is listed above regular {noun}s and marked <strong>Featured</strong> for the time you choose. It is paid with RupChain Points and does not change your price, terms or trader rank.
        </p>
        {running && <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-700 dark:text-amber-300">Currently boosted until {running.toLocaleString()}. A new boost adds time on top.</p>}
        {balance !== null && <p className="text-xs text-text-muted">Your balance: <strong className="text-text-primary">{balance.toLocaleString()} points</strong></p>}
        {!enabled ? (
          <p className="rounded-lg bg-surface-alt px-3 py-2 text-sm text-text-secondary">Boosting is paused for now. Nothing will be charged, and any boost already running is unaffected.</p>
        ) : plans === null ? <Spinner size="sm" /> : plans.length === 0 ? (
          <p className="text-sm text-text-muted">Boosting is not available right now.</p>
        ) : (
          <div className="grid gap-2">
            {plans.map((p) => {
              const short = balance !== null && balance < p.cost
              return (
                <button key={p.key} type="button" onClick={() => pick(p)} disabled={!!busy || short}
                  className="flex items-center justify-between rounded-xl border border-border bg-surface px-4 py-3 text-left hover:bg-surface-alt disabled:opacity-50">
                  <span className="text-sm font-semibold text-text-primary">{p.label}</span>
                  <span className="text-sm font-black tabular-nums text-primary">{busy === p.key ? 'Boosting…' : short ? `${p.cost} pts · not enough` : `${p.cost} pts`}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </Modal>
  )
}
