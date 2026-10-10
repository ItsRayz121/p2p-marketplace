'use client'
import { useEffect, useState } from 'react'
import { adminPlatformTaskApi } from '@/lib/platformTasks'
import { toast } from '@/lib/toast'

/** Edit how many hours a submission may wait in the review inbox before it counts as overdue. */
export function ReviewTargetControl({ hours, onSaved }: { hours: number; onSaved: () => void }) {
  const [value, setValue] = useState(String(hours))
  const [saving, setSaving] = useState(false)
  useEffect(() => { setValue(String(hours)) }, [hours])

  const n = Number(value)
  const valid = Number.isInteger(n) && n >= 1 && n <= 720
  const dirty = valid && n !== hours

  async function save() {
    if (!dirty) return
    setSaving(true)
    try {
      await adminPlatformTaskApi.setReviewTarget(n)
      toast.success(`Review target set to ${n}h`)
      onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the review target')
    } finally { setSaving(false) }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void save() }} className="flex items-center gap-2 text-xs text-text-secondary">
      <label htmlFor="review-target" title="Submissions waiting longer than this are flagged as overdue">Review target</label>
      <input id="review-target" type="number" inputMode="numeric" min={1} max={720} value={value} onChange={(e) => setValue(e.target.value)}
        aria-invalid={!valid} className="w-16 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-text-primary aria-[invalid=true]:border-danger" />
      <span>hours</span>
      {dirty && (
        <button type="submit" disabled={saving} className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
      )}
    </form>
  )
}
