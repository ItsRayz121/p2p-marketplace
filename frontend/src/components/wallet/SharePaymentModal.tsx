'use client'
import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, RefreshCw, Share2 } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/CopyButton'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { paymentShareApi, paymentShareUrl, type PaymentShareState, type UserPaymentMethod } from '@/lib/api'
import { toast } from '@/lib/toast'

interface Props {
  isOpen: boolean
  onClose: () => void
  methods: UserPaymentMethod[]
  /** Called after a successful save with the ids now flagged as shared. */
  onSaved: (sharedIds: string[]) => void
  /** Display name of a method's institution (bank or wallet brand). */
  label: (m: UserPaymentMethod) => string
}

const numberOf = (m: UserPaymentMethod) => m.mobileNumber ?? m.ibanNumber ?? m.accountNumber ?? ''

/** Owner controls for the public payment page: enable/disable, pick methods, copy/share/regenerate the link. */
export function SharePaymentModal({ isOpen, onClose, methods, onSaved, label }: Props) {
  const [state, setState] = useState<PaymentShareState | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmRegen, setConfirmRegen] = useState(false)

  // Only visible methods can be shared — a method hidden from listings stays private.
  const shareable = useMemo(() => methods.filter((m) => !m.hidden), [methods])
  const hiddenCount = methods.length - shareable.length

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setLoading(true)
    paymentShareApi.get()
      .then((s) => { if (!cancelled) { setState(s); setEnabled(s.enabled) } })
      .catch(() => { if (!cancelled) toast.error('Could not load your payment page settings') })
      .finally(() => { if (!cancelled) setLoading(false) })
    setSelected(new Set(shareable.filter((m) => m.shared).map((m) => m.id)))
    return () => { cancelled = true }
    // `shareable` derives from `methods`; re-sync only when the dialog (re)opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const dirty = useMemo(() => {
    if (!state) return false
    const saved = new Set(shareable.filter((m) => m.shared).map((m) => m.id))
    return enabled !== state.enabled || saved.size !== selected.size || [...selected].some((id) => !saved.has(id))
  }, [state, enabled, selected, shareable])

  const canEnable = selected.size > 0
  const link = state?.slug ? paymentShareUrl(state.slug) : null
  const live = !!state?.enabled && !!link

  async function save() {
    if (enabled && !canEnable) { toast.error('Select at least one payment method to share'); return }
    setSaving(true)
    try {
      const next = await paymentShareApi.update({ enabled, methodIds: [...selected] })
      setState(next)
      setEnabled(next.enabled)
      onSaved([...selected])
      toast.success(next.enabled ? 'Payment page updated' : 'Payment page turned off')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save changes')
    } finally {
      setSaving(false)
    }
  }

  async function regenerate() {
    try {
      setState(await paymentShareApi.regenerate())
      toast.success('New link created — the old link no longer works')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not regenerate the link')
    } finally {
      setConfirmRegen(false)
    }
  }

  async function share() {
    if (!link) return
    // Web Share is optional — fall back to copying the link.
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'Pay me on RupChain', text: 'My payment details on RupChain', url: link })
        return
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
      }
    }
    try {
      await navigator.clipboard.writeText(link)
      toast.success('Link copied')
    } catch {
      toast.error('Could not copy the link')
    }
  }

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Share payment methods"
        size="md"
        footer={
          <div className="flex justify-end gap-3">
            <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
            <Button size="sm" loading={saving} disabled={loading || !dirty || (enabled && !canEnable)} onClick={save}>Save changes</Button>
          </div>
        }
      >
        <div className="space-y-5">
          <p className="text-sm text-text-muted">
            Give people one link where they can see and copy the PKR accounts you choose. Nothing is public until you turn this on
            and tick the methods below.
          </p>

          <label className="flex items-center justify-between gap-3 rounded-xl border border-border px-4 py-3 cursor-pointer">
            <span>
              <span className="block text-sm font-medium text-text-primary">Public payment page</span>
              <span className="block text-xs text-text-muted">{enabled ? 'Anyone with the link can view the selected methods' : 'Off — your link shows nothing'}</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={enabled}
              disabled={loading}
              onChange={(e) => setEnabled(e.target.checked)}
              aria-label="Public payment page"
              className="h-5 w-5 accent-primary"
            />
          </label>

          <fieldset disabled={loading}>
            <legend className="text-xs font-medium text-text-muted mb-2">Methods shown on the page</legend>
            {shareable.length === 0 ? (
              <p className="text-sm text-text-muted">You have no visible payment methods to share yet.</p>
            ) : (
              <ul className="rounded-xl border border-border divide-y divide-border overflow-hidden">
                {shareable.map((m) => (
                  <li key={m.id}>
                    <label className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-surface-alt">
                      <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} className="h-4 w-4 accent-primary" />
                      <EntityLogo type={m.type === 'bank_transfer' ? 'bank' : 'payment_method'} slug={m.type === 'bank_transfer' ? (m.bankName ?? 'bank') : label(m)} size="sm" className="flex-shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-text-primary truncate">{label(m)} · {m.accountName}</span>
                        <span className="block text-xs text-text-muted truncate">{numberOf(m)}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {hiddenCount > 0 && (
              <p className="text-xs text-text-muted mt-2">{hiddenCount} hidden method{hiddenCount === 1 ? '' : 's'} can&apos;t be shared — un-hide {hiddenCount === 1 ? 'it' : 'them'} first.</p>
            )}
            {enabled && !canEnable && <p className="text-xs text-danger mt-2">Select at least one method to turn the page on.</p>}
          </fieldset>

          {link && (
            <div className="rounded-xl border border-border p-3 space-y-3">
              <div>
                <p className="text-xs font-medium text-text-muted mb-1">Your payment link{live ? '' : ' (currently off)'}</p>
                <div className="flex items-center gap-1">
                  <input
                    readOnly
                    value={link}
                    onFocus={(e) => e.currentTarget.select()}
                    aria-label="Payment link"
                    className={`flex-1 min-w-0 px-3 py-2 text-xs font-mono border border-border rounded-lg bg-surface-alt text-text-primary ${live ? '' : 'opacity-60'}`}
                  />
                  <CopyButton text={link} label="Copy payment link" showCopiedText />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={share} disabled={!live}>
                  <Share2 size={14} className="mr-1.5" aria-hidden /> Share
                </Button>
                <a
                  href={live ? link : undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-disabled={!live}
                  className={`inline-flex items-center justify-center px-3 py-1.5 text-sm rounded-md min-h-[36px] border border-border bg-surface text-text-primary hover:bg-surface-alt ${live ? '' : 'pointer-events-none opacity-50'}`}
                >
                  <ExternalLink size={14} className="mr-1.5" aria-hidden /> Preview
                </a>
                <Button size="sm" variant="ghost" onClick={() => setConfirmRegen(true)}>
                  <RefreshCw size={14} className="mr-1.5" aria-hidden /> New link
                </Button>
              </div>
            </div>
          )}
        </div>
      </Modal>

      <ConfirmModal
        isOpen={confirmRegen}
        onClose={() => setConfirmRegen(false)}
        onConfirm={regenerate}
        title="Create a new link?"
        description="The current link will stop working immediately. Anyone who has it will see “unavailable” until you send them the new one."
        confirmLabel="Create new link"
      />
    </>
  )
}
