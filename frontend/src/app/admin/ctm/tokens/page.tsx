'use client'
import { useState } from 'react'
import { ctmApi } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { invalidateLogoCache } from '@/hooks/useLogoRegistry'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'

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

const EMPTY_ADD = {
  slug: '', symbol: '', name: '', description: '',
  logoUrl: '', bannerUrl: '', settlementType: 'MANUAL' as 'MANUAL' | 'ON_CHAIN' | 'HYBRID',
  network: '', contractAddress: '', explorerUrl: '',
  officialWebsite: '', officialTwitter: '', officialTelegram: '', whitePaperUrl: '',
  riskTier: 'medium' as 'low' | 'medium' | 'high' | 'extreme',
  riskNotes: '', maxListingAmount: '', minTradeAmountPkr: '',
}

export default function AdminCtmTokensPage() {
  const [tokens, setTokens] = useState<Token[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)

  // Edit state
  const [editToken, setEditToken] = useState<Token | null>(null)
  const [editStatus, setEditStatus] = useState('')
  const [editRisk, setEditRisk] = useState('')
  const [editListingEnabled, setEditListingEnabled] = useState(true)
  const [saving, setSaving] = useState(false)

  // Add token state
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState(EMPTY_ADD)
  const [addError, setAddError] = useState('')
  const [addDuplicateSlug, setAddDuplicateSlug] = useState('')
  const [adding, setAdding] = useState(false)
  const [addSuccess, setAddSuccess] = useState('')

  const fetchTokens = async () => {
    try {
      const result = await ctmApi.adminListTokens({
        page,
        limit: 20,
        ...(search ? { search } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
      })
      setTokens((result as { tokens: Token[] }).tokens ?? [])
      setTotal((result as { total: number }).total ?? 0)
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

  const handleAddToken = async () => {
    setAddError('')
    if (!addForm.slug || !addForm.symbol || !addForm.name || !addForm.description) {
      setAddError('Slug, symbol, name, and description are required.')
      return
    }
    if (!/^[a-z0-9-]+$/.test(addForm.slug)) {
      setAddError('Slug must be lowercase letters, numbers, and hyphens only.')
      return
    }
    setAdding(true)
    try {
      const payload: Record<string, unknown> = {
        slug: addForm.slug,
        symbol: addForm.symbol.toUpperCase(),
        name: addForm.name,
        description: addForm.description,
        settlementType: addForm.settlementType,
        riskTier: addForm.riskTier,
      }
      if (addForm.logoUrl) payload.logoUrl = addForm.logoUrl
      if (addForm.bannerUrl) payload.bannerUrl = addForm.bannerUrl
      if (addForm.network) payload.network = addForm.network
      if (addForm.contractAddress) payload.contractAddress = addForm.contractAddress
      if (addForm.explorerUrl) payload.explorerUrl = addForm.explorerUrl
      if (addForm.officialWebsite) payload.officialWebsite = addForm.officialWebsite
      if (addForm.officialTwitter) payload.officialTwitter = addForm.officialTwitter
      if (addForm.officialTelegram) payload.officialTelegram = addForm.officialTelegram
      if (addForm.whitePaperUrl) payload.whitePaperUrl = addForm.whitePaperUrl
      if (addForm.riskNotes) payload.riskNotes = addForm.riskNotes
      if (addForm.maxListingAmount) payload.maxListingAmount = parseFloat(addForm.maxListingAmount)
      if (addForm.minTradeAmountPkr) payload.minTradeAmountPkr = parseFloat(addForm.minTradeAmountPkr)

      await ctmApi.adminCreateToken(payload)
      invalidateLogoCache()
      const createdName = addForm.name
      const createdSymbol = addForm.symbol.toUpperCase()
      setShowAdd(false)
      setAddForm(EMPTY_ADD)
      setAddError('')
      setAddDuplicateSlug('')
      await fetchTokens()
      setAddSuccess(`${createdName} (${createdSymbol}) added successfully.`)
      setTimeout(() => setAddSuccess(''), 6000)
    } catch (err: unknown) {
      const msg = (err as Error).message ?? 'Failed to create token'
      if (msg.toLowerCase().includes('already exists') || msg.toLowerCase().includes('conflict')) {
        setAddDuplicateSlug(addForm.slug)
        setAddError(`A token with slug "${addForm.slug}" already exists.`)
      } else {
        setAddDuplicateSlug('')
        setAddError(msg)
      }
    } finally {
      setAdding(false)
    }
  }

  const field = (label: string, key: keyof typeof EMPTY_ADD, opts?: { placeholder?: string; required?: boolean }) => (
    <div>
      <label className="block text-xs font-medium text-text-muted mb-1">{label}{opts?.required && <span className="text-red-500 ml-0.5">*</span>}</label>
      <input
        type="text"
        placeholder={opts?.placeholder ?? ''}
        value={addForm[key] as string}
        onChange={(e) => setAddForm((f) => ({ ...f, [key]: e.target.value }))}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-primary"
      />
    </div>
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-text-primary">CTM Tokens ({total})</h1>
        <div className="flex gap-2 flex-wrap">
          <input type="text" placeholder="Search…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} className="border border-border rounded-lg px-3 py-2 text-sm bg-white w-40 focus:outline-none" />
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }} className="border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none">
            <option value="">All statuses</option>
            <option value="approved">Approved</option>
            <option value="pending_review">Pending Review</option>
            <option value="rejected">Rejected</option>
            <option value="delisted">Delisted</option>
            <option value="restricted">Restricted</option>
          </select>
          <button
            onClick={() => { setShowAdd(true); setAddError('') }}
            className="bg-primary text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors"
          >
            + Add Token
          </button>
        </div>
      </div>

      {addSuccess && (
        <div className="flex items-center gap-3 bg-green-50 border border-green-200 text-green-800 rounded-xl px-4 py-3 text-sm">
          <svg className="w-4 h-4 flex-shrink-0 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
          {addSuccess}
          <button onClick={() => setAddSuccess('')} className="ml-auto text-green-600 hover:text-green-800">✕</button>
        </div>
      )}

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
                      <EntityLogo type="token" slug={t.symbol} size="md" logoUrl={t.logoUrl} />
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
      <Modal
        isOpen={!!editToken}
        onClose={() => setEditToken(null)}
        title={editToken ? `Edit: ${editToken.name}` : 'Edit Token'}
        size="sm"
        footer={
          <div className="flex gap-3">
            <Button variant="secondary" size="md" onClick={() => setEditToken(null)} disabled={saving} className="flex-1">Cancel</Button>
            <Button variant="primary" size="md" loading={saving} onClick={handleSaveEdit} className="flex-1">Save Changes</Button>
          </div>
        }
      >
        <div className="space-y-4">
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
        </div>
      </Modal>

      {/* Add Token modal */}
      <Modal
        isOpen={showAdd}
        onClose={() => { setShowAdd(false); setAddForm(EMPTY_ADD); setAddError(''); setAddDuplicateSlug('') }}
        title="Add Token (Admin)"
        size="xl"
        footer={
          <div className="space-y-3">
            {addError && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {addError}
                {addDuplicateSlug && (
                  <button
                    type="button"
                    className="ml-2 underline font-medium"
                    onClick={() => { setShowAdd(false); setAddForm(EMPTY_ADD); setAddError(''); setAddDuplicateSlug(''); setSearch(addDuplicateSlug) }}
                  >
                    Find it in the list →
                  </button>
                )}
              </div>
            )}
            <div className="flex gap-3">
              <Button variant="secondary" size="md" onClick={() => { setShowAdd(false); setAddForm(EMPTY_ADD); setAddError(''); setAddDuplicateSlug('') }} disabled={adding} className="flex-1">Cancel</Button>
              <Button variant="primary" size="md" loading={adding} onClick={handleAddToken} className="flex-1">Add Token</Button>
            </div>
          </div>
        }
      >
        <div className="space-y-6">
          <p className="text-xs text-text-muted">Tokens added here are immediately <span className="font-semibold text-green-600">approved</span> and visible on the marketplace. Queue submissions still go through the review process.</p>

          {/* Section: Basic Info */}
          <div className="space-y-4">
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wide border-b border-border pb-1">Basic Info</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {field('Slug', 'slug', { placeholder: 'e.g. bitcoin', required: true })}
              {field('Symbol', 'symbol', { placeholder: 'e.g. BTC', required: true })}
              {field('Name', 'name', { placeholder: 'e.g. Bitcoin', required: true })}
            </div>
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Description<span className="text-red-500 ml-0.5">*</span></label>
              <textarea
                rows={3}
                placeholder="Brief description of the token…"
                value={addForm.description}
                onChange={(e) => setAddForm((f) => ({ ...f, description: e.target.value }))}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-primary resize-none"
              />
            </div>
          </div>

          {/* Section: Trading Settings */}
          <div className="space-y-4">
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wide border-b border-border pb-1">Trading Settings</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-text-muted mb-1">Settlement Type<span className="text-red-500 ml-0.5">*</span></label>
                <select value={addForm.settlementType} onChange={(e) => setAddForm((f) => ({ ...f, settlementType: e.target.value as typeof addForm.settlementType }))} className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none">
                  <option value="MANUAL">Manual</option>
                  <option value="ON_CHAIN">On-Chain</option>
                  <option value="HYBRID">Hybrid</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-text-muted mb-1">Risk Tier</label>
                <select value={addForm.riskTier} onChange={(e) => setAddForm((f) => ({ ...f, riskTier: e.target.value as typeof addForm.riskTier }))} className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none">
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="extreme">Extreme</option>
                </select>
              </div>
              {field('Max Listing Amount', 'maxListingAmount', { placeholder: 'e.g. 100000' })}
              {field('Min Trade Amount (PKR)', 'minTradeAmountPkr', { placeholder: 'e.g. 1000' })}
            </div>
          </div>

          {/* Section: Blockchain Info */}
          <div className="space-y-4">
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wide border-b border-border pb-1">Blockchain Info</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {field('Network', 'network', { placeholder: 'e.g. Ethereum' })}
              {field('Contract Address', 'contractAddress', { placeholder: '0x…' })}
              {field('Explorer URL', 'explorerUrl', { placeholder: 'https://etherscan.io/…' })}
            </div>
          </div>

          {/* Section: Branding */}
          <div className="space-y-4">
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wide border-b border-border pb-1">Branding</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {field('Logo URL', 'logoUrl', { placeholder: 'https://…' })}
              {field('Banner URL', 'bannerUrl', { placeholder: 'https://…' })}
              {field('Official Website', 'officialWebsite', { placeholder: 'https://…' })}
              {field('Twitter', 'officialTwitter', { placeholder: 'https://twitter.com/…' })}
              {field('Telegram', 'officialTelegram', { placeholder: 'https://t.me/…' })}
              {field('Whitepaper URL', 'whitePaperUrl', { placeholder: 'https://…' })}
            </div>
          </div>

          {/* Section: Admin / Internal */}
          <div className="space-y-4">
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wide border-b border-border pb-1">Internal / Admin</p>
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Risk Notes</label>
              <textarea
                rows={2}
                placeholder="Internal risk notes…"
                value={addForm.riskNotes}
                onChange={(e) => setAddForm((f) => ({ ...f, riskNotes: e.target.value }))}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-primary resize-none"
              />
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}
