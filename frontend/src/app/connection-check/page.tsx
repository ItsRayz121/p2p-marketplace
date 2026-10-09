'use client'
import { useCallback, useEffect, useState } from 'react'
import { API_BASE } from '@/lib/api'
import { getServiceWorkerDiagnostics, type ServiceWorkerDiagnostics } from '@/lib/installApp'
import { BrandLogo } from '@/components/ui/BrandLogo'

/**
 * /connection-check — what this device actually has installed, and whether the
 * website and the API answer right now. For support and for testing on real
 * phones (installed app included): open it, tap "Copy report", send it.
 * Reads only; the one write is "Repair", which re-downloads the static recovery page.
 */

interface ProbeResult { ok: boolean; status: number | null; ms: number; error: string | null }

async function probe(url: string, init: RequestInit = {}): Promise<ProbeResult> {
  const t0 = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(url, { ...init, cache: 'no-store', signal: controller.signal })
    return { ok: res.ok, status: res.status, ms: Math.round(performance.now() - t0), error: null }
  } catch (e) {
    return { ok: false, status: null, ms: Math.round(performance.now() - t0), error: controller.signal.aborted ? 'timeout' : (e instanceof Error ? e.message : 'failed') }
  } finally {
    clearTimeout(timer)
  }
}

const yesNo = (v: boolean | null) => (v === null ? 'unknown' : v ? 'yes' : 'no')

export default function ConnectionCheckPage() {
  const [sw, setSw] = useState<ServiceWorkerDiagnostics | null>(null)
  const [site, setSite] = useState<ProbeResult | null>(null)
  const [api, setApi] = useState<ProbeResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const run = useCallback(async (repair = false) => {
    setBusy(true)
    const [d, s, a] = await Promise.all([
      getServiceWorkerDiagnostics({ repair }),
      probe(`/connection-check?probe=${Date.now()}`, { credentials: 'same-origin' }),
      probe(`${API_BASE}/health/ping`),
    ])
    setSw(d); setSite(s); setApi(a)
    setBusy(false)
  }, [])

  useEffect(() => { void run() }, [run])

  const report = {
    at: new Date().toISOString(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    onLineFlag: typeof navigator !== 'undefined' ? navigator.onLine : null,
    serviceWorker: sw,
    website: site,
    api,
  }

  const copy = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { /* clipboard blocked */ }
  }

  const rows: Array<[string, string]> = sw ? [
    ['Installed app (standalone)', yesNo(sw.standalone)],
    ['Service worker supported', yesNo(sw.supported)],
    ['Service worker registered', yesNo(sw.registered)],
    ['This page is controlled by it', yesNo(sw.controlled)],
    ['Active worker state', sw.activeState ?? 'none'],
    ['Worker version', sw.version ?? (sw.registered ? 'older worker (before diagnostics)' : 'none')],
    ['Update waiting / installing', `${yesNo(sw.waiting)} / ${yesNo(sw.installing)}`],
    ['Recovery page stored', yesNo(sw.fallbackCached)],
    ['Last storage error', sw.lastCacheError ?? 'none'],
    ['API set for recovery check', sw.apiConfigured || 'not set'],
  ] : []

  const probeText = (p: ProbeResult | null) =>
    !p ? '…' : p.ok ? `OK (${p.status}) in ${p.ms} ms` : p.status ? `Error ${p.status} in ${p.ms} ms` : `No connection (${p.error}) after ${p.ms} ms`

  return (
    <main className="mx-auto min-h-[100dvh] max-w-lg bg-surface px-4 py-8 text-text-primary">
      <div className="mb-6 flex items-center gap-3">
        <BrandLogo size={40} />
        <div>
          <h1 className="text-lg font-semibold">Connection check</h1>
          <p className="text-xs text-text-muted">What this device has installed, and whether RupChain answers right now.</p>
        </div>
      </div>

      <section className="mb-4 rounded-xl border border-border p-4">
        <h2 className="mb-2 text-sm font-semibold">Right now</h2>
        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between gap-4"><dt className="text-text-muted">Website</dt><dd className="text-right">{probeText(site)}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-text-muted">RupChain API</dt><dd className="text-right">{probeText(api)}</dd></div>
        </dl>
      </section>

      <section className="mb-4 rounded-xl border border-border p-4">
        <h2 className="mb-2 text-sm font-semibold">This device</h2>
        <dl className="space-y-1.5 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4"><dt className="text-text-muted">{k}</dt><dd className="break-all text-right">{v}</dd></div>
          ))}
          {!sw && <p className="text-text-muted">Checking…</p>}
        </dl>
      </section>

      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void run()} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
          {busy ? 'Checking…' : 'Check again'}
        </button>
        <button type="button" disabled={busy} onClick={() => void run(true)} className="rounded-lg border border-border px-4 py-2 text-sm font-semibold disabled:opacity-60">
          Repair recovery page
        </button>
        <button type="button" onClick={() => void copy()} className="rounded-lg border border-border px-4 py-2 text-sm font-semibold">
          {copied ? 'Copied' : 'Copy report'}
        </button>
      </div>
    </main>
  )
}
