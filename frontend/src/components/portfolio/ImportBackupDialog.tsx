'use client'

import { useId, useMemo, useRef, useState } from 'react'
import type { PortfolioApiLike } from '@/lib/portfolio/apiTypes'
import type { ExportData, ExportEvent } from '@/lib/portfolio/exportFile'
import { loadBackup, readFileAsText } from '@/lib/portfolio/local/backupFile'
import type { PortfolioAsset, PortfolioEvent } from '@/lib/portfolio/types'
import { formatDecimal, formatQuantity } from '@/lib/portfolio/format'

type Api = Pick<PortfolioApiLike, 'addAsset' | 'addEvent' | 'listEvents'>

interface Props {
  api: Api
  existing: PortfolioAsset[]
  onDone: () => void
  onClose: () => void
}

interface Row {
  assetId: string
  name: string
  symbol: string | null
  entries: ExportEvent[]
  skipped: number
  /** An account token with the same name, offered as a hint only (never merged automatically). */
  similar: PortfolioAsset | null
}

const NEW = 'new'
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
const dayKey = (iso: string) => iso.slice(0, 10)
const sameEntry = (a: ExportEvent | PortfolioEvent, b: ExportEvent | PortfolioEvent) =>
  a.type === b.type && dayKey(a.occurredAt) === dayKey(b.occurredAt) && a.quantity.replace(/\.?0+$/, '') === b.quantity.replace(/\.?0+$/, '') &&
  (a.consideration ?? '') === (b.consideration ?? '') && a.quote === b.quote

/** A request id that is stable for a given backup entry, so importing the same file twice records nothing twice. */
export const migrationRequestId = (eventId: string) => {
  const core = eventId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 56)
  return `mig-${core.length >= 4 ? core : `x${core}0000`}`
}

/**
 * Move records from a backup file (for example the local-only tracker's) into this account.
 * Explicit by design: you choose which tokens, each becomes a NEW token unless you pick an existing
 * one yourself, and entries that look identical to ones you already have are skipped unless you say
 * otherwise. Only your own typed entries are brought over; trades read from RupChain are re-created
 * from the platform's own records, and prices must be entered again.
 */
export function ImportBackupDialog({ api, existing, onDone, onClose }: Props) {
  const uid = useId()
  const [data, setData] = useState<ExportData | null>(null)
  const [pendingText, setPendingText] = useState<string | null>(null)
  const [pass, setPass] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [target, setTarget] = useState<Record<string, string>>({})
  const [includeDupes, setIncludeDupes] = useState<Record<string, boolean>>({})
  const [dupes, setDupes] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ imported: number; skipped: number; failed: number; firstError: string | null } | null>(null)
  const created = useRef<Record<string, string>>({}) // backup token id -> account token id, so a retry never creates it twice

  const rows: Row[] = useMemo(() => {
    if (!data) return []
    return data.assets.filter((a) => !a.linkedToRupChainToken).map((a) => {
      const mine = data.events.filter((e) => e.assetId === a.id)
      const entries = mine.filter((e) => e.source === 'manual' && !e.voided)
      return {
        assetId: a.id, name: a.name, symbol: a.symbol, entries, skipped: mine.length - entries.length,
        similar: existing.find((x) => norm(x.name) === norm(a.name)) ?? null,
      }
    })
  }, [data, existing])

  function accept(d: ExportData) {
    setData(d); setPendingText(null); setError(null); setResult(null)
    setSelected(Object.fromEntries(d.assets.filter((a) => !a.linkedToRupChainToken).map((a) => [a.id, true])))
    setTarget({}); setIncludeDupes({}); setDupes({})
  }

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

  // When a backup token is pointed at an existing account token, count entries that look identical.
  async function pickTarget(row: Row, value: string) {
    setTarget((t) => ({ ...t, [row.assetId]: value }))
    setIncludeDupes((d) => ({ ...d, [row.assetId]: false }))
    if (value === NEW) { setDupes((d) => ({ ...d, [row.assetId]: 0 })); return }
    try {
      const have = await api.listEvents(value)
      setDupes((d) => ({ ...d, [row.assetId]: row.entries.filter((e) => have.some((h) => !h.voided && sameEntry(h, e))).length }))
    } catch { setDupes((d) => ({ ...d, [row.assetId]: 0 })) }
  }

  async function run() {
    if (!data) return
    setBusy(true); setError(null)
    let imported = 0, skipped = 0, failed = 0
    let firstError: string | null = null
    try {
      for (const row of rows) {
        if (!selected[row.assetId]) continue
        const dest = target[row.assetId] ?? NEW
        let assetId = dest === NEW ? created.current[row.assetId] : dest
        if (!assetId) {
          const src = data.assets.find((a) => a.id === row.assetId)!
          try {
            const a = await api.addAsset({ name: src.name, symbol: src.symbol, sourceUrl: src.sourceUrl, network: src.network, contractAddress: src.contractAddress })
            assetId = a.id
            created.current[row.assetId] = a.id
          } catch (e) {
            failed += row.entries.length
            firstError ??= e instanceof Error ? e.message : 'Could not create a token'
            continue
          }
        }
        const have: PortfolioEvent[] = dest === NEW ? [] : await api.listEvents(assetId).catch(() => [])
        for (const e of row.entries) {
          if (dest !== NEW && !includeDupes[row.assetId] && have.some((h) => !h.voided && sameEntry(h, e))) { skipped += 1; continue }
          try {
            await api.addEvent(assetId, {
              type: e.type, occurredAt: e.occurredAt, quantity: e.quantity, quote: e.quote, clientRequestId: migrationRequestId(e.id),
              ...(e.consideration !== null ? { consideration: e.consideration } : {}),
              ...(e.fee !== null ? { fee: e.fee } : {}),
              ...(e.type === 'OPENING' && e.basis !== null ? { basis: e.basis } : {}),
              ...(e.type === 'OPENING' && e.zeroCost ? { zeroCost: true } : {}),
              ...(e.fxRate !== null ? { fxRate: e.fxRate } : {}),
              ...(e.note ? { note: e.note } : {}),
            })
            imported += 1
          } catch (err) {
            failed += 1
            firstError ??= err instanceof Error ? err.message : 'Could not save an entry'
          }
        }
      }
      setResult({ imported, skipped, failed, firstError })
      if (imported > 0) onDone()
    } finally { setBusy(false) }
  }

  const chosen = rows.filter((r) => selected[r.assetId])
  const totalEntries = chosen.reduce((n, r) => n + r.entries.length, 0)

  return (
    <section aria-labelledby={`${uid}-h`} className="rounded-xl border border-border bg-surface p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <h3 id={`${uid}-h`} className="text-sm font-semibold text-text-primary">Import from a backup file</h3>
        <button type="button" onClick={onClose} className="text-xs text-text-muted hover:underline">Close</button>
      </div>
      <p className="text-xs text-text-muted">
        For example the backup from the local-only tracker. You choose what to bring over. Each token is added as a new token unless you pick one you already have, and nothing is merged automatically. Prices are not imported; enter them again. Entries read from RupChain trades are skipped because they are re-created from the platform&apos;s own records.
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
        rows.length === 0 ? (
          <p className="text-sm text-text-muted">This backup has no tokens to import.</p>
        ) : (
          <div className="space-y-3">
            <ul className="divide-y divide-border rounded-lg border border-border">
              {rows.map((r) => (
                <li key={r.assetId} className="p-3 space-y-2">
                  <label className="flex items-start gap-2 text-sm text-text-primary">
                    <input type="checkbox" checked={Boolean(selected[r.assetId])} onChange={(e) => setSelected((s) => ({ ...s, [r.assetId]: e.target.checked }))} className="mt-1" />
                    <span className="min-w-0">
                      <span className="break-words font-medium">{r.name}</span>{r.symbol && <span className="text-text-muted"> · {r.symbol}</span>}
                      <span className="block text-xs text-text-muted">
                        {r.entries.length} {r.entries.length === 1 ? 'entry' : 'entries'}
                        {r.entries[0] && ` · first: ${r.entries[0].type.toLowerCase()} ${formatQuantity(r.entries[0].quantity)}${r.entries[0].consideration ? ` for ${formatDecimal(r.entries[0].consideration)} ${r.entries[0].quote}` : ''}`}
                        {r.skipped > 0 && ` · ${r.skipped} not imported (from RupChain trades or not counted)`}
                      </span>
                    </span>
                  </label>
                  {selected[r.assetId] && (
                    <div className="pl-6 space-y-1">
                      {r.similar && (
                        <p role="note" className="text-xs text-amber-800">You already track a token called &ldquo;{r.similar.name}&rdquo;. It will not be merged unless you choose it below.</p>
                      )}
                      <label className="text-xs text-text-secondary block" htmlFor={`${uid}-t-${r.assetId}`}>Add these entries to</label>
                      <select
                        id={`${uid}-t-${r.assetId}`} value={target[r.assetId] ?? NEW} onChange={(e) => void pickTarget(r, e.target.value)}
                        className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm"
                      >
                        <option value={NEW}>A new token</option>
                        {existing.filter((x) => !x.archivedAt).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </select>
                      {(dupes[r.assetId] ?? 0) > 0 && (
                        <label className="flex items-center gap-2 text-xs text-text-secondary">
                          <input type="checkbox" checked={Boolean(includeDupes[r.assetId])} onChange={(e) => setIncludeDupes((d) => ({ ...d, [r.assetId]: e.target.checked }))} />
                          {dupes[r.assetId]} {dupes[r.assetId] === 1 ? 'entry looks' : 'entries look'} identical to ones you already have (same type, day, quantity and amount). Skipped unless you tick this.
                        </label>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <button type="button" disabled={busy || chosen.length === 0} onClick={() => void run()} className="px-3 py-2 text-sm font-semibold rounded-lg bg-primary text-white disabled:opacity-60">
              {busy ? 'Importing…' : `Import ${chosen.length} ${chosen.length === 1 ? 'token' : 'tokens'} (${totalEntries} ${totalEntries === 1 ? 'entry' : 'entries'})`}
            </button>
          </div>
        )
      )}

      {result && (
        <div role="status" className="space-y-1 text-sm text-text-primary">
          <p>Imported {result.imported} {result.imported === 1 ? 'entry' : 'entries'}{result.skipped > 0 ? `, skipped ${result.skipped} that looked identical` : ''}{result.failed > 0 ? `, ${result.failed} could not be imported` : ''}.</p>
          {result.firstError && <p role="alert" className="text-danger">{result.firstError}</p>}
          {result.failed > 0 && <button type="button" onClick={() => void run()} disabled={busy} className="text-primary hover:underline">Try the failed ones again</button>}
        </div>
      )}
    </section>
  )
}
