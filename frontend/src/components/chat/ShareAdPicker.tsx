'use client'
import { useEffect, useState } from 'react'
import { adsApi, ctmApi } from '@/lib/api'
import { Modal } from '@/components/ui/Modal'
import { EntityLogo } from '@/components/ui/EntityLogo'

interface PickerItem {
  market: 'usdt' | 'ctm'
  id: string
  side: 'buy' | 'sell'
  symbol: string
  name: string
  logoUrl: string | null
  price: string
  network?: string | null
}

interface CtmListingLite {
  id: string
  side: string
  status: string
  pricePerUnit: string
  token: { symbol: string; name: string; logoUrl?: string }
}

/** One-tap "share my listing" — lets the sender pick one of their OWN active
 *  USDT ads or CTM listings to drop straight into the chat as a rich card the
 *  recipient can tap through to (see sharedAd on ThreadMessage). */
export function ShareAdPicker({
  isOpen,
  onClose,
  onSelect,
  sharing,
}: {
  isOpen: boolean
  onClose: () => void
  onSelect: (item: { market: 'usdt' | 'ctm'; id: string }) => void
  sharing: boolean
}) {
  const [items, setItems] = useState<PickerItem[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isOpen) return
    setItems(null)
    setError('')
    Promise.allSettled([
      adsApi.getMyAds({ status: 'active', limit: 50 }),
      ctmApi.getMyListings(),
    ]).then(([adsRes, listingsRes]) => {
      const usdt: PickerItem[] =
        adsRes.status === 'fulfilled'
          ? adsRes.value.items.map((a) => ({
              market: 'usdt' as const, id: a.id, side: a.side, symbol: a.coin, name: a.coin,
              logoUrl: null, price: a.price, network: a.network,
            }))
          : []
      const ctmListings =
        listingsRes.status === 'fulfilled'
          ? (listingsRes.value as { listings: CtmListingLite[] }).listings
          : []
      const ctm: PickerItem[] = ctmListings
        .filter((l) => l.status === 'active')
        .map((l) => ({
          market: 'ctm' as const, id: l.id, side: l.side === 'buy' ? 'buy' : 'sell',
          symbol: l.token.symbol, name: l.token.name, logoUrl: l.token.logoUrl ?? null, price: l.pricePerUnit,
        }))
      setItems([...usdt, ...ctm])
    }).catch(() => setError('Failed to load your listings'))
  }, [isOpen])

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Share a listing">
      <div className="space-y-2 max-h-[60vh] overflow-y-auto">
        {items === null ? (
          <p className="text-sm text-text-muted py-6 text-center">Loading your listings…</p>
        ) : error ? (
          <p className="text-sm text-danger py-6 text-center">{error}</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-text-muted py-6 text-center">You don&apos;t have any active listings to share yet.</p>
        ) : (
          items.map((it) => (
            <button
              key={`${it.market}:${it.id}`}
              type="button"
              disabled={sharing}
              onClick={() => onSelect({ market: it.market, id: it.id })}
              className="w-full flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary/40 transition-colors text-left disabled:opacity-50"
            >
              <EntityLogo type="token" slug={it.symbol} size="sm" logoUrl={it.logoUrl} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-text-primary truncate">{it.name} ({it.symbol})</p>
                <p className="text-xs text-text-muted">
                  {it.side === 'sell' ? 'Selling' : 'Buying'} · PKR {Number(it.price).toLocaleString()}
                  {it.market === 'usdt' && it.network ? ` · ${it.network}` : ''}
                </p>
              </div>
              <span className="text-[10px] font-bold uppercase text-text-muted bg-surface-alt px-1.5 py-0.5 rounded flex-shrink-0">{it.market}</span>
            </button>
          ))
        )}
      </div>
    </Modal>
  )
}
