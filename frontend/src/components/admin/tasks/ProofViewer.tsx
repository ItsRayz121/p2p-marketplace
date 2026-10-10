'use client'
import { useState } from 'react'
import { ExternalLink, FileWarning, Minus, Plus, Scan } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import type { RevisionView } from '@/lib/platformTasks'

type Att = RevisionView['attachments'][number]

const kb = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const IMAGE = /^image\/(jpeg|png|webp)$/

function Unavailable({ a }: { a: Att }) {
  return (
    <div className="flex h-full min-h-[96px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border bg-surface-alt p-2 text-center">
      <FileWarning className="h-5 w-5 text-text-muted" aria-hidden />
      <p className="text-[11px] font-medium text-text-secondary">File unavailable</p>
      <p className="text-[10px] leading-tight text-text-muted">It may have been deleted, expired, or is not a supported image.</p>
      <p className="max-w-full truncate text-[10px] text-text-muted">{a.name}</p>
    </div>
  )
}

/** Real proof viewer: thumbnails, large preview with zoom, full-size link. Never renders arbitrary HTML. */
export function ProofViewer({ attachments }: { attachments: Att[] }) {
  const [open, setOpen] = useState<number | null>(null)
  const [zoom, setZoom] = useState(1)
  const [broken, setBroken] = useState<Set<string>>(new Set())
  const markBroken = (key: string) => setBroken((s) => new Set(s).add(key))

  if (attachments.length === 0) return <p className="text-xs text-text-muted">No files attached.</p>
  const cur = open != null ? attachments[open] : null

  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {attachments.map((a, i) => {
          const key = `${i}:${a.name}`
          const ok = !!a.viewUrl && IMAGE.test(a.mime) && !broken.has(key)
          return ok ? (
            <button key={key} type="button" onClick={() => { setOpen(i); setZoom(1) }} className="group relative overflow-hidden rounded-lg border border-border bg-surface-alt focus:outline-none focus:ring-2 focus:ring-primary/40" aria-label={`Open ${a.name}`}>
              {/* Private, server-signed URL; no-referrer so it is not leaked onward. */}
              <img src={a.viewUrl!} alt={a.name} loading="lazy" referrerPolicy="no-referrer" onError={() => markBroken(key)} className="h-28 w-full object-cover transition-transform group-hover:scale-105" />
              <span className="absolute bottom-0 left-0 right-0 truncate bg-black/55 px-1.5 py-0.5 text-left text-[10px] text-white">{a.name} · {kb(a.size)}</span>
            </button>
          ) : (
            <Unavailable key={key} a={a} />
          )
        })}
      </div>

      <Modal isOpen={!!cur} onClose={() => setOpen(null)} title={cur?.name ?? 'Proof'} size="xl">
        {cur?.viewUrl && !broken.has(`${open}:${cur.name}`) ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} className="rounded-md border border-border bg-surface p-1.5 text-text-secondary hover:bg-surface-alt"><Minus className="h-4 w-4" /></button>
              <span className="w-12 text-center text-xs tabular-nums text-text-secondary">{Math.round(zoom * 100)}%</span>
              <button type="button" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(4, z + 0.25))} className="rounded-md border border-border bg-surface p-1.5 text-text-secondary hover:bg-surface-alt"><Plus className="h-4 w-4" /></button>
              <button type="button" aria-label="Fit" onClick={() => setZoom(1)} className="rounded-md border border-border bg-surface p-1.5 text-text-secondary hover:bg-surface-alt"><Scan className="h-4 w-4" /></button>
              <a href={cur.viewUrl} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline">Open full size <ExternalLink className="h-3 w-3" /></a>
            </div>
            <div className="max-h-[65vh] overflow-auto rounded-lg border border-border bg-surface-alt">
              <img src={cur.viewUrl} alt={cur.name} referrerPolicy="no-referrer" onError={() => markBroken(`${open}:${cur.name}`)} style={{ width: `${zoom * 100}%`, maxWidth: 'none' }} className="block" />
            </div>
            {attachments.length > 1 && (
              <div className="flex items-center justify-between text-xs">
                <button type="button" disabled={open === 0} onClick={() => { setOpen((o) => (o ?? 0) - 1); setZoom(1) }} className="rounded-md border border-border px-2.5 py-1 font-medium disabled:opacity-50">Previous</button>
                <span className="text-text-muted">{(open ?? 0) + 1} of {attachments.length}</span>
                <button type="button" disabled={open === attachments.length - 1} onClick={() => { setOpen((o) => (o ?? 0) + 1); setZoom(1) }} className="rounded-md border border-border px-2.5 py-1 font-medium disabled:opacity-50">Next</button>
              </div>
            )}
          </div>
        ) : cur ? <Unavailable a={cur} /> : null}
      </Modal>
    </div>
  )
}
