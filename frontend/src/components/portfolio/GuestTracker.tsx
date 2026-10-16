'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { openStore } from '@/lib/portfolio/local/idb'
import { createLocalTracker, type LocalTracker } from '@/lib/portfolio/local/localApi'
import { PortfolioPanel } from './PortfolioPanel'
import { GuestBackupTools } from './GuestBackupTools'

export const GUEST_DB = 'rupchain-portfolio-guest'

/**
 * Try the tracker without an account. Everything stays in this browser: no sign-in, no uploads, no
 * analytics about what you record. It is kept apart from any account's data; moving it to an
 * account is a deliberate step using a backup file.
 */
export function GuestTracker() {
  const [tracker, setTracker] = useState<LocalTracker | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const [rate, setRate] = useState('')
  const [rateMsg, setRateMsg] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    openStore(GUEST_DB)
      .then(createLocalTracker)
      .then((t) => { if (alive) { setTracker(t); setRate(t.getUsdtPkr() ?? '') } })
      .catch(() => { if (alive) setLoadError('Could not open the local storage of this browser.') })
    return () => { alive = false }
  }, [])

  if (loadError) return <p role="alert" className="text-sm text-danger">{loadError}</p>
  if (!tracker) return <p role="status" className="text-sm text-text-muted">Opening your local tracker…</p>

  const saveRate = async () => {
    setRateMsg(null)
    try {
      await tracker.setUsdtPkr(rate.trim() === '' ? null : rate.trim())
      setRateMsg(rate.trim() === '' ? 'Rate cleared.' : 'Rate saved on this device.')
      setVersion((v) => v + 1) // reload the numbers that depend on it
    } catch (e) {
      setRateMsg(e instanceof Error ? e.message : 'Could not save the rate.')
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold text-text-primary">Local portfolio tracker</h1>
        <p role="note" className="rounded-xl border border-border bg-surface p-4 text-sm text-text-secondary">
          No account needed. Everything you record here stays in this browser: nothing is uploaded, and nothing about it is sent to RupChain. It is an estimate based only on what you type in, not verified ownership.
        </p>
        {!tracker.persistent && (
          <p role="alert" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800">
            This browser is blocking storage, so what you enter will disappear when you close this tab. Download a backup before you leave.
          </p>
        )}
        {tracker.recovered && (
          <p role="alert" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800">
            The data saved on this device could not be read, so it was set aside and you are starting with an empty tracker. If you have a backup file you can restore it below.
          </p>
        )}
      </div>

      <section aria-labelledby="guest-rate-h" className="rounded-xl border border-border bg-surface p-4 space-y-2">
        <h2 id="guest-rate-h" className="text-sm font-semibold text-text-primary">Current USDT/PKR rate (optional)</h2>
        <p className="text-xs text-text-muted">
          Used only to show prices you enter in the other currency, and stored on this device. You type it in; nothing is looked up. Entries dated today use it automatically; for older entries, type the rate for their date when you record them.
        </p>
        <div className="flex flex-wrap gap-2 items-center">
          <label htmlFor="guest-rate" className="sr-only">Current USDT/PKR rate</label>
          <input
            id="guest-rate" inputMode="decimal" autoComplete="off" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="for example 280.5"
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"
          />
          <button type="button" onClick={() => void saveRate()} className="px-3 py-2 text-sm font-semibold rounded-lg border border-border text-text-primary hover:bg-surface-hover">Save rate</button>
        </div>
        {rateMsg && <p role="status" className="text-xs text-text-muted">{rateMsg}</p>}
      </section>

      <PortfolioPanel key={version} api={tracker.api} />

      <GuestBackupTools
        backupText={tracker.backupText}
        counts={tracker.counts}
        onRestore={async (data) => { await tracker.replaceAll(data); setVersion((v) => v + 1) }}
        onClear={async () => { await tracker.clearAll(); setVersion((v) => v + 1) }}
      />

      <p className="text-sm text-text-muted">
        Want to keep your records with an account? <Link href="/register" className="text-primary hover:underline">Create one</Link> or <Link href="/login" className="text-primary hover:underline">sign in</Link>, then use <strong>Import from a backup file</strong> on the Portfolio tab. Your local data is never uploaded unless you choose to import it.
      </p>
    </div>
  )
}
