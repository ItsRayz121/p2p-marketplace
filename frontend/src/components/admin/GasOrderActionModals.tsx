'use client'
import { useEffect, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/CopyButton'

const FIELD = 'w-full px-3 py-2 rounded-lg border border-border bg-surface text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2'

// ─── Reject payment proof ──────────────────────────────────────────────────────

interface RejectProofModalProps {
  isOpen: boolean
  onClose: () => void
  orderRef: string
  /** 'exchange transfer' | 'PKR payment proof' */
  subject: string
  onConfirm: (reason: string) => Promise<void>
}

export function RejectProofModal({ isOpen, onClose, orderRef, subject, onConfirm }: RejectProofModalProps) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (!isOpen) { setReason(''); setBusy(false) } }, [isOpen])
  const valid = reason.trim().length >= 3

  async function submit() {
    if (!valid || busy) return
    setBusy(true)
    try { await onConfirm(reason.trim()) } finally { setBusy(false) }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => { if (!busy) onClose() }}
      title={`Reject ${subject}`}
      size="sm"
      footer={
        <div className="flex gap-3 justify-end">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>Back</Button>
          <Button variant="danger" size="sm" loading={busy} disabled={!valid} onClick={submit}>Reject</Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-text-muted">
          Reject the {subject} for order <span className="font-mono font-medium text-text-primary">{orderRef}</span>.
          The order is closed as <strong>cancelled</strong>, no gas is sent, and the customer is notified with your reason.
        </p>
        <div>
          <label htmlFor="reject-reason" className="block text-xs font-medium text-text-muted mb-1">Reason (shown to the customer)</label>
          <textarea
            id="reject-reason"
            rows={3}
            maxLength={300}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Payment not found in our account, amount does not match…"
            className={`${FIELD} focus:ring-danger resize-none`}
          />
        </div>
      </div>
    </Modal>
  )
}

// ─── Manual delivery ───────────────────────────────────────────────────────────

interface ManualDeliveryModalProps {
  isOpen: boolean
  onClose: () => void
  orderRef: string
  chainName: string
  assetSymbol: string
  amount: string
  toAddress: string
  onConfirm: (data: { txHash: string; note?: string }) => Promise<void>
}

export function ManualDeliveryModal({ isOpen, onClose, orderRef, chainName, assetSymbol, amount, toAddress, onConfirm }: ManualDeliveryModalProps) {
  const [step, setStep] = useState<'form' | 'confirm'>('form')
  const [txHash, setTxHash] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (!isOpen) { setStep('form'); setTxHash(''); setNote(''); setBusy(false) } }, [isOpen])

  const hash = txHash.trim()
  const hashValid = hash.length >= 20 && hash.length <= 128 && /^[A-Za-z0-9+/=_\-:.]+$/.test(hash)

  async function submit() {
    if (!hashValid || busy) return
    setBusy(true)
    try { await onConfirm({ txHash: hash, ...(note.trim() ? { note: note.trim() } : {}) }) } finally { setBusy(false) }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => { if (!busy) onClose() }}
      title="Manual Delivery"
      size="md"
      footer={
        step === 'form' ? (
          <div className="flex gap-3 justify-end">
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button variant="primary" size="sm" disabled={!hashValid} onClick={() => setStep('confirm')}>Continue</Button>
          </div>
        ) : (
          <div className="flex gap-3 justify-end">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setStep('form')}>Back</Button>
            <Button variant="primary" size="sm" loading={busy} onClick={submit}>Confirm manual delivery</Button>
          </div>
        )
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-border divide-y divide-border text-sm">
          <Row label="Order" value={<span className="font-mono">{orderRef}</span>} />
          <Row label="Chain" value={chainName} />
          <Row label="Token / gas asset" value={assetSymbol} />
          <Row label="Required amount" value={<strong>{amount} {assetSymbol}</strong>} />
          <Row
            label="Destination wallet"
            value={
              <span className="inline-flex items-center gap-1.5">
                <span className="font-mono text-xs break-all">{toAddress}</span>
                <CopyButton text={toAddress} size="sm" />
              </span>
            }
          />
        </div>

        {step === 'form' ? (
          <>
            <p className="text-xs text-text-muted">
              Send the gas yourself from an external wallet to the address above, then record the transaction here.
              RupChain does not send anything in this flow.
            </p>
            <div>
              <label htmlFor="manual-tx" className="block text-xs font-medium text-text-muted mb-1">Transaction hash <span className="text-danger">*</span></label>
              <input
                id="manual-tx"
                type="text"
                value={txHash}
                onChange={(e) => setTxHash(e.target.value)}
                placeholder="Hash of the transfer you sent"
                autoComplete="off"
                spellCheck={false}
                className={`${FIELD} font-mono focus:ring-primary`}
              />
              {hash.length > 0 && !hashValid && <p className="text-xs text-danger mt-1">Enter the full transaction hash (20–128 characters, no spaces).</p>}
            </div>
            <div>
              <label htmlFor="manual-note" className="block text-xs font-medium text-text-muted mb-1">Internal note <span className="font-normal">(optional, admins only)</span></label>
              <input
                id="manual-note"
                type="text"
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. Hot wallet empty — sent from treasury"
                className={`${FIELD} focus:ring-primary`}
              />
            </div>
          </>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-surface-alt p-3 text-xs">
              <p className="text-text-muted">Transaction hash</p>
              <p className="font-mono break-all text-text-primary mt-0.5">{hash}</p>
            </div>
            <p className="text-sm font-medium text-text-primary rounded-lg bg-warning/10 border border-warning/30 p-3">
              Confirm that the gas has already been sent externally to this address.
              The order will be marked <strong>delivered</strong> and cannot be delivered, retried or refunded again.
            </p>
          </div>
        )}
      </div>
    </Modal>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start gap-0.5 sm:gap-4 px-3 py-2">
      <span className="sm:w-40 shrink-0 text-text-muted">{label}</span>
      <span className="text-text-primary min-w-0">{value}</span>
    </div>
  )
}
