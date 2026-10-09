'use client'
import { useState } from 'react'
import Link from 'next/link'
import { makerApi, type MakerStatusView } from '@/lib/makerApi'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { CheckCircle2, Circle, Clock } from 'lucide-react'

/**
 * "Become a maker" checklist. Shown on /maker and in place of the create-ad /
 * create-listing form when the maker gate is ON and the user is not yet allowed
 * to post.
 */
export function MakerChecklist({ status, onChange }: { status: MakerStatusView; onChange: (s: MakerStatusView) => void }) {
  const [phone, setPhone] = useState(status.whatsappNumber ?? '')
  const [busy, setBusy] = useState<'phone' | 'apply' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run(kind: 'phone' | 'apply', fn: () => Promise<MakerStatusView>) {
    setBusy(kind)
    setError(null)
    try {
      onChange(await fn())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setBusy(null)
    }
  }

  const badge =
    status.makerStatus === 'approved' ? <Badge variant="success" size="sm">Approved</Badge>
    : status.makerStatus === 'pending' ? <Badge variant="warning" size="sm">Under review</Badge>
    : status.makerStatus === 'rejected' ? <Badge variant="danger" size="sm">Not approved</Badge>
    : <Badge variant="default" size="sm">Not approved yet</Badge>

  const approvalMet = status.requirements.find((r) => r.key === 'approval')?.met

  return (
    <div className="bg-surface border border-border rounded-xl p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3 mb-1">
        <h2 className="text-lg font-bold text-text-primary">Become a maker</h2>
        {badge}
      </div>
      <p className="text-sm text-text-muted mb-5">
        To keep buyers safe, people who post ads complete a few quick checks. Trading without posting an ad needs none of this.
      </p>

      <ul className="space-y-3">
        {status.requirements.filter((r) => r.key !== 'approval').map((r) => (
          <li key={r.key} className="flex items-start gap-3">
            {r.met
              ? <CheckCircle2 className="w-5 h-5 text-success flex-shrink-0 mt-0.5" />
              : <Circle className="w-5 h-5 text-text-muted flex-shrink-0 mt-0.5" />}
            <div className="min-w-0 flex-1">
              <p className={`text-sm ${r.met ? 'text-text-primary' : 'text-text-secondary'}`}>{r.label}</p>
              {!r.met && r.key === 'kyc' && <Link href="/kyc" className="text-xs text-primary hover:underline">Complete verification</Link>}
              {!r.met && r.key === 'telegram' && <Link href="/settings" className="text-xs text-primary hover:underline">Link Telegram in Settings</Link>}
              {r.key === 'whatsapp' && (
                <div className="flex gap-2 mt-1.5">
                  <input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+92 300 1234567"
                    inputMode="tel"
                    className="flex-1 min-w-0 px-3 py-2 border border-border rounded-lg text-sm bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                  <Button size="sm" variant="secondary" loading={busy === 'phone'} disabled={!phone.trim()} onClick={() => run('phone', () => makerApi.saveWhatsapp(phone.trim()))}>
                    Save
                  </Button>
                </div>
              )}
            </div>
          </li>
        ))}
        <li className="flex items-start gap-3">
          {approvalMet
            ? <CheckCircle2 className="w-5 h-5 text-success flex-shrink-0 mt-0.5" />
            : status.makerStatus === 'pending'
              ? <Clock className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
              : <Circle className="w-5 h-5 text-text-muted flex-shrink-0 mt-0.5" />}
          <div>
            <p className="text-sm text-text-secondary">Approved by RupChain</p>
            <p className="text-xs text-text-muted">
              You are approved automatically when your Level 2 verification is approved.
              {status.contactTelegram ? <> Message us on Telegram at <span className="font-medium text-text-primary">{status.contactTelegram}</span> to speed it up.</> : ' We may contact you on Telegram or WhatsApp.'}
            </p>
          </div>
        </li>
      </ul>

      {status.makerStatus === 'rejected' && status.reviewNote && (
        <p className="mt-4 text-sm text-danger bg-danger/5 border border-danger/20 rounded-lg p-3">Not approved: {status.reviewNote}</p>
      )}
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      <div className="mt-5">
        {status.makerStatus === 'approved' ? (
          <Link href="/create-ad"><Button>Post an ad</Button></Link>
        ) : status.makerStatus === 'pending' ? (
          <p className="text-sm text-text-muted">Your application is under review. You will get a notification when it is decided.</p>
        ) : (
          <Button loading={busy === 'apply'} disabled={!status.canApply} onClick={() => run('apply', () => makerApi.apply())}>
            {status.makerStatus === 'rejected' ? 'Apply again' : 'Apply for approval'}
          </Button>
        )}
        {status.makerStatus === 'approved' && status.reviewFirstN > 0 && (
          <p className="text-xs text-text-muted mt-2">Your first {status.reviewFirstN} ads are checked by our team before they go live.</p>
        )}
      </div>
    </div>
  )
}
