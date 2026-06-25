'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { adminApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { toast } from '@/lib/toast'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { ArrowLeft, RefreshCw } from 'lucide-react'

type Row = Awaited<ReturnType<typeof adminApi.getGasReferrals>>[number]

function fmt(n: number): string { return `$${n.toFixed(2)}` }

export default function GasReferralsAdminPage() {
  const router = useRouter()
  const isSuperAdmin = useAuthStore((s) => s.user?.role === 'super_admin')

  const [rows, setRows] = useState<Row[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setRows(await adminApi.getGasReferrals()) }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed to load referrals') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  async function toggle(r: Row) {
    setBusyId(r.codeId)
    try {
      await adminApi.updateGasReferral(r.codeId, { isActive: !r.isActive })
      toast.success(`${r.code} ${r.isActive ? 'disabled' : 'enabled'}`)
      void load()
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Failed to update') }
    finally { setBusyId(null) }
  }

  async function editPct(r: Row) {
    const raw = window.prompt(`Referral % for ${r.code} (owner ${r.owner.username ?? r.owner.email}). Currently ${r.referralPct}%.`, String(r.referralPct))
    if (raw == null) return
    const next = Number(raw)
    if (!(next >= 0 && next <= 100)) { toast.error('Percent must be 0–100'); return }
    setBusyId(r.codeId)
    try {
      await adminApi.updateGasReferral(r.codeId, { referralPct: next })
      toast.success(`${r.code} set to ${next}%`)
      void load()
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Failed to update') }
    finally { setBusyId(null) }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={() => router.push('/admin/gas')} className="p-2 rounded-lg hover:bg-surface-alt"><ArrowLeft className="w-4 h-4" /></button>
        <div className="flex-1">
          <h1 className="text-lg font-bold text-text-primary">Gas Referrals</h1>
          <p className="text-xs text-text-muted">KOL income — paid from the platform margin only. Active only when <code>gas_referral_enabled</code> is ON.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw className="w-4 h-4" /></Button>
      </div>

      {loading && <LoadingState message="Loading referrals..." />}
      {error && !loading && <ErrorState description={error} onRetry={load} />}

      {!loading && !error && rows && rows.length === 0 && (
        <div className="rounded-xl border border-border bg-surface p-8 text-center text-sm text-text-muted">No referral codes yet.</div>
      )}

      {!loading && !error && rows && rows.length > 0 && (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.codeId} className="rounded-xl border border-border bg-surface p-4">
              <div className="flex items-start gap-3 flex-wrap">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-text-primary">{r.code}</span>
                    <Badge variant={r.isActive ? 'success' : 'default'}>{r.isActive ? 'Active' : 'Disabled'}</Badge>
                    <span className="text-xs text-primary font-semibold">{r.referralPct}%</span>
                  </div>
                  <p className="text-xs text-text-muted mt-0.5 truncate">{r.owner.username ?? r.owner.email} · KYC {r.owner.kycLevel}</p>
                </div>
                {isSuperAdmin && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => editPct(r)} disabled={busyId === r.codeId}>Edit %</Button>
                    <Button size="sm" variant={r.isActive ? 'secondary' : 'primary'} onClick={() => toggle(r)} disabled={busyId === r.codeId}>
                      {r.isActive ? 'Disable' : 'Enable'}
                    </Button>
                  </div>
                )}
              </div>
              <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <div><p className="text-text-muted">Referred</p><p className="font-semibold text-text-primary">{r.referredCount}</p></div>
                <div><p className="text-text-muted">Total earned</p><p className="font-semibold text-text-primary">{fmt(r.totalAccruedUsdt)}</p></div>
                <div><p className="text-text-muted">Available</p><p className="font-semibold text-primary">{fmt(r.availableUsdt)}</p></div>
                <div><p className="text-text-muted">Withdrawn</p><p className="font-semibold text-text-primary">{fmt(r.withdrawnUsdt)}</p></div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
