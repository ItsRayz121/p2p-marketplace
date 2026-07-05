'use client'
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { walletApi, ctmApi, type SavedDeliveryAddress } from '@/lib/api'
import { validateAddressForNetwork } from '@/lib/addressValidation'
import { LoadingState } from '@/components/ui/LoadingState'
import { EmptyState } from '@/components/ui/EmptyState'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { Button } from '@/components/ui/Button'
import { toast } from '@/lib/toast'
import { BookUser, Plus, Pencil, Trash2, Eye, EyeOff, Copy, Wallet } from 'lucide-react'

// Mirrors the wallet-page manager so the two surfaces share the exact same saved
// addresses. Crypto (USDT) addresses persist with coin 'USDT'; CTM-token
// addresses persist with network 'CTM' and the token symbol in `coin`.
const CTM_NETWORK = 'CTM'

const DELIVERY_NETWORKS = [
  { value: 'BEP20',   kind: 'wallet',   label: 'USDT BEP20',  placeholder: '0x… wallet address' },
  { value: 'Aptos',   kind: 'wallet',   label: 'USDT Aptos',  placeholder: '0x… Aptos address' },
  { value: 'Binance', kind: 'exchange', label: 'Binance UID', placeholder: 'Your Binance UID (8 digits)' },
  { value: 'OKX',     kind: 'exchange', label: 'OKX UID',     placeholder: 'Your OKX UID' },
  { value: 'Bitget',  kind: 'exchange', label: 'Bitget UID',  placeholder: 'Your Bitget UID' },
  { value: 'Gate',    kind: 'exchange', label: 'Gate UID',    placeholder: 'Your Gate.io UID' },
  { value: 'MEXC',    kind: 'exchange', label: 'MEXC UID',    placeholder: 'Your MEXC UID' },
  { value: 'Other',   kind: 'exchange', label: 'Other UID',   placeholder: 'Your account ID / UID' },
] as const

type DeliveryKind = 'wallet' | 'exchange'
type Category = 'crypto' | 'ctm'

const WALLET_NETWORKS_UPPER = ['BEP20', 'APTOS', 'ERC20', 'TRC20', 'POLYGON', 'ARBITRUM', 'OPTIMISM', 'BASE']

function logoFor(a: SavedDeliveryAddress) {
  if (a.network === CTM_NETWORK) return <EntityLogo type="token" slug={a.coin} size="sm" className="flex-shrink-0" />
  if (WALLET_NETWORKS_UPPER.includes(a.network.toUpperCase())) {
    return <EntityLogo type="chain" slug={a.network} size="sm" className="flex-shrink-0" />
  }
  return <EntityLogo type="exchange" slug={a.network} size="sm" className="flex-shrink-0" />
}

export default function AddressBookPage() {
  const [addresses, setAddresses] = useState<SavedDeliveryAddress[]>([])
  const [loading, setLoading] = useState(true)
  const [ctmTokens, setCtmTokens] = useState<{ symbol: string; name: string }[]>([])

  // Add-form state
  const [showForm, setShowForm] = useState(false)
  const [category, setCategory] = useState<Category>('crypto')
  const [deliveryKind, setDeliveryKind] = useState<DeliveryKind>('wallet')
  const [network, setNetwork] = useState<string>('BEP20')
  const [customExchange, setCustomExchange] = useState('')
  const [tokenSymbol, setTokenSymbol] = useState('')
  const [address, setAddress] = useState('')
  const [label, setLabel] = useState('')
  const [labelTouched, setLabelTouched] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  // Row state
  const [editId, setEditId] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [editAddress, setEditAddress] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await walletApi.getSavedAddresses(true)
      setAddresses(Array.isArray(res) ? res : [])
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [])

  const loadCtmTokens = useCallback(async () => {
    try {
      const res = await ctmApi.getTokens({ limit: 100 }) as { tokens?: Array<{ symbol?: string; name?: string }> }
      const opts = (res.tokens ?? [])
        .filter((t) => t.symbol && t.name)
        .map((t) => ({ symbol: t.symbol as string, name: t.name as string }))
      setCtmTokens(opts)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { load(); loadCtmTokens() }, [load, loadCtmTokens])

  const applyAutoLabel = (l: string) => { if (!labelTouched) setLabel(l) }

  const selectDeliveryKind = (kind: DeliveryKind) => {
    setDeliveryKind(kind)
    const first = DELIVERY_NETWORKS.find((n) => n.kind === kind)
    if (first) { setNetwork(first.value); applyAutoLabel(first.value === 'Other' ? '' : first.label) }
    setCustomExchange('')
    setFormError(null)
  }

  const selectNetwork = (value: string, lbl: string) => {
    setNetwork(value)
    if (value !== 'Other') { setCustomExchange(''); applyAutoLabel(lbl) } else applyAutoLabel('')
    setFormError(null)
  }

  const resetForm = () => {
    setCategory('crypto'); setDeliveryKind('wallet'); setNetwork('BEP20'); setCustomExchange('')
    setTokenSymbol(''); setAddress(''); setLabel(''); setLabelTouched(false); setFormError(null); setShowForm(false)
  }

  const handleAdd = async () => {
    if (category === 'ctm' && !tokenSymbol) { setFormError('Select a token'); return }
    const isOther = category === 'crypto' && deliveryKind === 'exchange' && network === 'Other'
    if (isOther && !customExchange.trim()) { setFormError('Enter the exchange name'); return }
    if (!address.trim()) { setFormError('Address / UID is required'); return }
    if (category === 'crypto' && deliveryKind === 'wallet') {
      const r = validateAddressForNetwork(address.trim(), network)
      if (!r.valid) { setFormError(r.reason ?? 'Invalid address for this network'); return }
    }
    if (!label.trim()) { setFormError('Label is required'); return }
    setAdding(true); setFormError(null)
    try {
      const exchangeNetwork = isOther ? (customExchange.trim() || 'Other') : network
      const payload = category === 'ctm'
        ? { coin: tokenSymbol, network: CTM_NETWORK, address: address.trim(), label: label.trim() }
        : { coin: 'USDT', network: exchangeNetwork, address: address.trim(), label: label.trim() }
      const saved = await walletApi.addSavedAddress(payload)
      setAddresses((prev) => [saved, ...prev])
      toast.success('Address saved')
      resetForm()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save address')
    } finally { setAdding(false) }
  }

  const startEdit = (a: SavedDeliveryAddress) => { setEditId(a.id); setEditLabel(a.label); setEditAddress(a.address) }
  const saveEdit = async (a: SavedDeliveryAddress) => {
    if (!editLabel.trim() || !editAddress.trim()) { toast.error('Label and address are required'); return }
    setEditSaving(true)
    try {
      const updated = await walletApi.updateSavedAddress(a.id, { label: editLabel.trim(), address: editAddress.trim() })
      setAddresses((prev) => prev.map((x) => (x.id === a.id ? updated : x)))
      setEditId(null); toast.success('Address updated')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update address')
    } finally { setEditSaving(false) }
  }
  const toggleHidden = async (a: SavedDeliveryAddress) => {
    setBusyId(a.id)
    try {
      const updated = await walletApi.setSavedAddressHidden(a.id, !a.hidden)
      setAddresses((prev) => prev.map((x) => (x.id === a.id ? updated : x)))
      toast.success(updated.hidden ? 'Hidden from trade auto-fill' : 'Visible again')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update visibility')
    } finally { setBusyId(null) }
  }
  const remove = async (a: SavedDeliveryAddress) => {
    if (!confirm(`Remove "${a.label}"?`)) return
    setBusyId(a.id)
    try {
      await walletApi.deleteSavedAddress(a.id)
      setAddresses((prev) => prev.filter((x) => x.id !== a.id))
      toast.success('Address removed')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove address')
    } finally { setBusyId(null) }
  }
  const copyAddr = (addr: string) => { navigator.clipboard?.writeText(addr).then(() => toast.success('Copied')).catch(() => {}) }

  const cryptoAddrs = addresses.filter((a) => a.network !== CTM_NETWORK)
  const ctmAddrs = addresses.filter((a) => a.network === CTM_NETWORK)
  const selectedNetwork = DELIVERY_NETWORKS.find((n) => n.value === network)

  const renderList = (list: SavedDeliveryAddress[]) => (
    <div className="bg-surface shadow-card rounded-xl border border-border divide-y divide-border overflow-hidden">
      {list.map((a) => (
        <div key={a.id} className={`px-4 py-3 ${a.hidden ? 'opacity-60' : ''}`}>
          {editId === a.id ? (
            <div className="space-y-2">
              <input value={editLabel} onChange={(e) => setEditLabel(e.target.value)} placeholder="Label" className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary" />
              <input value={editAddress} onChange={(e) => setEditAddress(e.target.value)} placeholder="Address / UID" className="w-full px-3 py-2 text-sm font-mono border border-border rounded-lg bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary" />
              <div className="flex gap-2">
                <Button size="sm" loading={editSaving} onClick={() => saveEdit(a)}>Save</Button>
                <Button size="sm" variant="secondary" onClick={() => setEditId(null)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              {logoFor(a)}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-text-primary text-sm truncate">{a.label}</span>
                  <span className="text-[10px] font-medium text-text-muted bg-surface-alt px-1.5 py-0.5 rounded-full">
                    {a.network === CTM_NETWORK ? a.coin : a.network}
                  </span>
                  {a.hidden && <span className="text-[10px] font-medium text-amber-600 bg-amber-500/10 px-1.5 py-0.5 rounded-full">Hidden</span>}
                </div>
                <p className="text-xs text-text-muted font-mono truncate mt-0.5">{a.address}</p>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button onClick={() => copyAddr(a.address)} title="Copy" className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-alt"><Copy size={15} /></button>
                <button onClick={() => startEdit(a)} title="Edit" className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-alt"><Pencil size={15} /></button>
                <button onClick={() => toggleHidden(a)} disabled={busyId === a.id} title={a.hidden ? 'Un-hide' : 'Hide from trade auto-fill'} className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-alt">
                  {a.hidden ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
                <button onClick={() => remove(a)} disabled={busyId === a.id} title="Remove" className="p-1.5 rounded-lg text-red-400 hover:text-red-600 hover:bg-red-500/10"><Trash2 size={15} /></button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )

  if (loading) return <LoadingState message="Loading address book..." />

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-3">
          <BookUser size={22} className="text-violet-500" />
          <h1 className="text-2xl font-bold text-text-primary">Address Book</h1>
        </div>
        {!showForm && (
          <Button size="sm" onClick={() => setShowForm(true)}><Plus size={16} className="mr-1" />Add address</Button>
        )}
      </div>
      <p className="text-sm text-text-muted mb-6">
        Save the wallet addresses, exchange UIDs and token addresses you receive to. They auto-fill when you trade — no more pasting.
      </p>

      {/* Add form */}
      {showForm && (
        <div className="bg-surface shadow-card rounded-xl border border-border p-4 mb-6 space-y-4">
          {/* Category */}
          <div className="flex gap-2">
            {(['crypto', 'ctm'] as Category[]).map((c) => (
              <button key={c} onClick={() => { setCategory(c); setFormError(null) }}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${category === c ? 'border-primary bg-primary/10 text-primary' : 'border-border text-text-secondary hover:bg-surface-alt'}`}>
                {c === 'crypto' ? 'USDT (crypto)' : 'CTM token'}
              </button>
            ))}
          </div>

          {category === 'crypto' ? (
            <>
              {/* wallet vs exchange */}
              <div className="flex gap-2">
                {([['wallet', 'On-chain wallet'], ['exchange', 'Exchange UID']] as [DeliveryKind, string][]).map(([k, lbl]) => (
                  <button key={k} onClick={() => selectDeliveryKind(k)}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${deliveryKind === k ? 'border-primary bg-primary/10 text-primary' : 'border-border text-text-secondary hover:bg-surface-alt'}`}>
                    {lbl}
                  </button>
                ))}
              </div>
              {/* network chips */}
              <div className="flex flex-wrap gap-2">
                {DELIVERY_NETWORKS.filter((n) => n.kind === deliveryKind).map((n) => (
                  <button key={n.value} onClick={() => selectNetwork(n.value, n.label)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${network === n.value ? 'border-primary bg-primary/10 text-primary' : 'border-border text-text-secondary hover:bg-surface-alt'}`}>
                    {n.label}
                  </button>
                ))}
              </div>
              {deliveryKind === 'exchange' && network === 'Other' && (
                <input value={customExchange} onChange={(e) => { setCustomExchange(e.target.value); applyAutoLabel(e.target.value) }} placeholder="Exchange name (e.g. KuCoin)" className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary" />
              )}
            </>
          ) : (
            <select value={tokenSymbol} onChange={(e) => { setTokenSymbol(e.target.value); applyAutoLabel(e.target.value ? `${e.target.value} address` : '') }} className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary">
              <option value="">Select token…</option>
              {ctmTokens.map((t) => <option key={t.symbol} value={t.symbol}>{t.name} ({t.symbol})</option>)}
            </select>
          )}

          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder={category === 'ctm' ? 'Token address / username' : (selectedNetwork?.placeholder ?? 'Address / UID')} className="w-full px-3 py-2 text-sm font-mono border border-border rounded-lg bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary" />
          <input value={label} onChange={(e) => { setLabel(e.target.value); setLabelTouched(true) }} placeholder="Label (e.g. My Binance)" className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary" />

          {formError && <p className="text-sm text-red-500">{formError}</p>}
          <div className="flex gap-2">
            <Button size="sm" loading={adding} onClick={handleAdd}>Save address</Button>
            <Button size="sm" variant="secondary" onClick={resetForm}>Cancel</Button>
          </div>
        </div>
      )}

      {addresses.length === 0 && !showForm ? (
        <EmptyState
          icon={BookUser}
          title="No saved addresses"
          description="Add the wallet addresses and exchange UIDs you receive crypto to, so they auto-fill during trades."
          action={{ label: 'Add your first address', onClick: () => setShowForm(true) }}
        />
      ) : (
        <div className="space-y-6">
          {cryptoAddrs.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-text-secondary mb-2 flex items-center gap-1.5"><Wallet size={14} /> USDT — wallets & exchanges</h2>
              {renderList(cryptoAddrs)}
            </div>
          )}
          {ctmAddrs.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-text-secondary mb-2">Community token addresses</h2>
              {renderList(ctmAddrs)}
            </div>
          )}
        </div>
      )}

      <p className="text-xs text-text-muted mt-6">
        Tip: you can also manage these from your <Link href="/wallet#saved-addresses" className="text-primary hover:underline">Wallet</Link>.
      </p>
    </div>
  )
}
