'use client'

/** "Showing 1 to 25 of 60" with Previous / Next. Offsets are zero-based. */
export function Pager({ offset, pageSize, total, onChange }: { offset: number; pageSize: number; total: number; onChange: (offset: number) => void }) {
  const from = total > 0 ? offset + 1 : 0
  const to = Math.min(offset + pageSize, total)
  return (
    <div className="flex items-center justify-between gap-3 text-xs text-text-muted">
      <span aria-live="polite">Showing {from} to {to} of {total}</span>
      <span className="inline-flex gap-3">
        <button type="button" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - pageSize))} className="font-medium text-primary hover:underline disabled:opacity-40 disabled:no-underline">Previous</button>
        <button type="button" disabled={offset + pageSize >= total} onClick={() => onChange(offset + pageSize)} className="font-medium text-primary hover:underline disabled:opacity-40 disabled:no-underline">Next</button>
      </span>
    </div>
  )
}
