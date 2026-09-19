'use client'
import { useEffect, useState } from 'react'
import { gasApi, type GasChain } from '@/lib/api'
import { Modal } from '@/components/ui/Modal'
import { EntityLogo } from '@/components/ui/EntityLogo'

/**
 * Lets a channel owner (or DM sender) post one chain's gas-fee page as a rich
 * card — mirrors ShareAdPicker: the caller passes back the chain slug, which
 * the backend resolves live into a sharedGas card (icon, name, buy-with-PKR/
 * USDT), same as a shared listing.
 */
export function GasSharePicker({
  isOpen,
  onClose,
  onSelect,
  sharing,
}: {
  isOpen: boolean
  onClose: () => void
  onSelect: (chain: GasChain) => void
  sharing: boolean
}) {
  const [chains, setChains] = useState<GasChain[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isOpen) return
    setChains(null)
    setError('')
    gasApi.getChains()
      .then((res) => setChains(res.chains.filter((c) => c.isAvailable)))
      .catch(() => setError('Failed to load gas chains'))
  }, [isOpen])

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Share gas fees">
      <div className="space-y-2 max-h-[60vh] overflow-y-auto">
        {chains === null ? (
          <p className="text-sm text-text-muted py-6 text-center">Loading chains…</p>
        ) : error ? (
          <p className="text-sm text-danger py-6 text-center">{error}</p>
        ) : chains.length === 0 ? (
          <p className="text-sm text-text-muted py-6 text-center">No gas chains available right now.</p>
        ) : (
          chains.map((c) => (
            <button
              key={c.id}
              type="button"
              disabled={sharing}
              onClick={() => onSelect(c)}
              className="w-full flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary/40 transition-colors text-left disabled:opacity-50"
            >
              <EntityLogo type="chain" slug={c.slug} size="sm" logoUrl={c.logoUrl} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-text-primary truncate">{c.name}</p>
                <p className="text-xs text-text-muted">{c.networkLabel}</p>
              </div>
            </button>
          ))
        )}
      </div>
    </Modal>
  )
}
