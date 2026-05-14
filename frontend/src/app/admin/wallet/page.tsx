'use client'
import { useState, useCallback, useEffect } from 'react'
import { adminApi } from '@/lib/api'
import { fmtDate, fmtDateTime } from '@/lib/fmt'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'

interface WalletAddress {
  coin: string
  network: string
  address: string
  updatedAt?: string
}

interface PendingWithdrawal {
  id: string
  userId: string
  user?: { email: string; username: string }
  coin: string
  amount: string
  address: string
  network: string
  status: string
  createdAt: string
}

export default function WalletPage() {
  const [addresses, setAddresses] = useState<WalletAddress[]>([])
  const [payouts, setPayouts] = useState<PendingWithdrawal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editKey, setEditKey] = useState<string | null>(null)
  const [editAddress, setEditAddress] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const [addrData, payoutData] = await Promise.all([
        adminApi.getWalletAddresses() as Promise<{ addresses: WalletAddress[] }>,
        adminApi.getWithdrawals({ status: 'approved' }) as Promise<{ withdrawals: PendingWithdrawal[]; pagination: { total: number } }>,
      ])
      setAddresses(addrData.addresses ?? (Array.isArray(addrData) ? addrData as WalletAddress[] : []))
      setPayouts(payoutData.withdrawals ?? [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load wallet data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  function startEdit(coin: string, network: string, address: string) {
    setEditKey(`${coin}_${network}`)
    setEditAddress(address)
    setSaveError(null)
    setSaveSuccess(null)
  }

  async function saveAddress(coin: string, network: string) {
    setSaving(true)
    setSaveError(null)
    try {
      await adminApi.updateWalletAddress({ coin, network, address: editAddress })
      setAddresses((prev) =>
        prev.map((a) => (a.coin === coin && a.network === network ? { ...a, address: editAddress } : a))
      )
      setSaveSuccess(`${coin} (${network}) address updated.`)
      setEditKey(null)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to update address')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <LoadingState message="Loading wallet data..." />
  if (error && addresses.length === 0) return <ErrorState title={error} onRetry={fetchData} />

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Hot Wallet Management</h1>
        <p className="text-text-muted text-sm mt-0.5">Manage deposit addresses and monitor pending payouts</p>
      </div>

      {saveSuccess && (
        <div className="px-4 py-3 bg-success/10 border border-success/20 rounded-xl text-success text-sm">
          {saveSuccess}
        </div>
      )}

      {/* Wallet Addresses */}
      <div className="bg-white rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-semibold text-text-primary">Deposit Addresses</h2>
          <span className="text-text-muted text-sm">{addresses.length} coins</span>
        </div>

        {addresses.length === 0 ? (
          <div className="p-8">
            <EmptyState title="No addresses configured" description="Add deposit addresses via config." />
          </div>
        ) : (
          <div className="divide-y divide-border">
            {addresses.map((addr) => {
              const key = `${addr.coin}_${addr.network}`
              const isEditing = editKey === key
              return (
                <div key={key} className="px-5 py-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold text-text-primary">{addr.coin}</span>
                        <Badge variant="outline" size="sm">{addr.network}</Badge>
                      </div>
                      {isEditing ? (
                        <div className="flex gap-2 mt-2">
                          <input
                            value={editAddress}
                            onChange={(e) => setEditAddress(e.target.value)}
                            className="flex-1 px-3 py-1.5 border border-border rounded-lg text-sm font-mono text-text-primary bg-white focus:outline-none focus:ring-2 focus:ring-primary"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveAddress(addr.coin, addr.network)
                              if (e.key === 'Escape') setEditKey(null)
                            }}
                          />
                          <Button size="sm" loading={saving} onClick={() => saveAddress(addr.coin, addr.network)}>Save</Button>
                          <Button size="sm" variant="secondary" onClick={() => setEditKey(null)} disabled={saving}>Cancel</Button>
                        </div>
                      ) : (
                        <p className="font-mono text-xs text-text-secondary break-all">{addr.address || 'Not set'}</p>
                      )}
                      {addr.updatedAt && !isEditing && (
                        <p className="text-xs text-text-muted mt-1">Updated {fmtDateTime(addr.updatedAt)}</p>
                      )}
                      {isEditing && saveError && (
                        <p className="text-danger text-xs mt-1">{saveError}</p>
                      )}
                    </div>
                    {!isEditing && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => startEdit(addr.coin, addr.network, addr.address)}
                      >
                        Edit
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Pending Payouts */}
      <div className="bg-white rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-semibold text-text-primary">Approved Payouts</h2>
          <span className="text-text-muted text-sm">{payouts.length} pending</span>
        </div>

        {payouts.length === 0 ? (
          <div className="p-8">
            <EmptyState title="No approved payouts" description="No withdrawals are currently approved and awaiting execution." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">User</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Coin</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Amount</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Network</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Destination</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {payouts.map((p) => (
                  <tr key={p.id} className="hover:bg-surface/50">
                    <td className="px-4 py-3">
                      <p className="font-medium text-text-primary">{p.user?.username}</p>
                      <p className="text-xs text-text-muted">{p.user?.email}</p>
                    </td>
                    <td className="px-4 py-3 font-medium text-text-primary">{p.coin}</td>
                    <td className="px-4 py-3 font-semibold text-text-primary">{p.amount}</td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" size="sm">{p.network}</Badge>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-text-secondary">
                      {p.address.slice(0, 10)}...{p.address.slice(-6)}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{fmtDate(p.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

