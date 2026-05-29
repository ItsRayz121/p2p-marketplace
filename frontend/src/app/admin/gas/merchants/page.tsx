'use client'
import { useState, useCallback, useEffect } from 'react'
import { adminApi } from '@/lib/api'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Building2, ArrowRightLeft } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { useAuthStore } from '@/store/auth.store'
import { Modal } from '@/components/ui/Modal'

type Merchant = {
  id: string
  name: string
  apiKeyId: string
  commissionRate: number
  settlementCycle: string
  payoutAddress: string | null
  isActive: boolean
  createdAt: string
}

type Settlement = {
  id: string
  merchantId: string
  periodStart: string
  periodEnd: string
  orderCount: number
  grossRevenueUsd: number
  platformFeeUsd: number
  merchantShareUsd: number
  status: string
  payoutTxHash: string | null
  paidAt: string | null
  createdAt: string
}

function usd(v: number) {
  return `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString()
}

function settlementStatusVariant(s: string): 'warning' | 'success' | 'default' {
  if (s === 'paid') return 'success'
  if (s === 'approved') return 'warning'
  return 'default'
}

type MerchantForm = {
  name: string
  apiKeyId: string
  commissionRate: string
  settlementCycle: string
  payoutAddress: string
}

const BLANK_FORM: MerchantForm = {
  name: '',
  apiKeyId: '',
  commissionRate: '0',
  settlementCycle: 'weekly',
  payoutAddress: '',
}

export default function GasMerchantsPage() {
  const user = useAuthStore((s) => s.user)
  const isSuperAdmin = user?.role === 'super_admin'

  const [merchants, setMerchants] = useState<Merchant[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<MerchantForm>(BLANK_FORM)
  const [formSaving, setFormSaving] = useState(false)
  const [formError, setFormError] = useState('')

  const [selectedMerchant, setSelectedMerchant] = useState<Merchant | null>(null)
  const [settlements, setSettlements] = useState<Settlement[]>([])
  const [settlementsLoading, setSettlementsLoading] = useState(false)
  const [settlementsPage, setSettlementsPage] = useState(1)
  const [settlementsTotal, setSettlementsTotal] = useState(0)
  const [approvingId, setApprovingId] = useState<string | null>(null)

  const LIMIT = 20

  const fetchMerchants = useCallback(async (p = 1) => {
    setLoading(true)
    setError(null)
    try {
      const res = await adminApi.listMerchantAccounts(p, LIMIT)
      setMerchants(res.merchants ?? [])
      setTotal(res.total ?? 0)
      setPage(p)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load merchant accounts')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchMerchants(1) }, [fetchMerchants])

  function flash(msg: string) {
    setSuccessMsg(msg)
    setTimeout(() => setSuccessMsg(null), 3500)
  }

  function openAdd() {
    setEditingId(null)
    setForm(BLANK_FORM)
    setFormError('')
    setShowForm(true)
  }

  function openEdit(m: Merchant) {
    setEditingId(m.id)
    setForm({
      name: m.name,
      apiKeyId: m.apiKeyId,
      commissionRate: String(m.commissionRate),
      settlementCycle: m.settlementCycle,
      payoutAddress: m.payoutAddress ?? '',
    })
    setFormError('')
    setShowForm(true)
  }

  async function saveForm() {
    setFormSaving(true)
    setFormError('')
    try {
      const payload = {
        name: form.name,
        apiKeyId: form.apiKeyId,
        commissionRate: parseFloat(form.commissionRate) || 0,
        settlementCycle: form.settlementCycle,
        payoutAddress: form.payoutAddress || undefined,
      }
      if (editingId) {
        await adminApi.updateMerchantAccount(editingId, payload)
        flash('Merchant account updated.')
      } else {
        await adminApi.createMerchantAccount(payload)
        flash('Merchant account created.')
      }
      setShowForm(false)
      fetchMerchants(page)
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : 'Failed to save merchant')
    } finally {
      setFormSaving(false)
    }
  }

  async function openSettlements(merchant: Merchant) {
    setSelectedMerchant(merchant)
    setSettlementsPage(1)
    setSettlements([])
    setSettlementsLoading(true)
    try {
      const res = await adminApi.listMerchantSettlements(merchant.id, 1, LIMIT)
      setSettlements(res.settlements)
      setSettlementsTotal(res.total)
    } catch { /* swallow */ }
    finally { setSettlementsLoading(false) }
  }

  async function loadMoreSettlements(p: number) {
    if (!selectedMerchant) return
    setSettlementsLoading(true)
    try {
      const res = await adminApi.listMerchantSettlements(selectedMerchant.id, p, LIMIT)
      setSettlements(res.settlements)
      setSettlementsPage(p)
    } catch { /* swallow */ }
    finally { setSettlementsLoading(false) }
  }

  async function approveSettlement(id: string) {
    setApprovingId(id)
    try {
      await adminApi.approveSettlement(id)
      flash('Settlement approved.')
      if (selectedMerchant) openSettlements(selectedMerchant)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to approve settlement')
    } finally {
      setApprovingId(null)
    }
  }

  const totalPages = Math.ceil(total / LIMIT)
  const settlementTotalPages = Math.ceil(settlementsTotal / LIMIT)

  function field(key: keyof MerchantForm) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm({ ...form, [key]: e.target.value })
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Merchant Accounts</h1>
          <p className="text-text-muted text-sm mt-0.5">API key holders with commission and settlement configuration.</p>
        </div>
        {isSuperAdmin && (
          <Button size="sm" onClick={openAdd}>+ Add Merchant</Button>
        )}
      </div>

      {successMsg && (
        <div className="px-4 py-3 bg-success/10 border border-success/20 rounded-xl text-success text-sm">{successMsg}</div>
      )}
      {error && (
        <div className="px-4 py-3 bg-danger/10 border border-danger/20 rounded-xl text-danger text-sm">{error}</div>
      )}

      {loading && <LoadingState message="Loading merchant accounts..." />}
      {!loading && error && <ErrorState title={error} onRetry={() => fetchMerchants(1)} />}
      {!loading && !error && merchants.length === 0 && (
        <EmptyState icon={Building2} title="No merchant accounts" description="Add a merchant account to get started." />
      )}

      {!loading && merchants.length > 0 && (
        <div className="bg-white rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Name</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">API Key</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Commission</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Cycle</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Payout Address</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
                  <th className="px-4 py-3 text-right font-medium text-text-muted">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {merchants.map((m) => (
                  <tr key={m.id} className="hover:bg-surface/50 transition-colors">
                    <td className="px-4 py-3 font-medium text-text-primary">{m.name}</td>
                    <td className="px-4 py-3">
                      <code className="text-xs bg-surface px-1.5 py-0.5 rounded">{m.apiKeyId.slice(0, 12)}...</code>
                    </td>
                    <td className="px-4 py-3 text-text-muted">{(m.commissionRate * 100).toFixed(1)}%</td>
                    <td className="px-4 py-3 text-text-muted capitalize">{m.settlementCycle}</td>
                    <td className="px-4 py-3">
                      {m.payoutAddress
                        ? <code className="text-xs bg-surface px-1.5 py-0.5 rounded">{m.payoutAddress.slice(0, 14)}...</code>
                        : <span className="text-text-muted text-xs">Not set</span>}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={m.isActive ? 'success' : 'default'} size="sm">
                        {m.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={() => openSettlements(m)}>Settlements</Button>
                        {isSuperAdmin && (
                          <Button size="sm" variant="ghost" onClick={() => openEdit(m)}>Edit</Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => fetchMerchants(page - 1)}>Prev</Button>
          <span className="text-sm text-text-muted">Page {page} / {totalPages}</span>
          <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => fetchMerchants(page + 1)}>Next</Button>
        </div>
      )}

      {/* Merchant form modal */}
      <Modal
        isOpen={showForm}
        onClose={() => setShowForm(false)}
        title={editingId ? 'Edit Merchant' : 'Add Merchant Account'}
        size="md"
        footer={
          <div className="flex gap-3">
            <Button variant="secondary" className="flex-1" onClick={() => setShowForm(false)} disabled={formSaving}>Cancel</Button>
            <Button className="flex-1" onClick={saveForm} disabled={formSaving || !form.name || !form.apiKeyId}>
              {formSaving ? 'Saving...' : editingId ? 'Save Changes' : 'Create'}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-text-muted block mb-1">Name *</label>
            <Input placeholder="e.g. Partner Exchange" value={form.name} onChange={field('name')} />
          </div>
          <div>
            <label className="text-xs font-medium text-text-muted block mb-1">API Key ID *</label>
            <Input placeholder="MerchantApiKey ID" value={form.apiKeyId} onChange={field('apiKeyId')} disabled={!!editingId} />
          </div>
          <div>
            <label className="text-xs font-medium text-text-muted block mb-1">Commission Rate (0–1)</label>
            <Input type="number" step="0.01" min="0" max="1" value={form.commissionRate} onChange={field('commissionRate')} />
            <p className="text-xs text-text-muted mt-0.5">e.g. 0.3 = 30% of revenue goes to merchant</p>
          </div>
          <div>
            <label className="text-xs font-medium text-text-muted block mb-1">Settlement Cycle</label>
            <select className="w-full border border-border rounded-lg px-3 py-2 text-sm" value={form.settlementCycle} onChange={field('settlementCycle')}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-text-muted block mb-1">Payout Address (USDT TRC20)</label>
            <Input placeholder="T..." value={form.payoutAddress} onChange={field('payoutAddress')} />
          </div>
          {formError && <p className="text-danger text-sm">{formError}</p>}
        </div>
      </Modal>

      {/* Settlements panel */}
      <Modal
        isOpen={!!selectedMerchant}
        onClose={() => setSelectedMerchant(null)}
        title={selectedMerchant ? `Settlements — ${selectedMerchant.name}` : 'Settlements'}
        size="xl"
      >
        <div className="space-y-4">
              {settlementsLoading && <LoadingState message="Loading settlements..." />}

              {!settlementsLoading && settlements.length === 0 && (
                <EmptyState icon={ArrowRightLeft} title="No settlements yet" description="Settlements are created automatically by the daily job." />
              )}

              {!settlementsLoading && settlements.length > 0 && (
                <div className="bg-white rounded-xl border border-border overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-surface border-b border-border">
                        <tr>
                          <th className="text-left px-4 py-3 font-medium text-text-muted">Period</th>
                          <th className="text-right px-4 py-3 font-medium text-text-muted">Orders</th>
                          <th className="text-right px-4 py-3 font-medium text-text-muted">Gross</th>
                          <th className="text-right px-4 py-3 font-medium text-text-muted">Merchant Share</th>
                          <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
                          <th className="px-4 py-3 text-right font-medium text-text-muted">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {settlements.map((s) => (
                          <tr key={s.id} className="hover:bg-surface/50 transition-colors">
                            <td className="px-4 py-3 text-text-primary text-xs">
                              {new Date(s.periodStart).toLocaleDateString()} – {new Date(s.periodEnd).toLocaleDateString()}
                            </td>
                            <td className="px-4 py-3 text-right text-text-muted">{s.orderCount}</td>
                            <td className="px-4 py-3 text-right text-text-primary">{usd(s.grossRevenueUsd)}</td>
                            <td className="px-4 py-3 text-right font-semibold text-success">{usd(s.merchantShareUsd)}</td>
                            <td className="px-4 py-3">
                              <Badge variant={settlementStatusVariant(s.status)} size="sm">{s.status}</Badge>
                              {s.paidAt && <p className="text-xs text-text-muted mt-0.5">Paid {fmt(s.paidAt)}</p>}
                            </td>
                            <td className="px-4 py-3 text-right">
                              {s.status === 'pending' && isSuperAdmin && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={approvingId === s.id}
                                  onClick={() => approveSettlement(s.id)}
                                >
                                  {approvingId === s.id ? 'Approving...' : 'Approve'}
                                </Button>
                              )}
                              {s.payoutTxHash && (
                                <code className="text-xs text-text-muted" title={s.payoutTxHash}>
                                  tx: {s.payoutTxHash.slice(0, 10)}...
                                </code>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {settlementTotalPages > 1 && (
                <div className="flex items-center justify-center gap-2">
                  <Button size="sm" variant="secondary" disabled={settlementsPage <= 1} onClick={() => loadMoreSettlements(settlementsPage - 1)}>Prev</Button>
                  <span className="text-sm text-text-muted">Page {settlementsPage} / {settlementTotalPages}</span>
                  <Button size="sm" variant="secondary" disabled={settlementsPage >= settlementTotalPages} onClick={() => loadMoreSettlements(settlementsPage + 1)}>Next</Button>
                </div>
              )}
        </div>
      </Modal>
    </div>
  )
}
