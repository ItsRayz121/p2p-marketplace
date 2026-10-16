'use client'

import { useId, useState } from 'react'
import type { ExportData, RestoreSummary } from '@/lib/portfolio/exportFile'
import { loadBackup, readFileAsText } from '@/lib/portfolio/local/backupFile'

interface Props {
  restore: (data: ExportData) => Promise<RestoreSummary>
  onDone: () => void
  onClose: () => void
}

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * Put a backup file back into this account, as it was: tokens, entries, prices, the earlier versions
 * of corrected entries, and the link to RupChain trades. It only ever adds to your own portfolio and
 * skips whatever is already there, so running it twice (or on an account that still has the data)
 * changes nothing the second time. It never touches your wallet, orders or trades.
 */
export function RestoreBackupDialog({ restore, onDone, onClose }: Props) {
  const uid = useId()
  const [data, setData] = useState<ExportData | null>(null)
  const [pendingText, setPendingText] = useState<string | null>(null)
  const [pass, setPass] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RestoreSummary | null>(null)

  function accept(d: ExportData) { setData(d); setPendingText(null); setError(null); setResult(null) }

  async function choose(file: File | undefined) {
    setError(null); setData(null); setPendingText(null); setResult(null); setPass('')
    if (!file) return
    try {
      const text = await readFileAsText(file)
      const r = await loadBackup(text)
      if (r.status === 'ok') accept(r.data)
      else if (r.status === 'needs-passphrase') setPendingText(text)
      else setError(r.error)
    } catch { setError('Could not read that file.') }
  }

  async function unlock() {
    if (!pendingText) return
    setBusy(true)
    try {
      const r = await loadBackup(pendingText, pass)
      if (r.status === 'ok') accept(r.data)
      else setError(r.status === 'error' ? r.error : 'Enter the passphrase.')
    } finally { setBusy(false) }
  }

  async function run() {
    if (!data) return
    setBusy(true); setError(null)
    try {
      const r = await restore(data)
      setResult(r)
      if (r.assets.created + r.entries.restored + r.prices.restored + r.history.restored > 0) onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not restore the backup. Nothing was changed.')
    } finally { setBusy(false) }
  }

  const manual = data ? data.events.filter((e) => e.source === 'manual').length : 0

  return (
    <section aria-labelledby={`${uid}-h`} className="rounded-xl border border-border bg-surface p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <h3 id={`${uid}-h`} className="text-sm font-semibold text-text-primary">Restore from a backup file</h3>
        <button type="button" onClick={onClose} className="text-xs text-text-muted hover:underline">Close</button>
      </div>
      <p className="text-xs text-text-muted">
        Brings back the tokens, entries, prices and earlier versions of corrected entries from a backup you downloaded here. Anything already in your portfolio is skipped, never duplicated, so restoring twice is safe. This only changes your own portfolio records: not your wallet, orders or trades. Entries read from RupChain trades are rebuilt from the platform&apos;s own records instead.
      </p>

      <label htmlFor={`${uid}-f`} className="text-sm text-text-primary block">Choose a backup file (.json)</label>
      <input id={`${uid}-f`} type="file" accept=".json,application/json" onChange={(e) => void choose(e.target.files?.[0])} className="text-sm" />

      {pendingText && (
        <div className="space-y-2">
          <label htmlFor={`${uid}-p`} className="text-sm font-medium text-text-primary block">This backup is encrypted. Passphrase</label>
          <input id={`${uid}-p`} type="password" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm" />
          <button type="button" disabled={busy || !pass} onClick={unlock} className="px-3 py-2 text-sm font-semibold rounded-lg border border-border hover:bg-surface-hover disabled:opacity-60">Unlock backup</button>
        </div>
      )}

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}

      {data && !result && (
        <div className="space-y-2">
          <p className="text-sm text-text-primary">
            This backup has {n(data.assets.filter((a) => !a.linkedToRupChainToken).length, 'token', 'tokens')}, {n(manual, 'entry you typed', 'entries you typed')}, {n(data.prices.length, 'price', 'prices')}
            {data.revisions ? ` and ${n(data.revisions.length, 'earlier version', 'earlier versions')} of corrected entries` : ''}.
          </p>
          {!data.revisions && (
            <p className="text-xs text-text-muted">This backup does not include edit history, so only tokens, entries and prices come back.</p>
          )}
          <button type="button" disabled={busy} onClick={() => void run()} className="px-3 py-2 text-sm font-semibold rounded-lg bg-primary text-white disabled:opacity-60">
            {busy ? 'Restoring…' : 'Restore this backup'}
          </button>
        </div>
      )}

      {result && (
        <div role="status" className="space-y-1 text-sm text-text-primary">
          <p>
            Restored {n(result.assets.created, 'token', 'tokens')}, {n(result.entries.restored, 'entry', 'entries')}, {n(result.prices.restored, 'price', 'prices')} and {n(result.history.restored, 'earlier version', 'earlier versions')}.
            {result.entries.alreadyThere + result.assets.alreadyThere + result.prices.alreadyThere > 0 && ` Skipped what was already there: ${n(result.assets.alreadyThere, 'token', 'tokens')}, ${n(result.entries.alreadyThere, 'entry', 'entries')}, ${n(result.prices.alreadyThere, 'price', 'prices')}.`}
          </p>
          {result.notes.map((t) => <p key={t} className="text-xs text-text-muted">{t}</p>)}
        </div>
      )}
    </section>
  )
}
