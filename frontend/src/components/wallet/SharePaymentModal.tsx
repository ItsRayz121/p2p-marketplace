'use client'
import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Share2 } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/CopyButton'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { paymentShareApi, paymentShareUrl, walletApi, type PaymentShareState, type SavedDeliveryAddress, type UserPaymentMethod } from '@/lib/api'
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
const shortAddress = (a: string) => (a.length > 22 ? `${a.slice(0, 10)}…${a.slice(-8)}` : a)

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((id) => b.has(id))

/** Owner controls for the public payment page: enable/disable, pick methods and addresses, copy/share the link. */
export function SharePaymentModal({ isOpen, onClose, methods, onSaved, label }: Props) {
  const [state, setState] = useState<PaymentShareState | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [addresses, setAddresses] = useState<SavedDeliveryAddress[]>([])
  const [selectedAddr, setSelectedAddr] = useState<Set<string>>(new Set())
  const [savedAddr, setSavedAddr] = useState<Set<string>>(new Set())

  // Only visible items can be shared — a hidden item stays private.
  const shareable = useMemo(() => methods.filter((m) => !m.hidden), [methods])
  const shareableAddr = useMemo(() => addresses.filter((a) => !a.hidden), [addresses])
  const hiddenCount = (methods.length - shareable.length) + (addresses.length - shareableAddr.length)

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setLoading(true)
    Promise.all([paymentShareApi.get(), walletApi.getSavedAddresses(false)])
      .then(([s, addrs]) => {
        if (cancelled) return
        const list = Array.isArray(addrs) ? addrs : []
        const ids = new Set(list.filter((a) => a.shared).map((a) => a.id))
        setState(s); setEnabled(s.enabled)
        setAddresses(list); setSelectedAddr(ids); setSavedAddr(ids)
      })
      .catch(() => { if (!cancelled) toast.error('Could not load your payment page settings') })
      .finally(() => { if (!cancelled) setLoading(false) })
    setSelected(new Set(shareable.filter((m) => m.shared).map((m) => m.id)))
    return () => { cancelled = true }
    // `shareable` derives from `methods`; re-sync only when the dialog (re)opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  const flip = (set: Set<string>, id: string) => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  }

  const totalItems = shareable.length + shareableAddr.length
  const totalSelected = selected.size + selectedAddr.size
  const allSelected = totalItems > 0 && totalSelected === totalItems
  const selectAll = () => {
    setSelected(new Set(allSelected ? [] : shareable.map((m) => m.id)))
    setSelectedAddr(new Set(allSelected ? [] : shareableAddr.map((a) => a.id)))
  }

  const dirty = useMemo(() => {
    if (!state) return false
    const saved = new Set(shareable.filter((m) => m.shared).map((m) => m.id))
    return enabled !== state.enabled || !sameSet(saved, selected) || !sameSet(savedAddr, selectedAddr)
  }, [state, enabled, selected, selectedAddr, savedAddr, shareable])

  const canEnable = totalSelected > 0
  // Vanity link by username; the random slug is the fallback if no username is returned.
  const handle = state?.username ?? state?.slug ?? null
  const link = handle ? paymentShareUrl(handle) : null
  const live = !!state?.enabled && !!link

  async function save() {
    if (enabled && !canEnable) { toast.error('Select at least one item to share'); return }
    setSaving(true)
    try {
      const next = await paymentShareApi.update({ enabled, methodIds: [...selected], addressIds: [...selectedAddr] })
      setState((prev) => ({ ...next, username: next.username ?? prev?.username ?? null }))
      setEnabled(next.enabled)
      setSavedAddr(new Set(selectedAddr))
      onSaved([...selected])
      toast.success(next.enabled ? 'Payment page updated' : 'Payment page turned off')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save changes')
    } finally {
      setSaving(false)
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
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Share payment details"
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
          Give people one link where they can see and copy the PKR accounts and crypto addresses you choose. Nothing is public until
          you turn this on and tick the items below.
        </p>

        <label className="flex items-center justify-between gap-3 rounded-xl border border-border px-4 py-3 cursor-pointer">
          <span>
            <span className="block text-sm font-medium text-text-primary">Public payment page</span>
            <span className="block text-xs text-text-muted">{enabled ? 'Anyone with the link can view the selected items' : 'Off — your link shows nothing'}</span>
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

        <fieldset disabled={loading} className="space-y-4">
          <div className="flex items-center justify-between">
            <legend className="text-xs font-medium text-text-muted">What to show on the page</legend>
            {totalItems > 0 && (
              <button type="button" onClick={selectAll} className="text-xs font-medium text-primary hover:underline">
                {allSelected ? 'Clear all' : 'Select all'}
              </button>
            )}
          </div>

          {totalItems === 0 && <p className="text-sm text-text-muted">You have no visible payment methods or saved addresses to share yet.</p>}

          {shareable.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-text-secondary mb-1.5">PKR payment methods</p>
              <ul className="rounded-xl border border-border divide-y divide-border overflow-hidden">
                {shareable.map((m) => (
                  <li key={m.id}>
                    <label className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-surface-alt">
                      <input type="checkbox" checked={selected.has(m.id)} onChange={() => setSelected((p) => flip(p, m.id))} className="h-4 w-4 accent-primary" />
                      <EntityLogo type={m.type === 'bank_transfer' ? 'bank' : 'payment_method'} slug={m.type === 'bank_transfer' ? (m.bankName ?? 'bank') : label(m)} size="sm" className="flex-shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-text-primary truncate">{label(m)} · {m.accountName}</span>
                        <span className="block text-xs text-text-muted truncate">{numberOf(m)}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {shareableAddr.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-text-secondary mb-1.5">Saved crypto addresses</p>
              <ul className="rounded-xl border border-border divide-y divide-border overflow-hidden">
                {shareableAddr.map((a) => (
                  <li key={a.id}>
                    <label className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-surface-alt">
                      <input type="checkbox" checked={selectedAddr.has(a.id)} onChange={() => setSelectedAddr((p) => flip(p, a.id))} className="h-4 w-4 accent-primary" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-text-primary truncate">{a.label} · {a.coin} ({a.network})</span>
                        <span className="block text-xs font-mono text-text-muted truncate">{shortAddress(a.address)}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {hiddenCount > 0 && (
            <p className="text-xs text-text-muted">{hiddenCount} hidden item{hiddenCount === 1 ? '' : 's'} can&apos;t be shared — un-hide {hiddenCount === 1 ? 'it' : 'them'} first.</p>
          )}
          {enabled && !canEnable && <p className="text-xs text-danger">Select at least one item to turn the page on.</p>}
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
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
