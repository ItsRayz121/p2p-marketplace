'use client'
import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Modal } from './Modal'
import { Button } from './Button'
import { CopyButton } from './CopyButton'

interface ConfirmRemoveModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => Promise<void> | void
  /** Modal heading. */
  title?: string
  /** Short human label for the item being removed (e.g. "MetaMask · BEP20"). */
  itemLabel: string
  /** The exact value the user must copy + paste back to confirm (e.g. the address). */
  confirmValue: string
  /** Optional extra warning line shown under the heading. */
  warning?: string
  confirmLabel?: string
}

/**
 * High-friction removal confirmation. Beyond a yes/no prompt, the user must
 * copy the item's identifying value (address / account number) and paste it
 * back before the destructive action is enabled — preventing accidental,
 * one-tap removals of saved addresses and payment methods.
 */
export function ConfirmRemoveModal({
  isOpen,
  onClose,
  onConfirm,
  title = 'Remove this item?',
  itemLabel,
  confirmValue,
  warning,
  confirmLabel = 'Remove',
}: ConfirmRemoveModalProps) {
  const [typed, setTyped] = useState('')
  const [loading, setLoading] = useState(false)

  // Reset the paste field whenever the modal (re)opens or the target changes.
  useEffect(() => {
    if (isOpen) setTyped('')
  }, [isOpen, confirmValue])

  const matches = typed.trim().toLowerCase() === confirmValue.trim().toLowerCase() && confirmValue.trim() !== ''

  async function handleConfirm() {
    if (!matches) return
    setLoading(true)
    try {
      await onConfirm()
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="sm">
      <div className="space-y-4">
        <div className="flex items-start gap-2.5 rounded-lg bg-danger/10 border border-danger/20 px-3 py-2.5">
          <AlertTriangle size={16} className="text-danger flex-shrink-0 mt-0.5" aria-hidden />
          <p className="text-sm text-text-secondary">
            You are about to remove <span className="font-semibold text-text-primary">{itemLabel}</span>.
            {warning ? ` ${warning}` : ' This cannot be undone.'}
          </p>
        </div>

        <div>
          <p className="text-xs font-medium text-text-muted mb-1">Copy this value</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 text-xs font-mono break-all rounded-lg border border-border bg-surface text-text-primary">
              {confirmValue}
            </code>
            <CopyButton text={confirmValue} />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-text-muted mb-1">
            Paste it here to confirm
          </label>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Paste the value above"
            autoComplete="off"
            spellCheck={false}
            className="w-full px-3 py-2 text-xs font-mono border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-danger/40"
          />
          {typed.trim() !== '' && !matches && (
            <p className="mt-1 text-xs text-danger">That doesn&apos;t match — copy and paste the exact value above.</p>
          )}
        </div>

        <div className="flex gap-3 justify-end pt-1">
          <Button variant="secondary" size="md" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="md"
            loading={loading}
            disabled={!matches}
            onClick={handleConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
