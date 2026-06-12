'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { adminApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { toast } from '@/lib/toast'
import { CopyButton } from '@/components/ui/CopyButton'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Button } from '@/components/ui/Button'
import { Badge, type BadgeVariant } from '@/components/ui/Badge'
import { ArrowLeft, RefreshCw, Wrench } from 'lucide-react'

type Diag = Awaited<ReturnType<typeof adminApi.getGasTokenDiagnostics>>['report'][number]
type Verdict = Diag['verdict']

// Verdict → how it reads in the UI. Severity drives sort + summary order.
const VERDICT_META: Record<Verdict, { label: string; variant: BadgeVariant; severity: number; blurb: string }> = {
  WRONG_ADDRESS:    { label: 'Wrong address',    variant: 'danger',  severity: 0, blurb: 'No correct token at the stored address' },
  ADDRESS_MISSING:  { label: 'No address',       variant: 'danger',  severity: 0, blurb: 'No contract address configured' },
  UNKNOWN_ERROR:    { label: 'Read error',       variant: 'danger',  severity: 1, blurb: 'Unexpected on-chain read failure' },
  RPC_ERROR:        { label: 'RPC problem',      variant: 'warning', severity: 2, blurb: 'Address is correct; the RPC node failed' },
  RATE_LIMITED:     { label: 'Rate limited',     variant: 'warning', severity: 2, blurb: 'RPC returned 429 — needs an API key' },
  NOT_SUPPORTED:    { label: 'Not supported',    variant: 'info',    severity: 3, blurb: 'No balance reader for this chain yet' },
  INACTIVE:         { label: 'Inactive',         variant: 'default', severity: 4, blurb: 'Healthy but hidden (token inactive)' },
  CANONICAL_UNKNOWN:{ label: 'Verified',         variant: 'success', severity: 5, blurb: 'Token verified on-chain (no canonical ref)' },
  OK:               { label: 'OK',               variant: 'success', severity: 6, blurb: 'Verified and canonical' },
}

function short(addr: string | null): string {
  if (!addr) return '—'
  return addr.length > 22 ? `${addr.slice(0, 10)}…${addr.slice(-8)}` : addr
}

export default function GasTokenDiagnosticsPage() {
  const router = useRouter()
  const isSuperAdmin = useAuthStore((s) => s.user?.role === 'super_admin')

  const [report, setReport] = useState<Diag[] | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fixing, setFixing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await adminApi.getGasTokenDiagnostics()
      setReport(r.report); setCounts(r.counts)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to run diagnostics')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const fixableCount = (report ?? []).filter((d) => d.verdict === 'WRONG_ADDRESS' && d.canonicalAddress).length

  const handleFix = async () => {
    setFixing(true)
    try {
      const { changes } = await adminApi.fixGasTokenAddresses()
      if (changes.length === 0) toast.info('Nothing to fix', 'All addresses are already canonical.')
      else toast.success(`Corrected ${changes.length} address(es)`, changes.map((c) => `${c.chain} ${c.symbol}`).join(', '))
      await load()
    } catch (e: unknown) {
      toast.error('Fix failed', e instanceof Error ? e.message : undefined)
    } finally {
      setFixing(false)
    }
  }

  if (loading) return <LoadingState message="Probing every configured token on-chain…" />
  if (error)   return <ErrorState description={error} onRetry={() => void load()} />
  if (!report) return null

  const sorted = [...report].sort(
    (a, b) =>
      VERDICT_META[a.verdict].severity - VERDICT_META[b.verdict].severity ||
      a.chainSlug.localeCompare(b.chainSlug) ||
      a.symbol.localeCompare(b.symbol),
  )

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <button
          onClick={() => router.push('/admin/gas')}
          className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors"
        >
          <ArrowLeft size={14} /> Back to Gas
        </button>
        <div className="flex items-center gap-2">
          {isSuperAdmin && fixableCount > 0 && (
            <Button size="sm" variant="primary" disabled={fixing} onClick={() => void handleFix()}>
              <Wrench size={14} /> {fixing ? 'Fixing…' : `Fix ${fixableCount} address${fixableCount > 1 ? 'es' : ''}`}
            </Button>
          )}
          <Button size="sm" variant="secondary" disabled={loading} onClick={() => void load()}>
            <RefreshCw size={14} /> Re-run
          </Button>
        </div>
      </div>

      {/* Intro */}
      <div className="bg-surface border border-border rounded-xl p-5">
        <h1 className="text-base font-bold text-text-primary mb-1">Gas Token Diagnostics</h1>
        <p className="text-xs text-text-muted">
          Every configured non-native token is probed live on-chain. For each one this shows whether it will appear in the
          hot-wallet view, whether the stored contract address is the canonical one, and — when a read fails — whether the
          cause is a wrong address, an unhealthy/rate-limited RPC, or a chain with no reader yet.
        </p>
        {/* Summary chips */}
        <div className="flex flex-wrap gap-2 mt-3">
          {Object.entries(counts)
            .sort((a, b) => VERDICT_META[a[0] as Verdict].severity - VERDICT_META[b[0] as Verdict].severity)
            .map(([v, n]) => (
              <Badge key={v} variant={VERDICT_META[v as Verdict].variant} size="sm">
                {VERDICT_META[v as Verdict].label}: {n}
              </Badge>
            ))}
        </div>
      </div>

      {/* Rows */}
      <div className="space-y-3">
        {sorted.map((d) => {
          const meta = VERDICT_META[d.verdict]
          const mismatch = d.canonicalAddress && d.addressMatchesCanonical === false
          return (
            <div key={d.chainSlug + d.symbol} className="bg-surface border border-border rounded-xl p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-text-primary">{d.chainSlug}</span>
                    <span className="text-text-muted">·</span>
                    <span className="font-medium text-text-primary">{d.symbol}</span>
                    {d.name && <span className="text-[11px] text-text-muted truncate max-w-[200px]">{d.name}</span>}
                    {!d.willShowInWalletView && <Badge variant="outline" size="sm">hidden from wallet view</Badge>}
                    {d.deliveryLive && <Badge variant="gold" size="sm">delivery live</Badge>}
                  </div>
                  <p className="text-[11px] text-text-muted mt-0.5">{meta.blurb}</p>
                </div>
                <Badge variant={meta.variant} size="sm">{meta.label}</Badge>
              </div>

              {/* Address rows */}
              <div className="mt-3 space-y-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-text-muted w-20 shrink-0">Stored</span>
                  <span className="font-mono text-text-secondary break-all">{short(d.configuredAddress)}</span>
                  {d.configuredAddress && <CopyButton text={d.configuredAddress} />}
                </div>
                {mismatch && (
                  <div className="flex items-center gap-2">
                    <span className="text-text-muted w-20 shrink-0">Canonical</span>
                    <span className="font-mono text-success break-all">{short(d.canonicalAddress)}</span>
                    {d.canonicalAddress && <CopyButton text={d.canonicalAddress} />}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <span className="text-text-muted w-20 shrink-0">Probe</span>
                  <span className={d.probeError ? 'text-danger break-all' : 'text-text-secondary'}>
                    {d.probeError ? d.probeError : d.probeOk ? `ok (decimals=${d.probeDecimals})` : '—'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-text-muted w-20 shrink-0">RPC</span>
                  <span className="font-mono text-text-muted break-all">{d.rpcUrl}</span>
                </div>
              </div>

              {/* Remediation */}
              <div className="mt-3 bg-surface-alt border border-border rounded-lg px-3 py-2">
                <p className="text-[11px] text-text-secondary"><span className="font-semibold">Fix: </span>{d.remediation}</p>
              </div>
            </div>
          )
        })}
      </div>

      {!isSuperAdmin && fixableCount > 0 && (
        <p className="text-xs text-text-muted text-center">
          {fixableCount} token(s) have a one-click canonical fix available — ask a super-admin to apply it, or run
          {' '}<span className="font-mono">npm run gas:diagnose-tokens -- --fix</span>.
        </p>
      )}
    </div>
  )
}
