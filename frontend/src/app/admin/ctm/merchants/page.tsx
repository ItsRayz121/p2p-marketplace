'use client'
import { useState } from 'react'
import { ctmApi } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { Modal } from '@/components/ui/Modal'

const TIER_COLORS: Record<string, string> = {
  new: 'bg-surface-alt text-text-secondary',
  basic: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  verified: 'bg-green-500/15 text-green-700 dark:text-green-300',
  elite: 'bg-purple-500/15 text-purple-700 dark:text-purple-300',
}

interface CtmMerchant {
  id: string; userId: string; merchantId: string; tier: string; isActive: boolean
  totalCtmTrades: number; completedCtmTrades: number; disputedCtmTrades: number
  ctmDisputeRate: string; ctmAvgRating: string; suspendedUntil?: string; suspendReason?: string
  approvedAt?: string; createdAt: string
  user: { username: string; email: string }
}

export default function AdminCtmMerchantsPage() {
  const [merchants, setMerchants] = useState<CtmMerchant[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [tierFilter, setTierFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)
  const [suspendModal, setSuspendModal] = useState<CtmMerchant | null>(null)
  const [tierModal, setTierModal] = useState<CtmMerchant | null>(null)
  const [suspendReason, setSuspendReason] = useState('')
  const [suspendDays, setSuspendDays] = useState('7')
  const [newTier, setNewTier] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [tab, setTab] = useState<'all' | 'pending'>('pending')

  const fetchMerchants = async () => {
    try {
      const params: Record<string, string | number> = { page, limit: 20 }
      if (tierFilter) params.tier = tierFilter
      if (statusFilter) params.status = statusFilter
      if (tab === 'pending') params.status = 'pending'
      const res = await ctmApi.adminGetMerchantQueue(params)
      const data = res as { merchants: CtmMerchant[]; total: number }
      setMerchants(data.merchants ?? [])
      setTotal(data.total ?? 0)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  usePolling(fetchMerchants, 30000)

  const handleApprove = async (id: string) => {
    try {
      await ctmApi.adminApproveMerchant(id)
      await fetchMerchants()
    } catch (err: unknown) {
      alert((err as Error).message ?? 'Failed to approve')
    }
  }

  const handleSuspend = async () => {
    if (!suspendModal || !suspendReason.trim()) return
    setSubmitting(true)
    try {
      const suspendUntil = new Date(Date.now() + parseInt(suspendDays) * 86400000).toISOString()
      await ctmApi.adminSuspendMerchant(suspendModal.id, { reason: suspendReason, suspendUntil })
      setSuspendModal(null); setSuspendReason('')
      await fetchMerchants()
    } catch (err: unknown) {
      alert((err as Error).message ?? 'Failed to suspend')
    } finally {
      setSubmitting(false)
    }
  }

  const handleChangeTier = async () => {
    if (!tierModal || !newTier) return
    setSubmitting(true)
    try {
      await ctmApi.adminChangeMerchantTier(tierModal.id, newTier)
      setTierModal(null)
      await fetchMerchants()
    } catch (err: unknown) {
      alert((err as Error).message ?? 'Failed to change tier')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-text-primary">CTM Merchants ({total})</h1>
        <div className="flex gap-2">
          <select value={tierFilter} onChange={(e) => { setTierFilter(e.target.value); setPage(1) }} className="border border-border rounded-lg px-3 py-2 text-sm bg-surface text-text-primary focus:outline-none">
            <option value="">All tiers</option>
            <option value="new">New</option>
            <option value="basic">Basic</option>
            <option value="verified">Verified</option>
            <option value="elite">Elite</option>
          </select>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border">
        {(['pending', 'all'] as const).map((t) => (
          <button key={t} onClick={() => { setTab(t); setPage(1) }}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors capitalize ${tab === t ? 'border-primary text-primary' : 'border-transparent text-text-muted hover:text-text-primary'}`}>
            {t === 'pending' ? 'Pending Approval' : 'All Merchants'}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="bg-surface shadow-card border border-border rounded-xl h-20 animate-pulse" />)}</div>
      ) : merchants.length === 0 ? (
        <div className="text-center py-16 text-text-muted">{tab === 'pending' ? 'No pending approvals.' : 'No merchants found.'}</div>
      ) : (
        <div className="bg-surface shadow-card border border-border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface border-b border-border">
              <tr>
                <th className="text-left px-4 py-3 text-text-muted font-medium">Merchant</th>
                <th className="text-left px-4 py-3 text-text-muted font-medium">Tier</th>
                <th className="text-left px-4 py-3 text-text-muted font-medium">Trades</th>
                <th className="text-left px-4 py-3 text-text-muted font-medium">Dispute Rate</th>
                <th className="text-left px-4 py-3 text-text-muted font-medium">Avg Rating</th>
                <th className="text-left px-4 py-3 text-text-muted font-medium">Status</th>
                <th className="text-right px-4 py-3 text-text-muted font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {merchants.map((m) => (
                <tr key={m.id} className="hover:bg-surface/50">
                  <td className="px-4 py-3">
                    <p className="font-medium text-text-primary">{m.user.username}</p>
                    <p className="text-xs text-text-muted">{m.user.email}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${TIER_COLORS[m.tier] ?? 'bg-surface-alt text-text-secondary'}`}>{m.tier}</span>
                  </td>
                  <td className="px-4 py-3 text-text-muted">{m.completedCtmTrades}/{m.totalCtmTrades}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs font-medium ${parseFloat(m.ctmDisputeRate) > 0.05 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>
                      {(parseFloat(m.ctmDisputeRate) * 100).toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-4 py-3 text-text-muted">{parseFloat(m.ctmAvgRating).toFixed(1)} ★</td>
                  <td className="px-4 py-3">
                    {m.approvedAt ? (
                      m.isActive ? (
                        m.suspendedUntil && new Date(m.suspendedUntil) > new Date() ? (
                          <span className="text-xs text-orange-600 dark:text-orange-400 font-medium">Suspended</span>
                        ) : (
                          <span className="text-xs text-green-600 dark:text-green-400 font-medium">Active</span>
                        )
                      ) : (
                        <span className="text-xs text-red-600 dark:text-red-400 font-medium">Inactive</span>
                      )
                    ) : (
                      <span className="text-xs text-yellow-600 dark:text-yellow-400 font-medium">Pending</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      {!m.approvedAt && (
                        <button onClick={() => handleApprove(m.id)} className="text-xs bg-green-600 text-white px-2 py-1 rounded-lg hover:bg-green-700">Approve</button>
                      )}
                      <button onClick={() => { setTierModal(m); setNewTier(m.tier) }} className="text-xs border border-border px-2 py-1 rounded-lg hover:bg-surface">Tier</button>
                      <button onClick={() => { setSuspendModal(m); setSuspendReason('') }} className="text-xs border border-red-500/30 text-red-600 dark:text-red-400 px-2 py-1 rounded-lg hover:bg-red-500/10">Suspend</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {total > 20 && (
        <div className="flex justify-center gap-2">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="px-4 py-2 border border-border rounded-lg text-sm disabled:opacity-40">Prev</button>
          <span className="px-4 py-2 text-sm text-text-muted">Page {page}</span>
          <button onClick={() => setPage((p) => p + 1)} disabled={merchants.length < 20} className="px-4 py-2 border border-border rounded-lg text-sm disabled:opacity-40">Next</button>
        </div>
      )}

      {/* Suspend modal */}
      <Modal
        isOpen={!!suspendModal}
        onClose={() => setSuspendModal(null)}
        title={suspendModal ? `Suspend: ${suspendModal.user.username}` : 'Suspend Merchant'}
        size="md"
        footer={
          <div className="flex gap-3">
            <button onClick={() => setSuspendModal(null)} className="flex-1 border border-border py-2.5 rounded-xl text-sm font-medium">Cancel</button>
            <button onClick={handleSuspend} disabled={submitting || !suspendReason.trim()} className="flex-1 bg-red-600 text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
              {submitting ? 'Suspending…' : 'Suspend'}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">Suspend Duration</label>
            <select value={suspendDays} onChange={(e) => setSuspendDays(e.target.value)} className="w-full border border-border rounded-xl px-3 py-2 text-sm bg-surface text-text-primary focus:outline-none">
              <option value="1">1 day</option>
              <option value="3">3 days</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">Reason *</label>
            <textarea rows={3} value={suspendReason} onChange={(e) => setSuspendReason(e.target.value)} placeholder="Reason for suspension…" className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none resize-none" />
          </div>
        </div>
      </Modal>

      {/* Change tier modal */}
      <Modal
        isOpen={!!tierModal}
        onClose={() => setTierModal(null)}
        title={tierModal ? `Change Tier: ${tierModal.user.username}` : 'Change Tier'}
        size="sm"
        footer={
          <div className="flex gap-3">
            <button onClick={() => setTierModal(null)} className="flex-1 border border-border py-2.5 rounded-xl text-sm font-medium">Cancel</button>
            <button onClick={handleChangeTier} disabled={submitting} className="flex-1 bg-primary text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
              {submitting ? 'Saving…' : 'Save'}
            </button>
          </div>
        }
      >
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">New Tier</label>
          <select value={newTier} onChange={(e) => setNewTier(e.target.value)} className="w-full border border-border rounded-xl px-3 py-2 text-sm bg-surface text-text-primary focus:outline-none">
            <option value="new">New</option>
            <option value="basic">Basic</option>
            <option value="verified">Verified</option>
            <option value="elite">Elite</option>
          </select>
        </div>
      </Modal>
    </div>
  )
}
