'use client'
import { useState, useCallback, useEffect } from 'react'
import { logoApi } from '@/lib/api'
import type { LogoRegistryEntry } from '@/lib/api'
import { useAdminLogoUpload } from '@/hooks/useAdminLogoUpload'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { invalidateLogoCache } from '@/hooks/useLogoRegistry'
import type { EntityType } from '@/lib/logoRegistry'

// ── Helpers ───────────────────────────────────────────────────────────────────

const ENTITY_TYPES: { value: EntityType; label: string }[] = [
  { value: 'chain',          label: 'Blockchain / Chain' },
  { value: 'token',          label: 'Token / Coin' },
  { value: 'payment_method', label: 'Payment Method (JazzCash, Easypaisa…)' },
  { value: 'bank',           label: 'Bank (HBL, MCB…)' },
  { value: 'wallet_provider', label: 'Wallet Provider' },
]

const TYPE_EXAMPLES: Record<string, string> = {
  chain:           'BSC, TRON, ETH, MATIC, ARB, OP, BASE, AVAX, SOL, TON, SUI',
  token:           'USDT, USDC, SIDRA, GIWA, BNB, TRX',
  payment_method:  'jazzcash, easypaisa, sadapay, nayapay, bank_transfer',
  bank:            'hbl, mcb, ubl, allied, meezan, nbp',
  wallet_provider: 'trustwallet, metamask, phantom',
}

function isNonDirectImageUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return /twitter\.com|instagram\.com|facebook\.com/.test(host)
  } catch { return false }
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AdminLogosPage() {
  const [entries, setEntries]       = useState<LogoRegistryEntry[]>([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState<string | null>(null)
  const [filterType, setFilterType] = useState<string>('')
  const [filterSlug, setFilterSlug] = useState('')

  // Add / edit form
  const [formType, setFormType] = useState<EntityType>('chain')
  const [formSlug, setFormSlug] = useState('')
  const [formUrl,  setFormUrl]  = useState('')
  const [saving,   setSaving]   = useState(false)
  const [saveMsg,  setSaveMsg]  = useState<string | null>(null)

  const { upload, uploading, error: uploadError } = useAdminLogoUpload()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await logoApi.adminList()
      setEntries(data)
    } catch {
      setError('Failed to load logo registry.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function handleSave() {
    if (!formSlug.trim() || !formUrl.trim()) {
      setSaveMsg('Slug and Logo URL are required.')
      return
    }
    setSaving(true)
    setSaveMsg(null)
    try {
      await logoApi.adminUpsert({ type: formType, slug: formSlug.trim(), logoUrl: formUrl.trim() })
      invalidateLogoCache()
      setSaveMsg('Saved.')
      setFormSlug('')
      setFormUrl('')
      await load()
    } catch {
      setSaveMsg('Save failed.')
    } finally {
      setSaving(false)
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const url = await upload(file)
      setFormUrl(url)
    } catch { /* error shown via uploadError */ }
    e.target.value = ''
  }

  async function handleDelete(id: string) {
    if (!confirm('Remove this logo from the registry?')) return
    try {
      await logoApi.adminDelete(id)
      invalidateLogoCache()
      setEntries((prev) => prev.filter((e) => e.id !== id))
    } catch {
      alert('Delete failed.')
    }
  }

  const filtered = entries.filter((e) => {
    if (filterType && e.type !== filterType) return false
    if (filterSlug && !e.slug.toLowerCase().includes(filterSlug.toLowerCase())) return false
    return true
  })

  const urlWarn = formUrl && isNonDirectImageUrl(formUrl)

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Logo Registry</h1>
        <p className="text-text-muted text-sm mt-1">
          Upload logos once — they appear everywhere that entity is displayed (chains, tokens, payment methods, banks).
          Logos uploaded via Gas Chains or CTM Tokens are already included automatically.
        </p>
      </div>

      {/* ── Add / Replace form ─────────────────────────────────────────── */}
      <div className="bg-surface border border-border rounded-xl p-5 space-y-4">
        <h2 className="font-semibold text-text-primary">Add / Replace Logo</h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Entity type</label>
            <select
              value={formType}
              onChange={(e) => { setFormType(e.target.value as EntityType); setFormSlug('') }}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              {ENTITY_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">
              Slug / Symbol
              <span className="ml-2 font-normal text-text-muted/70">e.g. {TYPE_EXAMPLES[formType]}</span>
            </label>
            <input
              type="text"
              value={formSlug}
              onChange={(e) => setFormSlug(e.target.value)}
              placeholder="e.g. BSC, jazzcash, hbl"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-text-muted mb-1">Logo URL</label>
          <input
            type="url"
            value={formUrl}
            onChange={(e) => setFormUrl(e.target.value)}
            placeholder="https://… or upload below"
            className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          {urlWarn && (
            <p className="text-xs text-warning mt-1">This looks like a social media URL — use a direct image link instead.</p>
          )}
        </div>

        {/* Preview */}
        {formUrl && !urlWarn && (
          <div className="flex items-center gap-3">
            <EntityLogo type={formType} slug={formSlug || '?'} size="xl" logoUrl={formUrl} />
            <span className="text-xs text-text-muted truncate max-w-xs">{formUrl}</span>
          </div>
        )}

        {/* Upload */}
        <div>
          <label className="block text-xs font-medium text-text-muted mb-1">
            {formUrl ? 'Replace with upload (PNG/JPG/SVG/WebP · max 2 MB)' : 'Upload logo (PNG/JPG/SVG/WebP · max 2 MB)'}
          </label>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            onChange={handleUpload}
            disabled={uploading}
            className="text-sm"
          />
          {uploading && <p className="text-xs text-text-muted mt-1">Uploading…</p>}
          {uploadError && <p className="text-xs text-danger mt-1">{uploadError}</p>}
        </div>

        {saveMsg && (
          <p className={`text-xs ${saveMsg === 'Saved.' ? 'text-success' : 'text-danger'}`}>{saveMsg}</p>
        )}

        <button
          onClick={handleSave}
          disabled={saving || uploading || !formSlug.trim() || !formUrl.trim()}
          className="bg-primary text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-primary/90 disabled:opacity-40 transition-colors"
        >
          {saving ? 'Saving…' : 'Save Logo'}
        </button>
      </div>

      {/* ── Registry table ─────────────────────────────────────────────── */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="p-4 border-b border-border flex flex-wrap gap-3 items-center justify-between">
          <h2 className="font-semibold text-text-primary">Registry ({filtered.length})</h2>
          <div className="flex gap-2">
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="border border-border rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none"
            >
              <option value="">All types</option>
              {ENTITY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <input
              type="text"
              value={filterSlug}
              onChange={(e) => setFilterSlug(e.target.value)}
              placeholder="Filter by slug…"
              className="border border-border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>

        {loading ? (
          <div className="p-8 text-center text-text-muted text-sm">Loading…</div>
        ) : error ? (
          <div className="p-8 text-center text-danger text-sm">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-text-muted text-sm">
            No custom registry entries yet. Logos from Gas Chains, Gas Tokens, and CTM Tokens are included automatically.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-surface-raised text-text-muted text-xs">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">Logo</th>
                <th className="px-4 py-2.5 text-left font-medium">Type</th>
                <th className="px-4 py-2.5 text-left font-medium">Slug</th>
                <th className="px-4 py-2.5 text-left font-medium hidden sm:table-cell">URL</th>
                <th className="px-4 py-2.5 text-left font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((entry) => (
                <tr key={entry.id} className="hover:bg-surface-raised/50">
                  <td className="px-4 py-2.5">
                    <EntityLogo
                      type={entry.type as EntityType}
                      slug={entry.slug}
                      size="md"
                      logoUrl={entry.logoUrl}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="bg-primary/10 text-primary text-xs px-2 py-0.5 rounded font-medium">{entry.type}</span>
                  </td>
                  <td className="px-4 py-2.5 font-mono font-medium text-text-primary">{entry.slug}</td>
                  <td className="px-4 py-2.5 hidden sm:table-cell">
                    <a
                      href={entry.logoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline text-xs truncate block max-w-xs"
                    >
                      {entry.logoUrl}
                    </a>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          setFormType(entry.type as EntityType)
                          setFormSlug(entry.slug)
                          setFormUrl(entry.logoUrl)
                          window.scrollTo({ top: 0, behavior: 'smooth' })
                        }}
                        className="text-xs text-primary hover:underline"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(entry.id)}
                        className="text-xs text-danger hover:underline"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-text-muted">
        Note: logos uploaded in Gas Chains, Gas Tokens, and CTM Tokens pages are not listed here but are served by the same logo API and rendered by EntityLogo automatically.
      </p>
    </div>
  )
}
