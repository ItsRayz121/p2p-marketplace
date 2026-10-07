'use client'
import { useEffect, useState } from 'react'
import { adminMakerApi, type MakerReviewSettings } from '@/lib/makerApi'
import { Button } from '@/components/ui/Button'

/** Admin card: how many of a maker's ads need approval, and the size that always does. */
export function MakerReviewSettingsCard() {
  const [saved, setSaved] = useState<MakerReviewSettings | null>(null)
  const [firstN, setFirstN] = useState('3')
  const [above, setAbove] = useState('0')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    adminMakerApi.getSettings()
      .then((s) => { setSaved(s); setFirstN(String(s.reviewFirstN)); setAbove(String(s.reviewAboveUsdt)) })
      .catch(() => setMsg({ ok: false, text: 'Could not load the review settings.' }))
  }, [])

  const n = Number(firstN)
  const usdt = Number(above)
  const valid = Number.isInteger(n) && n >= 0 && n <= 50 && Number.isFinite(usdt) && usdt >= 0 && usdt <= 1_000_000
  const dirty = !!saved && (n !== saved.reviewFirstN || usdt !== saved.reviewAboveUsdt)

  async function save() {
    setBusy(true)
    setMsg(null)
    try {
      const s = await adminMakerApi.saveSettings({ reviewFirstN: n, reviewAboveUsdt: usdt })
      setSaved(s)
      setMsg({ ok: true, text: 'Saved. Applies to the next ad that is posted.' })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not save' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-surface border border-border rounded-xl p-4 mb-5">
      <h2 className="text-sm font-semibold text-text-primary">Review rules</h2>
      <p className="text-xs text-text-muted mt-0.5 mb-3">Which new ads wait for your approval before going live. Trusted accounts are never reviewed.</p>

      <div className="grid sm:grid-cols-2 gap-4">
        <label className="block">
          <span className="text-xs text-text-muted">Review each maker&apos;s first … ads</span>
          <input
            value={firstN}
            onChange={(e) => setFirstN(e.target.value)}
            inputMode="numeric"
            className="mt-1 w-full px-3 py-2 border border-border rounded-lg text-sm bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <span className="text-[11px] text-text-muted">0 = don&apos;t review by count (0 to 50).</span>
        </label>
        <label className="block">
          <span className="text-xs text-text-muted">Also review any USDT ad larger than … USDT</span>
          <input
            value={above}
            onChange={(e) => setAbove(e.target.value)}
            inputMode="decimal"
            className="mt-1 w-full px-3 py-2 border border-border rounded-lg text-sm bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <span className="text-[11px] text-text-muted">0 = no size limit. Uses the ad&apos;s largest single order.</span>
        </label>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" loading={busy} disabled={!valid || !dirty} onClick={save}>Save</Button>
        {!valid && <span className="text-xs text-danger">Enter whole numbers within the limits.</span>}
        {msg && <span className={`text-xs ${msg.ok ? 'text-success' : 'text-danger'}`}>{msg.text}</span>}
      </div>
    </div>
  )
}
