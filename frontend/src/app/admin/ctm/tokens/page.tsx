'use client'
import { useState } from 'react'
import { ctmApi } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'

const STATUS_COLORS: Record<string, string> = {
  approved: 'bg-green-100 text-green-700',
  pending_review: 'bg-yellow-100 text-yellow-700',
  rejected: 'bg-red-100 text-red-700',
  delisted: 'bg-gray-100 text-gray-600',
  restricted: 'bg-orange-100 text-orange-700',
}

const RISK_COLORS: Record<string, string> = {
  low: 'bg-green-100 text-green-800',
  medium: 'bg-yellow-100 text-yellow-800',
  high: 'bg-orange-100 text-orange-800',
  extreme: 'bg-red-100 text-red-800',
}

interface Token {
  id: string; slug: string; name: string; symbol: string; logoUrl?: string
  status: string; riskTier: string; isListingEnabled: boolean; totalTrades: number; totalVolumePkr: string
}

export default function AdminCtmTokensPage() {
  const [tokens, setTokens] = useState<Token[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)
  const [editToken, setEditToken] = useState<Token | null>(null)
  const [editStatus, setEditStatus] = useState('')
  const [editRisk, setEditRisk] = useState('')
  const [editListingEnabled, setEditListingEnabled] = useState(true)
  const [saving, setSaving] = useState(false)

  const fetchTokens = async () => {
    try {
      const res = await ctmApi.adminGetTokenQueue({ page, limit: 20, ...( statusFilter ? { status: statusFilter } : {} ) })
      // Admin view: use getTokens with adminView — but our queue endpoint returns all statuses
      // Use the public endpoint with no filter for now since adminView is not in ctmApi.getTokens
      const r2 = await fetch(`/api/v1/ctm/tokens?adminView=true&page=${page}&limit=20${search ? `&search=${search}` : ''}${statusFilter ? `&status=${statusFilter}` : ''}`, { credentials: 'include' })
      const data = await r2.json()
      setTokens(data.data?.tokens ?? [])
      setTotal(data.data?.total ?? 0)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  usePolling(fetchTokens, 30000)

  const handleSaveEdit = async () => {
    if (!editToken) return
    setSaving(true)
    try {
      await ctmApi.adminUpdateToken(editToken.id, {
        status: editStatus || undefined,
        riskTier: editRisk || undefined,
        isListingEnabled: editListingEnabled,
      })
      setEditToken(null)
      await fetchTokens()
    } catch (err: unknown) {
      alert((err as Error).message ?? 'Failed to update token')
    } finally {
      setSaving(false)
    }
  }

  const handleDelist = async (id: string) => {
    if (!confirm('Delist this token? All active listings will be paused.')) return
    try {
      await ctmApi.adminDelistToken(id)
      await fetchTokens()
    } catch (err: unknown) {
      alert((err as Error).message ?? 'Failed to delist')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-text-primary">CTM Tokens ({total})</h1>
        <div className="flex gap-2">
          <input type="text" placeholder="Search…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} className="border border-border rounded-lg px-3 py-2 text-sm bg-white w-40 focus:outline-none" />
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }} className="border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none">
            <option value="">All statuses</option>
            <option value="approved">Approved</option>
            <option value="pending_review">Pending Review</option>
            <option value="rejected">Rejected</option>
            <option value="delisted">Delisted</option>
            <option value="restricted">Restricted</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="bg-white border border-border rounded-xl h-16 animate-pulse" />)}</div>
      ) : (
        <div className="bg-white border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface border-b border-border">
              <tr>
                <th className="text-left px-4 py-3 text-text-muted font-medium">Token</th>
                <th className="text-left px-4 py-3 text-text-muted font-medium">Status</th>
                <th className="text-left px-4 py-3 text-text-muted font-medium">Risk</th>
                <th className="text-left px-4 py-3 text-text-muted font-medium">Trades</th>
                <th className="text-left px-4 py-3 text-text-muted font-medium">Listing</th>
                <th className="text-right px-4 py-3 text-text-muted font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {tokens.map((t) => (
                <tr key={t.id} className="hover:bg-surface/50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {t.logoUrl ? <img src={t.logoUrl} alt={t.name} className="w-8 h-8 rounded-full object-cover" /> : <div className="w-8 h-8 rounded-full bg-primary/10 text-primary font-bold text-xs flex items-center justify-center">{t.symbol.charAt(0)}</div>}
                      <div><p className="font-medium text-text-primary">{t.name}</p><p className="text-xs text-text-muted">{t.symbol} · {t.slug}</p></div>
                    </div>
                  </td>
                  <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[t.status] ?? 'bg-gray-100 text-gray-600'}`}>{t.status}</span></td>
                  <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-full font-medium ${RISK_COLORS[t.riskTier] ?? 'bg-gray-100 text-gray-600'}`}>{t.riskTier}</span></td>
                  <td className="px-4 py-3 text-text-muted">{t.totalTrades}</td>
                  <td className="px-4 py-3"><span className={`text-xs font-medium ${t.isListingEnabled ? 'text-green-600' : 'text-red-500'}`}>{t.isListingEnabled ? 'Enabled' : 'Disabled'}</span></td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <button onClick={() => { setEditToken(t); setEditStatus(t.status); setEditRisk(t.riskTier); setEditListingEnabled(t.isListingEnabled) }} className="text-xs border border-border px-2 py-1 rounded-lg hover:bg-surface">Edit</button>
                      {t.status !== 'delisted' && <button onClick={() => handleDelist(t.id)} className="text-xs border border-red-200 text-red-600 px-2 py-1 rounded-lg hover:bg-red-50">Delist</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {tokens.length === 0 && <p className="text-center py-12 text-text-muted">No tokens found.</p>}
        </div>
      )}

      {total > 20 && (
        <div className="flex justify-center gap-2">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="px-4 py-2 border border-border rounded-lg text-sm disabled:opacity-40">Prev</button>
          <span className="px-4 py-2 text-sm text-text-muted">Page {page}</span>
          <button onClick={() => setPage((p) => p + 1)} disabled={tokens.length < 20} className="px-4 py-2 border border-border rounded-lg text-sm disabled:opacity-40">Next</button>
        </div>
      )}

      {/* Edit modal */}
      {editToken && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4">
            <h3 className="font-bold text-lg text-text-primary">Edit: {editToken.name}</h3>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Status</label>
              <select value={editStatus} onChange={(e) => setEditStatus(e.target.value)} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm bg-white focus:outline-none">
                <option value="approved">Approved</option>
                <option value="pending_review">Pending Review</option>
                <option value="rejected">Rejected</option>
                <option value="restricted">Restricted</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Risk Tier</label>
              <select value={editRisk} onChange={(e) => setEditRisk(e.target.value)} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm bg-white focus:outline-none">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="extreme">Extreme</option>
              </select>
            </div>
            <div className="flex items-center gap-3">
              <input type="checkbox" id="listingEnabled" checked={editListingEnabled} onChange={(e) => setEditListingEnabled(e.target.checked)} className="w-4 h-4 rounded" />
              <label htmlFor="listingEnabled" className="text-sm text-text-primary">Listing Enabled</label>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setEditToken(null)} className="flex-1 border border-border py-2.5 rounded-xl text-sm font-medium">Cancel</button>
              <button onClick={handleSaveEdit} disabled={saving} className="flex-1 bg-primary text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
