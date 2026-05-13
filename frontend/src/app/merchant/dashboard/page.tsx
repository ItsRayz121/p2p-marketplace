'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { apiRequest, ApiError } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageContainer } from '@/components/layout/PageContainer'

// ─── Types ────────────────────────────────────────────────────────────────────

interface MerchantStats {
  totalTrades: number
  completedTrades: number
  completionRate: number
  totalVolumePKR: string
  avgRating: number
}

interface InventoryItem {
  id: string
  coin: string
  network: string
  price: string
  availableAmount: string
  minAmount: string
  maxAmount: string
  status: 'active' | 'inactive' | 'paused'
}

interface RecentTrade {
  id: string
  status: 'pending' | 'paid' | 'released' | 'disputed' | 'cancelled' | 'expired'
  buyerUsername: string
  coinAmount: string
  coin: string
  pkrAmount: string
  createdAt: string
}

interface MerchantProfile {
  id: string
  businessName: string
  rank: string
  isActive: boolean
  spreadBps: number
  maxSpreadBps: number
}

interface DashboardData {
  profile: MerchantProfile
  stats: MerchantStats
  inventory: InventoryItem[]
  recentTrades: RecentTrade[]
}

// ─── Helper components ────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-white rounded-xl border border-border p-4">
      <p className="text-xs text-text-muted mb-1">{label}</p>
      <p className="text-xl font-bold text-text-primary">{value}</p>
      {sub && <p className="text-xs text-text-secondary mt-0.5">{sub}</p>}
    </div>
  )
}

function StarRating({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <svg
          key={star}
          className={`w-3.5 h-3.5 ${star <= Math.round(rating) ? 'text-gold' : 'text-border'}`}
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      ))}
    </span>
  )
}

function tradeStatusVariant(status: RecentTrade['status']): 'success' | 'warning' | 'danger' | 'default' {
  if (status === 'released') return 'success'
  if (status === 'paid' || status === 'pending') return 'warning'
  if (status === 'disputed' || status === 'cancelled' || status === 'expired') return 'danger'
  return 'default'
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-PK', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ─── Add Inventory Modal ──────────────────────────────────────────────────────

interface AddInventoryModalProps {
  isOpen: boolean
  onClose: () => void
  onAdded: () => void
}

function AddInventoryModal({ isOpen, onClose, onAdded }: AddInventoryModalProps) {
  const [form, setForm] = useState({ coin: 'USDT', network: 'TRC20', price: '', amount: '', minAmount: '', maxAmount: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  function handleChange(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }))
    setError('')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.price || !form.amount || !form.minAmount || !form.maxAmount) {
      setError('All fields are required.')
      return
    }
    setLoading(true)
    try {
      await apiRequest('/merchants/inventory', {
        method: 'POST',
        body: JSON.stringify({
          coin: form.coin,
          network: form.network,
          price: form.price,
          availableAmount: form.amount,
          minAmount: form.minAmount,
          maxAmount: form.maxAmount,
        }),
      })
      setForm({ coin: 'USDT', network: 'TRC20', price: '', amount: '', minAmount: '', maxAmount: '' })
      onAdded()
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add inventory.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Inventory">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-primary">Coin</label>
            <select
              className="w-full rounded-lg border border-border bg-white text-text-primary px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              value={form.coin}
              onChange={(e) => handleChange('coin', e.target.value)}
            >
              <option value="USDT">USDT</option>
              <option value="BTC">BTC</option>
              <option value="ETH">ETH</option>
              <option value="BNB">BNB</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-primary">Network</label>
            <select
              className="w-full rounded-lg border border-border bg-white text-text-primary px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              value={form.network}
              onChange={(e) => handleChange('network', e.target.value)}
            >
              <option value="TRC20">TRC20</option>
              <option value="ERC20">ERC20</option>
              <option value="BEP20">BEP20</option>
              <option value="BTC">Bitcoin</option>
            </select>
          </div>
        </div>
        <Input
          label="Price (PKR per unit)"
          type="number"
          min="0"
          step="0.01"
          placeholder="e.g. 285"
          value={form.price}
          onChange={(e) => handleChange('price', e.target.value)}
        />
        <Input
          label="Available Amount"
          type="number"
          min="0"
          step="0.000001"
          placeholder="e.g. 500"
          value={form.amount}
          onChange={(e) => handleChange('amount', e.target.value)}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Min Amount"
            type="number"
            min="0"
            step="0.000001"
            placeholder="e.g. 10"
            value={form.minAmount}
            onChange={(e) => handleChange('minAmount', e.target.value)}
          />
          <Input
            label="Max Amount"
            type="number"
            min="0"
            step="0.000001"
            placeholder="e.g. 500"
            value={form.maxAmount}
            onChange={(e) => handleChange('maxAmount', e.target.value)}
          />
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex gap-3 justify-end pt-1">
          <Button type="button" variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button type="submit" loading={loading}>
            Add Inventory
          </Button>
        </div>
      </form>
    </Modal>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function MerchantDashboardPage() {
  const { user, isLoading: authLoading } = useAuth()
  const router = useRouter()

  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Spread edit state
  const [editingSpread, setEditingSpread] = useState(false)
  const [spreadInput, setSpreadInput] = useState('')
  const [spreadError, setSpreadError] = useState('')
  const [spreadSaving, setSpreadSaving] = useState(false)

  // Inventory modal
  const [showAddInventory, setShowAddInventory] = useState(false)

  // Delete inventory
  const [deleteTarget, setDeleteTarget] = useState<InventoryItem | null>(null)

  // Activate
  const [activating, setActivating] = useState(false)
  const [activateError, setActivateError] = useState('')

  // Refresh indicator
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    else setRefreshing(true)
    setError('')
    try {
      const dashboard = await apiRequest<DashboardData>('/merchants/dashboard')
      setData(dashboard)
    } catch (err) {
      if (!quiet) setError(err instanceof ApiError ? err.message : 'Failed to load dashboard.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    if (authLoading) return
    if (!user) {
      router.replace('/login')
      return
    }
    if (user.role !== 'merchant') {
      router.replace('/merchant-apply')
      return
    }
    load()
  }, [authLoading, user, router, load])

  async function handleActivate() {
    setActivating(true)
    setActivateError('')
    try {
      await apiRequest('/merchants/activate', { method: 'POST' })
      await load(true)
    } catch (err) {
      setActivateError(err instanceof ApiError ? err.message : 'Activation failed.')
    } finally {
      setActivating(false)
    }
  }

  async function handleSaveSpread() {
    if (!data) return
    const val = parseInt(spreadInput, 10)
    if (isNaN(val) || val < 0) {
      setSpreadError('Enter a valid number.')
      return
    }
    if (val > data.profile.maxSpreadBps) {
      setSpreadError(`Maximum allowed is ${data.profile.maxSpreadBps} bps.`)
      return
    }
    setSpreadSaving(true)
    setSpreadError('')
    try {
      await apiRequest('/merchants/spread', { method: 'PATCH', body: JSON.stringify({ spreadBps: val }) })
      setData((prev) => prev ? { ...prev, profile: { ...prev.profile, spreadBps: val } } : prev)
      setEditingSpread(false)
    } catch (err) {
      setSpreadError(err instanceof ApiError ? err.message : 'Failed to update spread.')
    } finally {
      setSpreadSaving(false)
    }
  }

  async function handleDeleteInventory() {
    if (!deleteTarget) return
    await apiRequest(`/merchants/inventory/${deleteTarget.id}`, { method: 'DELETE' })
    setData((prev) =>
      prev ? { ...prev, inventory: prev.inventory.filter((i) => i.id !== deleteTarget.id) } : prev
    )
    setDeleteTarget(null)
  }

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <LoadingState message="Loading merchant dashboard..." />
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <ErrorState title="Failed to load dashboard" description={error} onRetry={() => load()} />
      </div>
    )
  }

  if (!data) return null

  const { profile, stats, inventory, recentTrades } = data

  return (
    <div className="min-h-screen bg-surface pb-24">
      <PageContainer>
        <div className="py-6 space-y-6">

          {/* ── Header ── */}
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-bold text-text-primary">{profile.businessName}</h1>
                {profile.rank && (
                  <Badge variant="gold" size="sm">{profile.rank}</Badge>
                )}
                <Badge variant={profile.isActive ? 'success' : 'warning'} size="sm">
                  {profile.isActive ? 'Active' : 'Inactive'}
                </Badge>
              </div>
              <p className="text-sm text-text-muted">Merchant Dashboard</p>
            </div>
            <button
              onClick={() => load(true)}
              disabled={refreshing}
              className="p-2 rounded-lg border border-border bg-white text-text-secondary hover:bg-surface transition-colors disabled:opacity-50"
              aria-label="Refresh"
            >
              <svg className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>

          {/* ── Activate Banner ── */}
          {!profile.isActive && (
            <div className="rounded-xl bg-warning/10 border border-warning/30 p-4 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1">
                <p className="font-semibold text-warning text-sm">Account Inactive</p>
                <p className="text-xs text-text-secondary mt-0.5">
                  Activate your merchant account to start accepting trades. A collateral deposit may be required.
                </p>
                {activateError && <p className="text-xs text-danger mt-1">{activateError}</p>}
              </div>
              <Button size="sm" loading={activating} onClick={handleActivate} className="shrink-0">
                Activate Account
              </Button>
            </div>
          )}

          {/* ── Stats ── */}
          <section>
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">Performance</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              <StatCard label="Total Trades" value={stats.totalTrades} />
              <StatCard label="Completed" value={stats.completedTrades} />
              <StatCard label="Completion Rate" value={`${stats.completionRate.toFixed(1)}%`} />
              <StatCard label="Total Volume" value={`PKR ${Number(stats.totalVolumePKR).toLocaleString('en-PK')}`} />
              <StatCard
                label="Avg Rating"
                value={stats.avgRating.toFixed(1)}
                sub="out of 5"
              />
            </div>
          </section>

          {/* ── Spread Settings ── */}
          <section className="bg-white rounded-xl border border-border p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-text-primary">Spread Settings</h2>
              {!editingSpread && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setSpreadInput(String(profile.spreadBps))
                    setSpreadError('')
                    setEditingSpread(true)
                  }}
                >
                  Edit
                </Button>
              )}
            </div>
            {editingSpread ? (
              <div className="space-y-3">
                <Input
                  label="Spread (basis points)"
                  type="number"
                  min="0"
                  max={profile.maxSpreadBps}
                  value={spreadInput}
                  onChange={(e) => { setSpreadInput(e.target.value); setSpreadError('') }}
                  hint={`1 bps = 0.01% — max ${profile.maxSpreadBps} bps (${(profile.maxSpreadBps / 100).toFixed(2)}%)`}
                  error={spreadError}
                />
                <div className="flex gap-2">
                  <Button size="sm" loading={spreadSaving} onClick={handleSaveSpread}>
                    Save
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setEditingSpread(false)} disabled={spreadSaving}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-4">
                <div>
                  <p className="text-2xl font-bold text-text-primary">{profile.spreadBps} bps</p>
                  <p className="text-sm text-text-muted">{(profile.spreadBps / 100).toFixed(2)}% markup on market rate</p>
                </div>
              </div>
            )}
          </section>

          {/* ── Inventory ── */}
          <section className="bg-white rounded-xl border border-border overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h2 className="text-base font-semibold text-text-primary">Active Inventory</h2>
              <Button size="sm" onClick={() => setShowAddInventory(true)}>
                + Add Inventory
              </Button>
            </div>
            {inventory.length === 0 ? (
              <div className="px-5">
                <EmptyState
                  title="No inventory yet"
                  description="Add inventory items to start accepting buy orders from users."
                  action={{ label: 'Add Inventory', onClick: () => setShowAddInventory(true) }}
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-surface border-b border-border">
                    <tr>
                      <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wide px-5 py-3">Coin</th>
                      <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wide px-4 py-3">Network</th>
                      <th className="text-right text-xs font-semibold text-text-muted uppercase tracking-wide px-4 py-3">Price (PKR)</th>
                      <th className="text-right text-xs font-semibold text-text-muted uppercase tracking-wide px-4 py-3">Available</th>
                      <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wide px-4 py-3">Limits</th>
                      <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wide px-4 py-3">Status</th>
                      <th className="px-4 py-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {inventory.map((item) => (
                      <tr key={item.id} className="hover:bg-surface/50 transition-colors">
                        <td className="px-5 py-3 font-semibold text-text-primary">{item.coin}</td>
                        <td className="px-4 py-3 text-text-secondary">{item.network}</td>
                        <td className="px-4 py-3 text-right text-text-primary">{Number(item.price).toLocaleString('en-PK')}</td>
                        <td className="px-4 py-3 text-right text-text-primary">{item.availableAmount}</td>
                        <td className="px-4 py-3 text-text-secondary whitespace-nowrap">
                          {item.minAmount} – {item.maxAmount}
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            variant={item.status === 'active' ? 'success' : item.status === 'paused' ? 'warning' : 'default'}
                            size="sm"
                          >
                            {item.status}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => setDeleteTarget(item)}
                            className="text-danger hover:text-danger/70 transition-colors"
                            aria-label="Delete"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ── Recent Trades ── */}
          <section className="bg-white rounded-xl border border-border overflow-hidden">
            <div className="px-5 py-4 border-b border-border">
              <h2 className="text-base font-semibold text-text-primary">Recent Trades</h2>
            </div>
            {recentTrades.length === 0 ? (
              <div className="px-5">
                <EmptyState title="No trades yet" description="Your recent trades will appear here." />
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {recentTrades.map((trade) => (
                  <li key={trade.id}>
                    <Link
                      href={`/trade/${trade.id}`}
                      className="flex items-center gap-3 px-5 py-3 hover:bg-surface/50 transition-colors"
                    >
                      <Badge variant={tradeStatusVariant(trade.status)} size="sm" className="shrink-0 capitalize">
                        {trade.status}
                      </Badge>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-text-primary truncate">@{trade.buyerUsername}</p>
                        <p className="text-xs text-text-muted">{formatDate(trade.createdAt)}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-semibold text-text-primary">{trade.coinAmount} {trade.coin}</p>
                        <p className="text-xs text-text-muted">PKR {Number(trade.pkrAmount).toLocaleString('en-PK')}</p>
                      </div>
                      <svg className="w-4 h-4 text-text-muted shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Quick Actions ── */}
          <section>
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">Quick Actions</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Link href="/marketplace">
                <div className="flex flex-col items-center gap-2 bg-white border border-border rounded-xl p-4 hover:border-primary/50 hover:bg-surface/50 transition-colors text-center">
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                    <svg className="w-5 h-5 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
                    </svg>
                  </div>
                  <p className="text-sm font-medium text-text-primary">Marketplace</p>
                </div>
              </Link>
              <Link href="/my-ads">
                <div className="flex flex-col items-center gap-2 bg-white border border-border rounded-xl p-4 hover:border-primary/50 hover:bg-surface/50 transition-colors text-center">
                  <div className="w-10 h-10 rounded-full bg-success/10 flex items-center justify-center">
                    <svg className="w-5 h-5 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                  </div>
                  <p className="text-sm font-medium text-text-primary">My Ads</p>
                </div>
              </Link>
              <Link href="/referral">
                <div className="flex flex-col items-center gap-2 bg-white border border-border rounded-xl p-4 hover:border-primary/50 hover:bg-surface/50 transition-colors text-center">
                  <div className="w-10 h-10 rounded-full bg-gold/10 flex items-center justify-center">
                    <svg className="w-5 h-5 text-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </div>
                  <p className="text-sm font-medium text-text-primary">Referral</p>
                </div>
              </Link>
              <Link href="/settings">
                <div className="flex flex-col items-center gap-2 bg-white border border-border rounded-xl p-4 hover:border-primary/50 hover:bg-surface/50 transition-colors text-center">
                  <div className="w-10 h-10 rounded-full bg-surface flex items-center justify-center">
                    <svg className="w-5 h-5 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </div>
                  <p className="text-sm font-medium text-text-primary">Settings</p>
                </div>
              </Link>
            </div>
          </section>

        </div>
      </PageContainer>

      {/* ── Modals ── */}
      <AddInventoryModal
        isOpen={showAddInventory}
        onClose={() => setShowAddInventory(false)}
        onAdded={() => load(true)}
      />

      <ConfirmModal
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDeleteInventory}
        title="Remove Inventory"
        description={`Remove ${deleteTarget?.availableAmount} ${deleteTarget?.coin} from your inventory? This action cannot be undone.`}
        confirmLabel="Remove"
        confirmVariant="danger"
      />
    </div>
  )
}
