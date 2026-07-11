'use client'
import { useState, useEffect, useCallback } from 'react'
import { gasApi, type GasOrder, type GasPkrMethods } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { CopyButton } from '@/components/ui/CopyButton'
import { useFileUpload } from '@/hooks/useFileUpload'
import { UploadProgress } from '@/components/ui/UploadProgress'

// Actionable section for the order tracking page: lets a user RESUME an unpaid order
// (upload PKR proof / see the crypto payment instructions) and CANCEL it — instead of
// abandoning it and starting a fresh order. Self-contained (no GasContext) so it can
// live on the standalone tracking page the user lands on after leaving the checkout.

const PKR_METHOD_LABELS: Record<string, string> = {
  bank_transfer: 'Bank Transfer',
  easypaisa: 'Easypaisa',
  jazzcash: 'JazzCash',
  nayapay: 'NayaPay',
  sadapay: 'SadaPay',
}

function pkrDetails(method: string, m: GasPkrMethods): { label: string; value: string }[] {
  if (method === 'bank_transfer') {
    return [
      { label: 'Bank Name', value: m.bank.bankName ?? '' },
      { label: 'Account Name', value: m.bank.accountName ?? '' },
      { label: 'IBAN', value: m.bank.iban ?? '' },
      { label: 'Account Number', value: m.bank.accountNumber ?? '' },
    ].filter((r) => r.value)
  }
  const w = m[method as 'easypaisa' | 'jazzcash' | 'nayapay' | 'sadapay']
  return [
    { label: 'Account Name', value: w?.name ?? '' },
    { label: 'Mobile Number', value: w?.number ?? '' },
  ].filter((r) => r.value)
}

export function GasOrderActions({ order, trackingToken, onChanged }: {
  order: GasOrder
  trackingToken?: string
  onChanged: () => void
}) {
  const isPkr = order.paymentCoin === 'PKR'
  const { upload, uploading, progress } = useFileUpload('payment-proof')

  // ── PKR proof state ──
  const [pkrMethods, setPkrMethods] = useState<GasPkrMethods | null>(null)
  const [proofUrl, setProofUrl] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // ── Cancel state ──
  const [preview, setPreview] = useState<{ cancellable: boolean; cooldownLabel: string | null } | null>(null)
  const [cancelling, setCancelling] = useState(false)

  const loadPreview = useCallback(async () => {
    try { setPreview(await gasApi.getCancelPreview(order.orderRef, trackingToken)) }
    catch { /* non-fatal — hide cancel if preview fails */ }
  }, [order.orderRef, trackingToken])

  useEffect(() => {
    if (order.status !== 'payment_pending') return
    void loadPreview()
    if (isPkr) gasApi.getPkrMethods().then(setPkrMethods).catch(() => {})
  }, [order.status, isPkr, loadPreview])

  // Only the unpaid state is actionable here.
  if (order.status !== 'payment_pending') return null

  const handleUpload = async (file: File) => {
    setUploadError('')
    try { setProofUrl(await upload(file)) }
    catch (e) { setUploadError(e instanceof Error ? e.message : 'Upload failed') }
  }

  const handleSubmitProof = async () => {
    if (!proofUrl) return
    setSubmitting(true)
    try {
      await gasApi.submitProof(order.orderRef, proofUrl)
      toast.success('Payment proof submitted — under review')
      onChanged()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to submit proof') }
    finally { setSubmitting(false) }
  }

  const handleCancel = async () => {
    const msg = preview?.cooldownLabel
      ? `Cancel this order? Cancelling again soon will trigger a ${preview.cooldownLabel} cooldown before you can order again.`
      : 'Cancel this order? You can create a new one afterwards.'
    if (!window.confirm(msg)) return
    setCancelling(true)
    try {
      await gasApi.cancelOrder(order.orderRef, trackingToken)
      toast.success('Order cancelled')
      onChanged()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to cancel') }
    finally { setCancelling(false) }
  }

  const amountLabel = isPkr
    ? `PKR ${order.pkrAmount ? parseFloat(order.pkrAmount).toFixed(0) : '—'}`
    : `${parseFloat(order.paymentAmount).toFixed(4)} USDT`

  return (
    <div className="bg-surface shadow-card rounded-xl border border-border p-5 space-y-4">
      <h2 className="text-xs font-bold text-text-muted uppercase tracking-wider">Complete your payment</h2>

      {isPkr ? (
        <>
          {/* PKR: where + how much to send, then upload proof */}
          <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-4 space-y-3">
            <p className="text-sm font-bold text-text-primary">Send via {PKR_METHOD_LABELS[order.pkrPaymentMethod ?? ''] ?? order.pkrPaymentMethod}</p>
            <div className="bg-surface rounded-xl p-3 flex items-center justify-between">
              <span className="text-xs text-text-muted">Amount to Send</span>
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold text-green-700 dark:text-green-300">{amountLabel}</span>
                <CopyButton text={String(order.pkrAmount ? parseFloat(order.pkrAmount).toFixed(0) : '')} />
              </div>
            </div>
            {!pkrMethods ? (
              <p className="text-xs text-text-muted">Loading payment account…</p>
            ) : pkrDetails(order.pkrPaymentMethod ?? '', pkrMethods).length === 0 ? (
              <p className="text-xs text-amber-600 dark:text-amber-400">Payment account details not configured. Please contact support.</p>
            ) : (
              <div className="space-y-2">
                {pkrDetails(order.pkrPaymentMethod ?? '', pkrMethods).map(({ label, value }) => (
                  <div key={label} className="bg-surface rounded-xl px-3 py-2.5 flex items-center justify-between">
                    <span className="text-xs text-text-muted">{label}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-text-primary font-mono">{value}</span>
                      <CopyButton text={value} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <p className="text-xs font-semibold text-text-secondary mb-2">Upload payment screenshot</p>
            <label className={`flex flex-col items-center justify-center gap-2 h-28 rounded-xl border-2 border-dashed cursor-pointer transition-colors ${proofUrl ? 'border-green-500/50 bg-green-500/10' : 'border-border hover:border-primary/30 bg-surface-alt'}`}>
              <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleUpload(f) }} />
              {uploading
                ? <><Spinner size="md" /><p className="text-xs text-text-muted">Uploading…</p></>
                : proofUrl
                ? <><svg className="w-7 h-7 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg><p className="text-xs text-green-600 dark:text-green-400 font-semibold">Screenshot uploaded — click to replace</p></>
                : <><svg className="w-7 h-7 text-text-disabled" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg><p className="text-xs text-text-muted">Click to upload screenshot</p></>
              }
            </label>
            {uploading && progress && <UploadProgress progress={progress} className="mt-2" />}
            {uploadError && <p className="text-xs text-red-500 mt-1">{uploadError}</p>}
          </div>

          <Button className="w-full" disabled={!proofUrl || submitting} loading={submitting} onClick={handleSubmitProof}>
            {submitting ? 'Submitting…' : 'I have sent the payment — submit proof'}
          </Button>
        </>
      ) : (
        <>
          {/* Crypto: send the exact USDT amount to the address; detection is automatic */}
          <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 space-y-3">
            <div className="bg-surface rounded-xl p-3 flex items-center justify-between">
              <span className="text-xs text-text-muted">Send exactly</span>
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold text-text-primary">{amountLabel}</span>
                <CopyButton text={parseFloat(order.paymentAmount).toFixed(4)} />
              </div>
            </div>
            <div className="bg-surface rounded-xl px-3 py-2.5">
              <p className="text-xs text-text-muted mb-1">{order.paymentNetwork} deposit address</p>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-mono text-text-primary break-all">{order.paymentAddress || '—'}</span>
                {order.paymentAddress && <CopyButton text={order.paymentAddress} size="sm" />}
              </div>
            </div>
            <p className="text-xs text-text-muted">Send the exact amount on the <strong>{order.paymentNetwork}</strong> network. We detect your payment automatically — this page updates within a couple of minutes.</p>
          </div>
        </>
      )}

      {/* Cancel — only while still cancellable (payment_pending, no tx claimed) */}
      {preview?.cancellable && (
        <Button variant="secondary" className="w-full" disabled={cancelling} loading={cancelling} onClick={handleCancel}>
          {cancelling ? 'Cancelling…' : 'Cancel this order'}
        </Button>
      )}
    </div>
  )
}
