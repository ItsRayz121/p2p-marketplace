'use client'
import { useState, useCallback } from 'react'
import Link from 'next/link'
import { adminApi } from '@/lib/api'
import { adminMakerApi, type MakerApplication } from '@/lib/makerApi'
import { useAuthStore } from '@/store/auth.store'
import { usePolling } from '@/hooks/usePolling'
import { fmtDateTime } from '@/lib/fmt'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { BadgeCheck } from 'lucide-react'
import { MakerReviewSettingsCard } from '@/components/maker/MakerReviewSettingsCard'

type Tab = 'pending' | 'approved' | 'rejected'

export default function MakerApplicationsPage() {
  const isSuper = useAuthStore((s) => s.user?.role === 'super_admin')
  const [tab, setTab] = useState<Tab>('pending')
  const [data, setData] = useState<{ gateEnabled: boolean; applications: MakerApplication[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState<MakerApplication | null>(null)
  const [note, setNote] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmGate, setConfirmGate] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await adminMakerApi.getApplications(tab))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    }
  }, [tab])

  usePolling(load, 60_000, true, [tab])

  async function decide(app: MakerApplication, approve: boolean, reason?: string) {
    setBusyId(app.id)
    setActionError(null)
    try {
      await adminMakerApi.decideMaker(app.id, { approve, ...(reason ? { note: reason } : {}) })
      setRejecting(null)
      setNote('')
      await load()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusyId(null)
    }
  }

  async function toggleGate() {
    if (!data) return
    await adminApi.updateConfig({ key: 'maker_gate_enabled', value: data.gateEnabled ? 'false' : 'true' })
    setConfirmGate(false)
    await load()
  }

  if (error && !data) return <ErrorState title={error} onRetry={load} />
  if (!data) return <LoadingState message="Loading maker applications..." />

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-text-primary flex items-center gap-2"><BadgeCheck className="w-5 h-5 text-primary" /> Maker Applications</h1>
          <p className="text-sm text-text-muted mt-1">People who want to post ads. Contact them on Telegram or WhatsApp before approving.</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={data.gateEnabled ? 'success' : 'default'} size="sm">Maker gate {data.gateEnabled ? 'ON' : 'OFF'}</Badge>
          {isSuper && (
            <Button size="sm" variant="secondary" onClick={() => setConfirmGate(true)}>{data.gateEnabled ? 'Turn off' : 'Turn on'}</Button>
          )}
        </div>
      </div>

      {!data.gateEnabled && (
        <p className="mb-4 text-sm text-text-secondary bg-surface-alt border border-border rounded-lg p-3">
          The gate is OFF, so nobody is blocked and new ads go live immediately. Turn it on when you are ready; everyone who already
          posts ads was approved automatically.
        </p>
      )}

      <MakerReviewSettingsCard />

      <div className="flex gap-2 mb-4">
        {(['pending', 'approved', 'rejected'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border capitalize transition-colors ${tab === t ? 'bg-primary text-white border-primary' : 'bg-surface text-text-secondary border-border hover:border-primary/40'}`}
          >
            {t}
          </button>
        ))}
      </div>

      {actionError && <p className="mb-3 text-sm text-danger">{actionError}</p>}

      {data.applications.length === 0 ? (
        <EmptyState title="Nothing here" description={`No ${tab} applications.`} />
      ) : (
        <ul className="space-y-3">
          {data.applications.map((a) => (
            <li key={a.id} className="bg-surface border border-border rounded-xl p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/admin/users/${a.id}`} className="font-semibold text-text-primary hover:text-primary hover:underline">{a.username ?? a.email}</Link>
                  <p className="text-xs text-text-muted truncate">{a.fullName ?? ''} · {a.email}</p>
                </div>
                <div className="flex gap-1.5 flex-wrap">
                  <Badge variant={a.kycLevel === 'enhanced' ? 'success' : 'warning'} size="sm">KYC {a.kycStatus === 'approved' ? a.kycLevel : a.kycStatus}</Badge>
                  {a.isTrusted && <Badge variant="default" size="sm">Trusted</Badge>}
                  {a.tradingHold && <Badge variant="danger" size="sm">On hold</Badge>}
                </div>
              </div>

              <dl className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-xs">
                <div><dt className="text-text-muted">Telegram</dt><dd className="text-text-primary">{a.telegramUsername ? `@${a.telegramUsername}` : 'linked'}</dd></div>
                <div><dt className="text-text-muted">WhatsApp</dt><dd className="text-text-primary">{a.whatsappNumber ?? '—'}</dd></div>
                <div><dt className="text-text-muted">Trades</dt><dd className="text-text-primary">{a.tradeStats ? `${a.tradeStats.completedTrades}/${a.tradeStats.totalTrades} completed` : 'none yet'}</dd></div>
                <div><dt className="text-text-muted">Applied</dt><dd className="text-text-primary">{a.makerAppliedAt ? fmtDateTime(a.makerAppliedAt) : '—'}</dd></div>
              </dl>

              {a.makerReviewNote && <p className="mt-2 text-xs text-text-muted">Note: {a.makerReviewNote}</p>}

              {tab !== 'approved' && (
                <div className="mt-3 flex gap-2">
                  {tab === 'pending' && <Button size="sm" loading={busyId === a.id} onClick={() => decide(a, true)}>Approve</Button>}
                  <Button size="sm" variant="danger" disabled={busyId === a.id} onClick={() => { setRejecting(a); setNote('') }}>{tab === 'rejected' ? 'Update reason' : 'Reject'}</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {rejecting && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setRejecting(null)}>
          <div className="bg-surface rounded-xl border border-border p-5 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold text-text-primary mb-1">Reject @{rejecting.username}</h3>
            <p className="text-xs text-text-muted mb-3">This reason is shown to the applicant so they can fix it and apply again.</p>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="e.g. We could not reach you on WhatsApp. Please check the number."
              className="w-full px-3 py-2 border border-border rounded-lg text-sm bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <div className="flex justify-end gap-2 mt-3">
              <Button size="sm" variant="secondary" onClick={() => setRejecting(null)}>Cancel</Button>
              <Button size="sm" variant="danger" loading={busyId === rejecting.id} disabled={!note.trim()} onClick={() => decide(rejecting, false, note.trim())}>Reject</Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={confirmGate}
        onClose={() => setConfirmGate(false)}
        onConfirm={toggleGate}
        title={data.gateEnabled ? 'Turn the maker gate off?' : 'Turn the maker gate on?'}
        description={
          data.gateEnabled
            ? 'Anyone will be able to post ads again and new ads will go live immediately.'
            : 'New ads will need Level 2 KYC, a linked Telegram, a WhatsApp number and your approval. Current makers keep posting. A new maker\'s first ads are reviewed.'
        }
        confirmLabel={data.gateEnabled ? 'Turn off' : 'Turn on'}
      />
    </div>
  )
}
