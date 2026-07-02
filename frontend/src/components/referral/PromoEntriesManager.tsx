'use client'
import { useState, useEffect, useCallback } from 'react'
import { useFileUpload } from '@/hooks/useFileUpload'
import { toast } from '@/lib/toast'
import { fmtDateTime } from '@/lib/fmt'
import { Button } from '@/components/ui/Button'
import {
  promoGiveawayApi,
  entriesToCsv,
  downloadCsv,
  PROMO_ENTRY_STATUSES,
  type PromoGiveaway,
  type PromoEntry,
  type PromoEntryStatus,
} from '@/lib/promoGiveaway'
import { Download, ImageUp, X } from 'lucide-react'

// Shared entry-fulfillment manager used by both the affiliate panel and the
// admin oversight page: mark each entrant Sent / Pending / Rejected (with a
// required reason), upload a public proof sheet, and export the entrant CSV.
export function PromoEntriesManager({ giveaway, onChanged }: { giveaway: PromoGiveaway; onChanged?: () => void }) {
  const [entries, setEntries] = useState<PromoEntry[] | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [proofUrl, setProofUrl] = useState(giveaway.resultsSheetUrl ?? '')
  const { upload, uploading } = useFileUpload('giveaway-image')

  const load = useCallback(async () => {
    try {
      setEntries(await promoGiveawayApi.entries(giveaway.id))
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to load entries')
    }
  }, [giveaway.id])

  useEffect(() => { void load() }, [load])

  async function setStatus(entry: PromoEntry, status: PromoEntryStatus) {
    let note: string | undefined
    if (status === 'rejected') {
      const reason = window.prompt('Reason for rejecting (shown to the entrant):', entry.note ?? '')
      if (!reason || !reason.trim()) { toast.error('A reason is required to reject.'); return }
      note = reason.trim()
    }
    setSavingId(entry.id)
    try {
      await promoGiveawayApi.updateEntry(giveaway.id, entry.id, { status, ...(note ? { note } : {}) })
      setEntries((prev) => prev?.map((x) => (x.id === entry.id ? { ...x, status, note: status === 'rejected' ? note ?? null : null } : x)) ?? null)
      onChanged?.()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Update failed')
    } finally {
      setSavingId(null)
    }
  }

  async function onProof(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0]
    if (!file) return
    try {
      const url = await upload(file)
      await promoGiveawayApi.setResults(giveaway.id, url)
      setProofUrl(url)
      toast.success('Proof sheet published')
      onChanged?.()
    } catch { /* upload hook surfaces error */ }
  }

  async function removeProof() {
    try {
      await promoGiveawayApi.setResults(giveaway.id, null)
      setProofUrl('')
      toast.success('Proof sheet removed')
      onChanged?.()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to remove')
    }
  }

  function exportCsv() {
    if (!entries || entries.length === 0) { toast.error('No entries yet.'); return }
    downloadCsv(`giveaway-${giveaway.code}-entries.csv`, entriesToCsv(entries))
  }

  return (
    <div className="space-y-3">
      {/* Proof sheet + export toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border border-border rounded-lg cursor-pointer hover:bg-surface">
          <ImageUp size={13} /> {uploading ? 'Uploading…' : proofUrl ? 'Replace proof sheet' : 'Upload proof sheet'}
          <input type="file" accept="image/*" onChange={onProof} className="hidden" disabled={uploading} />
        </label>
        {proofUrl && (
          <button onClick={removeProof} className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-danger">
            <X size={13} /> Remove proof
          </button>
        )}
        <Button size="sm" variant="secondary" onClick={exportCsv} className="inline-flex items-center gap-1 ml-auto"><Download size={13} /> Export CSV</Button>
      </div>

      {!entries ? (
        <p className="text-xs text-text-muted">Loading entries…</p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-text-muted">No entries yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-text-muted border-b border-border">
              <tr>
                <th className="text-left py-1.5 pr-3">User</th>
                <th className="text-left py-1.5 pr-3">Address</th>
                <th className="text-left py-1.5 pr-3">Status</th>
                <th className="text-left py-1.5">Entered</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="py-1.5 pr-3 text-text-primary align-top">{e.username ?? '—'}</td>
                  <td className="py-1.5 pr-3 font-mono text-text-secondary break-all align-top">{e.receivingAddress}</td>
                  <td className="py-1.5 pr-3 align-top">
                    <select
                      value={e.status}
                      disabled={savingId === e.id}
                      onChange={(ev) => setStatus(e, ev.target.value as PromoEntryStatus)}
                      className="px-2 py-1 border border-border rounded bg-canvas text-text-primary"
                    >
                      {PROMO_ENTRY_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                    {e.status === 'rejected' && e.note && <p className="text-[10px] text-danger mt-0.5 max-w-[10rem]">{e.note}</p>}
                  </td>
                  <td className="py-1.5 text-text-muted whitespace-nowrap align-top">{fmtDateTime(e.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
