'use client'
import { useState } from 'react'
import { walletApi } from '@/lib/api'
import type { SavedDeliveryAddress } from '@/lib/api'

// Inline "save this address" control shown beneath an address/UID input.
// CTM token addresses (the default) are stored with network='CTM' and
// coin=<token symbol>; USDT payment accounts pass network=<method value>
// (BEP20/Binance/OKX/…) with coin='USDT' — the same address book the
// tap-to-fill chips read (network === method). Renders nothing when the
// field is empty or the address is already saved.
export function SaveAddressInline({
  address, coin, network = 'CTM', noun, saved, onSaved,
}: {
  address: string
  coin: string
  /** Saved-address network key. 'CTM' (default) for community tokens; the USDT method value otherwise. */
  network?: string
  /** What the button calls the value (defaults to "<coin> address"), e.g. "Binance UID". */
  noun?: string
  saved: SavedDeliveryAddress[]
  onSaved: (a: SavedDeliveryAddress) => void
}) {
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const trimmed = address.trim()
  const already = saved.some((a) => a.network === network && a.coin === coin && a.address === trimmed)
  if (!trimmed || already) return null

  const handleSave = async () => {
    if (!label.trim()) return
    setSaving(true); setErr('')
    try {
      const created = await walletApi.addSavedAddress({ coin, network, address: trimmed, label: label.trim() })
      onSaved(created)
      setOpen(false); setLabel('')
    } catch (e) {
      setErr((e as Error).message ?? 'Failed to save address')
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-1.5 text-xs font-medium text-primary hover:underline">
        ＋ Save this {noun ?? `${coin} address`} for reuse
      </button>
    )
  }

  return (
    <div className="mt-2 space-y-1">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={`Label (e.g. My ${noun ?? `${coin} wallet`})`}
          maxLength={40}
          className="flex-1 border border-border rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        <button type="button" onClick={handleSave} disabled={saving || !label.trim()}
          className="px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={() => { setOpen(false); setLabel('') }} className="px-2 py-1.5 text-xs text-text-muted hover:text-text-primary">
          Cancel
        </button>
      </div>
      {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
    </div>
  )
}
