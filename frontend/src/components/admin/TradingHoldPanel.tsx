'use client'
import { useState } from 'react'
import { adminApi } from '@/lib/api'
import { fmtDateTime } from '@/lib/fmt'
import { useAuthStore } from '@/store/auth.store'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { OctagonAlert, ShieldCheck } from 'lucide-react'

/**
 * Trading hold + trusted controls.
 *
 * Hold = the user can still log in, chat and answer a dispute, but cannot post
 * ads or open/accept trades; live ads are paused when it is applied. It sits
 * between "Under Review" (informational) and Suspend/Ban (full lockout).
 */
export function TradingHoldPanel({
  userId,
  tradingHold,
  reason,
  since,
  isTrusted,
  onChange,
}: {
  userId: string
  tradingHold: boolean
  reason?: string | null
  since?: string | null
  isTrusted: boolean
  onChange?: () => void
}) {
  const isSuper = useAuthStore((s) => s.user?.role === 'super_admin')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  async function run(fn: () => Promise<string | void>) {
    setBusy(true); setError(null); setInfo(null)
    try {
      const msg = await fn()
      if (msg) setInfo(msg)
      setText('')
      onChange?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  function applyHold() {
    if (!text.trim()) { setError('A reason is required (it is shown to the user).'); return }
    void run(async () => {
      const res = await adminApi.setTradingHold(userId, { reason: text.trim() })
      return `Hold applied. Paused ${res?.paused?.ads ?? 0} ad(s) and ${res?.paused?.listings ?? 0} CTM listing(s).`
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        {tradingHold ? <Badge variant="danger" size="sm">On trading hold</Badge> : <Badge variant="success" size="sm">No hold</Badge>}
        {isTrusted && <Badge variant="default" size="sm">Trusted</Badge>}
      </div>

      {tradingHold && (
        <div className="rounded-lg border border-danger/20 bg-danger/5 p-3 text-sm">
          <p className="text-text-primary"><strong>Reason:</strong> {reason || '—'}</p>
          {since && <p className="text-xs text-text-muted mt-0.5">Since {fmtDateTime(since)}</p>}
        </div>
      )}

      <div>
        <p className="text-xs text-text-muted mb-1">{tradingHold ? 'Note for release (optional)' : 'Reason (shown to the user)'}</p>
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={tradingHold ? 'e.g. Dispute resolved, refunded buyer' : 'e.g. Open dispute: did not deliver tokens'}
          className="w-full px-3 py-2 border border-border rounded-lg text-sm bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {tradingHold ? (
          <Button size="sm" loading={busy} onClick={() => void run(() => adminApi.releaseTradingHold(userId, text.trim() ? { reason: text.trim() } : {}))}>
            <ShieldCheck className="w-4 h-4 mr-1" /> Release hold
          </Button>
        ) : (
          <Button size="sm" variant="danger" loading={busy} onClick={applyHold}>
            <OctagonAlert className="w-4 h-4 mr-1" /> Apply trading hold
          </Button>
        )}
        {isSuper && (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => void run(() => adminApi.setUserTrusted(userId, { trusted: !isTrusted }))}>
            {isTrusted ? 'Remove trusted status' : 'Mark as trusted'}
          </Button>
        )}
      </div>

      <p className="text-xs text-text-muted">
        A hold pauses their live ads and blocks posting and new trades. They can still log in, chat and answer the dispute.
        Trusted accounts skip maker deposit/approval rules but are never exempt from a hold.
      </p>
      {info && <p className="text-xs text-success">{info}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  )
}
