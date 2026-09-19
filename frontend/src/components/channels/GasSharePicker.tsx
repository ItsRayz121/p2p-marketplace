'use client'
import { useEffect, useState } from 'react'
import { gasApi, type GasChain } from '@/lib/api'
import { buildGasShareLinks } from '@/lib/telegram'
import { useAuth } from '@/hooks/useAuth'
import { Modal } from '@/components/ui/Modal'
import { EntityLogo } from '@/components/ui/EntityLogo'

/**
 * Lets a channel owner post one chain's gas-fee page straight into the
 * broadcast — reuses the same universal link ShareGasButton builds
 * (rupchain.com/gas/<chain>, referral code riding along), just posted as
 * channel text instead of the native share sheet.
 */
export function GasSharePicker({
  isOpen,
  onClose,
  onSelect,
  sharing,
}: {
  isOpen: boolean
  onClose: () => void
  onSelect: (message: string) => void
  sharing: boolean
}) {
  const { user } = useAuth()
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

  function pick(chain: GasChain) {
    const { web } = buildGasShareLinks(chain.slug, undefined, user?.referralCode)
    onSelect(`⛽ ${chain.name} gas fees — buy instantly with JazzCash, Easypaisa or USDT: ${web}`)
  }

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
              onClick={() => pick(c)}
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
