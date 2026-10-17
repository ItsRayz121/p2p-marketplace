'use client'
import { useCallback, useEffect, useState } from 'react'
import { shareApi } from '@/lib/api'
import type { XSettings } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/Button'

const FIELD = 'h-10 w-full rounded-lg border border-border bg-surface-alt px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/40'

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-1 h-4 w-4 accent-primary" />
      <span>
        <span className="block text-sm font-medium text-text-primary">{label}</span>
        {hint && <span className="block text-xs text-text-muted">{hint}</span>}
      </span>
    </label>
  )
}

/**
 * Settings → Integrations → X / Twitter for Share & Earn. The provider only reads public posts; the API
 * key is write-only (it is stored encrypted on the server and never sent back to the browser).
 */
export function XVerificationSettings() {
  const [s, setS] = useState<XSettings | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [handle, setHandle] = useState('')
  const [budget, setBudget] = useState('')
  const [low, setLow] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [err, setErr] = useState('')

  const sync = useCallback((v: XSettings) => {
    setS(v)
    setHandle(v.officialHandle ?? '')
    setBudget(String(v.dailyBudget))
    setLow(String(v.lowCreditsAlert))
    setBaseUrl(v.baseUrl)
  }, [])

  useEffect(() => {
    shareApi.adminGetXSettings().then(sync).catch((e) => setErr(e instanceof Error ? e.message : 'Could not load settings'))
  }, [sync])

  async function save(extra: Parameters<typeof shareApi.adminSaveXSettings>[0] = {}) {
    setSaving(true)
    try {
      const body: Parameters<typeof shareApi.adminSaveXSettings>[0] = {
        officialHandle: handle.trim(),
        dailyBudget: Math.max(1, Math.floor(Number(budget) || 200)),
        lowCreditsAlert: Math.max(0, Math.floor(Number(low) || 0)),
        baseUrl: baseUrl.trim(),
        ...extra,
      }
      if (apiKey.trim()) body.apiKey = apiKey.trim()
      sync(await shareApi.adminSaveXSettings(body))
      setApiKey('')
      toast.success('Saved')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not save') }
    finally { setSaving(false) }
  }

  async function test() {
    setTesting(true)
    setTestMsg(null)
    try {
      // A key typed but not saved yet is saved first, so the test runs against what the admin sees.
      if (apiKey.trim()) await save()
      const r = await shareApi.adminTestX()
      setTestMsg({ ok: r.ok, text: r.message })
      sync(await shareApi.adminGetXSettings())
    } catch (e) { setTestMsg({ ok: false, text: e instanceof Error ? e.message : 'Test failed' }) }
    finally { setTesting(false) }
  }

  if (err) return <p className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{err}</p>
  if (!s) return <div className="h-24 animate-pulse rounded-xl bg-surface-alt" />

  const status = !s.hasKey ? { t: 'No API key', c: 'text-text-muted' } : s.lastError ? { t: 'Last call failed', c: 'text-danger' } : { t: 'Key saved', c: 'text-success' }

  return (
    <section className="space-y-4 rounded-xl border border-border bg-surface p-4" aria-label="X verification settings">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-text-primary">X post verification</h2>
          <p className="text-xs text-text-muted">Provider: {s.provider} (read-only lookups of public posts). Nothing is ever posted for anyone.</p>
        </div>
        <span className={`text-xs font-semibold ${status.c}`}>{status.t}{s.keyHint ? ` · ${s.keyHint}` : ''}</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-xs font-medium text-text-secondary">Official RupChain X handle</span>
          <input className={FIELD} value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="RupChain" maxLength={16} autoCapitalize="none" />
          <span className="block text-[11px] text-text-muted">Mentioned in every caption and required in submitted posts. Leave empty to skip the mention.</span>
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-text-secondary">API key {s.hasKey && '(saved, enter a new one to replace)'}</span>
          <input className={FIELD} type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={s.hasKey ? '••••••••' : 'Paste the provider key'} />
          <span className="block text-[11px] text-text-muted">Stored encrypted. It is never shown again.</span>
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-text-secondary">Daily lookup budget</span>
          <input className={FIELD} inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value.replace(/\D/g, ''))} />
          <span className="block text-[11px] text-text-muted">Used today: {s.usedToday}. After the limit, posts wait for manual review.</span>
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-text-secondary">Alert me below (credits)</span>
          <input className={FIELD} inputMode="numeric" value={low} onChange={(e) => setLow(e.target.value.replace(/\D/g, ''))} />
          <span className="block text-[11px] text-text-muted">{s.lastCredits !== null ? `Last known balance: ${s.lastCredits.toLocaleString('en-US')} credits.` : 'Run a connection test to read the balance.'}</span>
        </label>
        <label className="space-y-1 sm:col-span-2">
          <span className="text-xs font-medium text-text-secondary">Provider URL</span>
          <input className={FIELD} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.twitterapi.io" />
        </label>
      </div>

      <div className="space-y-3">
        <Toggle checked={s.enabled} onChange={(v) => void save({ enabled: v })} label="Check submitted posts automatically" hint="Each submission costs one provider lookup. A failed lookup never rejects a post; it just stays in this queue." />
        <Toggle checked={s.autoApprove} onChange={(v) => void save({ autoApprove: v })} label="Approve automatically when every check passes" hint="Off by default. Posts are matched to the order by its link, but a post cannot prove who wrote it, so keep this off unless you accept that risk." />
      </div>

      {s.lastError && <p className="break-words rounded-lg bg-danger/10 p-2 text-xs text-danger">Last error: {s.lastError}</p>}
      {testMsg && <p className={`rounded-lg p-2 text-xs ${testMsg.ok ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}>{testMsg.text}</p>}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" loading={saving} onClick={() => void save()}>Save</Button>
        <Button size="sm" variant="secondary" loading={testing} onClick={() => void test()} disabled={!s.hasKey && !apiKey.trim()}>Test connection</Button>
      </div>
    </section>
  )
}
