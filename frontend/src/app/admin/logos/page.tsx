'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import { logoApi } from '@/lib/api'
import type { LogoRegistryEntry } from '@/lib/api'
import { useAdminLogoUpload } from '@/hooks/useAdminLogoUpload'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { invalidateLogoCache } from '@/hooks/useLogoRegistry'
import type { EntityType } from '@/lib/logoRegistry'

// ── Constants ─────────────────────────────────────────────────────────────────

const ENTITY_TYPES: { value: EntityType; label: string }[] = [
  { value: 'chain',           label: 'Blockchain / Chain' },
  { value: 'token',           label: 'Token / Coin' },
  { value: 'payment_method',  label: 'Payment Method (JazzCash, Easypaisa…)' },
  { value: 'bank',            label: 'Bank (HBL, MCB…)' },
  { value: 'wallet_provider', label: 'Wallet Provider' },
]

const TYPE_EXAMPLES: Record<string, string> = {
  chain:           'BSC, TRON, ETH, MATIC, ARB, OP, BASE, AVAX, SOL, TON, SUI',
  token:           'USDT, USDC, SIDRA, GIWA, BNB, TRX',
  payment_method:  'jazzcash, easypaisa, sadapay, nayapay',
  bank:            'hbl, mcb, ubl, allied, meezan, nbp',
  wallet_provider: 'trustwallet, metamask, phantom',
}

// ── Logo search helpers ───────────────────────────────────────────────────────

interface LogoCandidate {
  id:     string
  domain: string
  source: string
  url:    string
}

function generateDomainCandidates(input: string): string[] {
  const trimmed = input.trim().toLowerCase()
  if (trimmed.includes('.')) return [trimmed]

  // Strip common suffixes to get the core brand name
  const core = trimmed
    .replace(/\s+(bank|limited|pakistan|pvt|ltd|microfinance|digital|islamic|fintech|pay)\b/g, '')
    .replace(/[^a-z0-9]/g, '')

  const candidates: string[] = []

  // Try with the full input too (e.g. "jazzcash")
  const full = trimmed.replace(/[^a-z0-9]/g, '')
  if (full !== core) candidates.push(`${full}.com.pk`, `${full}.com`)

  candidates.push(
    `${core}.com.pk`,
    `${core}bank.com.pk`,
    `${core}.com`,
    `${core}bank.com`,
    `${core}.pk`,
  )

  return [...new Set(candidates)].slice(0, 4)
}

function buildCandidates(input: string): LogoCandidate[] {
  const domains = generateDomainCandidates(input)
  const out: LogoCandidate[] = []
  // Multi-source fallback: each candidate self-validates (faded card if the image
  // fails to load), so we offer several providers per domain and only the ones
  // that actually return an image stay visible.
  for (const domain of domains) {
    out.push({
      id:     `clearbit-${domain}`,
      domain,
      source: 'Clearbit',
      url:    `https://logo.clearbit.com/${domain}`,
    })
    out.push({
      id:     `horse-${domain}`,
      domain,
      source: 'icon.horse',
      url:    `https://icon.horse/icon/${domain}`,
    })
    out.push({
      id:     `gstatic-${domain}`,
      domain,
      source: 'Google favicon',
      url:    `https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://${domain}&size=128`,
    })
    out.push({
      id:     `ddg-${domain}`,
      domain,
      source: 'DuckDuckGo',
      url:    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
    })
  }
  // SimpleIcons (brand SVGs) — keyed by the normalized brand slug, not a domain.
  const brandSlug = input.trim().toLowerCase().replace(/\.[a-z.]+$/, '').replace(/[^a-z0-9]/g, '')
  if (brandSlug) {
    out.push({
      id:     `simpleicons-${brandSlug}`,
      domain: brandSlug,
      source: 'SimpleIcons',
      url:    `https://cdn.simpleicons.org/${brandSlug}`,
    })
  }
  return out
}

// ── Logo candidate card ───────────────────────────────────────────────────────

function CandidateCard({
  candidate,
  onSelect,
}: {
  candidate: LogoCandidate
  onSelect:  (url: string) => void
}) {
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')

  return (
    <div
      className={`border rounded-xl p-3 flex flex-col items-center gap-2 text-center transition-all w-36
        ${state === 'ok' ? 'border-border hover:border-primary bg-surface shadow-sm' : 'border-border/30 opacity-25'}
      `}
    >
      {/* Logo — larger preview */}
      <img
        src={candidate.url}
        alt={candidate.domain}
        className="w-16 h-16 rounded-xl object-contain"
        onLoad={() => setState('ok')}
        onError={() => setState('error')}
      />
      {state === 'ok' && (
        <>
          {/* Domain — clickable to verify it opens */}
          <a
            href={`https://${candidate.domain}`}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-primary hover:underline leading-tight break-all font-medium"
            title={`Open ${candidate.domain}`}
          >
            {candidate.domain}
          </a>
          {/* Source badge */}
          <span className="text-[10px] text-text-muted/70 bg-surface border border-border px-1.5 py-0.5 rounded-full leading-tight">
            {candidate.source}
          </span>
          {/* Actions row */}
          <div className="flex gap-1.5 w-full">
            <button
              onClick={() => onSelect(candidate.url)}
              className="flex-1 text-xs font-semibold text-white bg-primary hover:bg-primary/90 rounded-lg px-2 py-1 transition-colors"
            >
              Use this
            </button>
            <a
              href={candidate.url}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-medium text-text-muted hover:text-primary border border-border rounded-lg px-2 py-1 transition-colors"
              title="Open logo URL in new tab"
            >
              ↗
            </a>
          </div>
        </>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdminLogosPage() {
  const [entries, setEntries]       = useState<LogoRegistryEntry[]>([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState<string | null>(null)
  const [filterType, setFilterType] = useState<string>('')
  const [filterSlug, setFilterSlug] = useState('')

  // Add / edit form
  const [editingId, setEditingId]   = useState<string | null>(null)
  const [formType,  setFormType]    = useState<EntityType>('chain')
  const [formSlug,  setFormSlug]    = useState('')
  const [formUrl,   setFormUrl]     = useState('')
  const [saving,    setSaving]      = useState(false)
  const [saveMsg,   setSaveMsg]     = useState<string | null>(null)
  const formRef = useRef<HTMLDivElement>(null)

  // Inline delete confirmation
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleting,        setDeleting]        = useState(false)

  // Logo search
  const [searchQuery,      setSearchQuery]      = useState('')
  const [searchCandidates, setSearchCandidates] = useState<LogoCandidate[]>([])
  const [hasSearched,      setHasSearched]      = useState(false)

  // Collapsible panels — both start collapsed so the Registry table is the focus;
  // editing a row auto-expands the Add/Replace form (see startEdit).
  const [searchOpen, setSearchOpen] = useState(false)
  const [formOpen,   setFormOpen]   = useState(false)

  const { upload, uploading, error: uploadError } = useAdminLogoUpload()

  // ── Data loading ────────────────────────────────────────────────────────────

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

  // ── Form helpers ────────────────────────────────────────────────────────────

  function startEdit(entry: LogoRegistryEntry) {
    setEditingId(entry.id)
    setFormType(entry.type as EntityType)
    setFormSlug(entry.slug)
    setFormUrl(entry.logoUrl)
    setSaveMsg(null)
    setFormOpen(true)
    // Let the panel expand before scrolling to it.
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0)
  }

  function cancelEdit() {
    setEditingId(null)
    setFormType('chain')
    setFormSlug('')
    setFormUrl('')
    setSaveMsg(null)
  }

  // Validate that a URL actually resolves to a loadable, non-empty image before
  // we let it into the registry — no broken logos should ever be saved.
  function imageLoads(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      const img = new window.Image()
      const timer = setTimeout(() => resolve(false), 8000)
      img.onload = () => { clearTimeout(timer); resolve(img.naturalWidth > 0 && img.naturalHeight > 0) }
      img.onerror = () => { clearTimeout(timer); resolve(false) }
      img.src = url
    })
  }

  async function handleSave() {
    if (!formSlug.trim() || !formUrl.trim()) {
      setSaveMsg('Slug and Logo URL are required.')
      return
    }
    setSaving(true)
    setSaveMsg(null)
    try {
      const ok = await imageLoads(formUrl.trim())
      if (!ok) {
        setSaveMsg('That logo URL did not load as a valid image. Pick another source or upload a file.')
        setSaving(false)
        return
      }
      await logoApi.adminUpsert({ type: formType, slug: formSlug.trim(), logoUrl: formUrl.trim() })
      invalidateLogoCache()
      setSaveMsg('Saved successfully.')
      cancelEdit()
      await load()
    } catch {
      setSaveMsg('Save failed. Check the URL and try again.')
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

  // ── Delete ──────────────────────────────────────────────────────────────────

  async function confirmDelete(id: string) {
    setDeleting(true)
    try {
      await logoApi.adminDelete(id)
      invalidateLogoCache()
      setEntries((prev) => prev.filter((e) => e.id !== id))
      setConfirmDeleteId(null)
    } catch {
      alert('Delete failed. Please try again.')
    } finally {
      setDeleting(false)
    }
  }

  // ── Logo search ─────────────────────────────────────────────────────────────

  function handleSearch() {
    if (!searchQuery.trim()) return
    const candidates = buildCandidates(searchQuery.trim())
    setSearchCandidates(candidates)
    setHasSearched(true)
  }

  function handleSelectCandidate(url: string) {
    setFormUrl(url)
    setSaveMsg(null)
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const filtered = entries.filter((e) => {
    if (filterType && e.type !== filterType) return false
    if (filterSlug && !e.slug.toLowerCase().includes(filterSlug.toLowerCase())) return false
    return true
  })

  const isEditing = editingId !== null
  const editingEntry = isEditing ? entries.find((e) => e.id === editingId) : null

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Logo Registry</h1>
        <p className="text-text-muted text-sm mt-1">
          Logos uploaded here appear everywhere that entity is shown across the site —
          payment method pickers, trade pages, CTM, marketplace, and admin panels.
        </p>
      </div>

      {/* ── Search logos from web ───────────────────────────────────────────── */}
      <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-5 space-y-4">
        <button
          type="button"
          onClick={() => setSearchOpen((v) => !v)}
          className="w-full flex items-start justify-between gap-3 text-left"
        >
          <div>
            <h2 className="font-semibold text-blue-900 dark:text-blue-200">Search Logos from Web</h2>
            <p className="text-xs text-blue-700 dark:text-blue-300 mt-0.5">
              Type a brand name or domain — we try multiple sources and show what&apos;s available. Click &quot;Use this&quot; to fill the form below.
            </p>
          </div>
          <span className={`text-blue-700 dark:text-blue-300 shrink-0 transition-transform ${searchOpen ? 'rotate-180' : ''}`}>▾</span>
        </button>

        {searchOpen && (<>
        <div className="flex gap-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="e.g. Meezan Bank, meezanbank.com, SadaPay…"
            className="flex-1 border border-blue-500/40 rounded-lg px-3 py-2 text-sm bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-blue-400/40"
          />
          <button
            onClick={handleSearch}
            disabled={!searchQuery.trim()}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-40 transition-colors whitespace-nowrap"
          >
            Find Logos
          </button>
        </div>

        {hasSearched && (
          <div>
            {searchCandidates.length === 0 ? (
              <p className="text-sm text-blue-700 dark:text-blue-300">No candidates found. Try entering the website domain directly (e.g. meezanbank.com).</p>
            ) : (
              <div className="flex flex-wrap gap-3">
                {searchCandidates.map((c) => (
                  <CandidateCard
                    key={c.id}
                    candidate={c}
                    onSelect={handleSelectCandidate}
                  />
                ))}
              </div>
            )}
            <p className="text-xs text-blue-600 dark:text-blue-400 mt-2">
              Faded cards = logo not found at that source. Only visible cards have a real logo.
            </p>
          </div>
        )}
        </>)}
      </div>

      {/* ── Add / Edit form ─────────────────────────────────────────────────── */}
      <div
        ref={formRef}
        className={`border rounded-xl p-5 space-y-4 transition-colors ${
          isEditing
            ? 'bg-amber-500/10 border-amber-500/40'
            : 'bg-surface border-border'
        }`}
      >
        {/* Mode header — chevron on the right, consistent with the search panel */}
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setFormOpen((v) => !v)}
            className="flex-1 flex items-start gap-2 text-left min-w-0"
          >
            <span className="min-w-0">
              <span className="block font-semibold text-text-primary">
                {isEditing ? 'Edit Logo' : 'Add / Replace Logo'}
              </span>
              {isEditing && editingEntry && (
                <span className="block text-xs text-amber-700 dark:text-amber-300 mt-0.5">
                  Editing: <span className="font-mono font-semibold">{editingEntry.type} / {editingEntry.slug}</span>
                </span>
              )}
            </span>
          </button>
          <div className="flex items-center gap-2 shrink-0">
            {isEditing && (
              <button
                onClick={cancelEdit}
                className="text-xs text-text-muted hover:text-text-primary border border-border rounded-lg px-3 py-1.5 transition-colors"
              >
                Cancel edit
              </button>
            )}
            <button
              type="button"
              onClick={() => setFormOpen((v) => !v)}
              aria-label={formOpen ? 'Collapse form' : 'Expand form'}
              aria-expanded={formOpen}
              className="w-8 h-8 flex items-center justify-center rounded-lg border border-border text-text-muted hover:text-text-primary hover:bg-surface transition-colors"
            >
              <span className={`text-base leading-none transition-transform ${formOpen ? 'rotate-180' : ''}`}>▾</span>
            </button>
          </div>
        </div>

        {formOpen && (<>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Entity type</label>
            <select
              value={formType}
              onChange={(e) => { setFormType(e.target.value as EntityType); if (!isEditing) setFormSlug('') }}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
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
            placeholder="https://… paste URL or use Search above, or upload below"
            className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>

        {/* Live preview */}
        {formUrl && (
          <div className="flex items-center gap-3 p-3 bg-surface border border-border rounded-lg">
            <EntityLogo type={formType} slug={formSlug || '?'} size="xl" logoUrl={formUrl} />
            <div>
              <p className="text-xs font-medium text-text-primary">Preview</p>
              <p className="text-xs text-text-muted truncate max-w-xs">{formUrl}</p>
            </div>
          </div>
        )}

        {/* Upload */}
        <div>
          <label className="block text-xs font-medium text-text-muted mb-1">
            Or upload a file (PNG / JPG / SVG / WebP · max 2 MB)
          </label>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            onChange={handleUpload}
            disabled={uploading}
            className="text-sm"
          />
          {uploading && <p className="text-xs text-text-muted mt-1">Uploading to Cloudinary…</p>}
          {uploadError && <p className="text-xs text-danger mt-1">{uploadError}</p>}
        </div>

        {saveMsg && (
          <p className={`text-sm font-medium ${saveMsg.startsWith('Saved') ? 'text-success' : 'text-danger'}`}>
            {saveMsg}
          </p>
        )}

        <div className="flex gap-3">
          <button
            onClick={handleSave}
            disabled={saving || uploading || !formSlug.trim() || !formUrl.trim()}
            className="bg-primary text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-primary/90 disabled:opacity-40 transition-colors"
          >
            {saving ? 'Saving…' : isEditing ? 'Update Logo' : 'Save Logo'}
          </button>
          {isEditing && (
            <button
              onClick={cancelEdit}
              className="border border-border text-text-primary px-5 py-2 rounded-lg text-sm font-semibold hover:bg-surface transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
        </>)}
      </div>

      {/* ── Registry table ─────────────────────────────────────────────────── */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="p-4 border-b border-border flex flex-wrap gap-3 items-center justify-between">
          <h2 className="font-semibold text-text-primary">
            Registry <span className="text-text-muted font-normal">({filtered.length} entries)</span>
          </h2>
          <div className="flex gap-2">
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="border border-border rounded-lg px-3 py-1.5 text-sm bg-surface text-text-primary focus:outline-none"
            >
              <option value="">All types</option>
              {ENTITY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <input
              type="text"
              value={filterSlug}
              onChange={(e) => setFilterSlug(e.target.value)}
              placeholder="Search slug…"
              className="border border-border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 w-36"
            />
          </div>
        </div>

        {loading ? (
          <div className="p-10 text-center text-text-muted text-sm">Loading…</div>
        ) : error ? (
          <div className="p-10 text-center text-danger text-sm">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-text-muted text-sm">
            No registry entries yet.{' '}
            {filterType || filterSlug ? 'Try clearing the filters.' : 'Use the form above to add logos.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-raised text-text-muted text-xs border-b border-border">
                <tr>
                  <th className="px-4 py-3 text-left font-medium w-14">Logo</th>
                  <th className="px-4 py-3 text-left font-medium">Type</th>
                  <th className="px-4 py-3 text-left font-medium">Slug</th>
                  <th className="px-4 py-3 text-left font-medium hidden md:table-cell">URL</th>
                  <th className="px-4 py-3 text-left font-medium w-36">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((entry) => (
                  <tr
                    key={entry.id}
                    className={`transition-colors ${
                      editingId === entry.id
                        ? 'bg-amber-500/10'
                        : 'hover:bg-surface-raised/40'
                    }`}
                  >
                    <td className="px-4 py-3">
                      <a href={entry.logoUrl} target="_blank" rel="noreferrer" title="Open logo in new tab">
                        <EntityLogo
                          type={entry.type as EntityType}
                          slug={entry.slug}
                          size="lg"
                          logoUrl={entry.logoUrl}
                          className="hover:opacity-80 transition-opacity"
                        />
                      </a>
                    </td>
                    <td className="px-4 py-3">
                      <span className="bg-primary/10 text-primary text-xs px-2 py-0.5 rounded font-medium">
                        {entry.type}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono font-medium text-text-primary">{entry.slug}</td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <a
                        href={entry.logoUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline text-xs truncate block max-w-[220px]"
                        title={entry.logoUrl}
                      >
                        {entry.logoUrl.length > 50 ? entry.logoUrl.slice(0, 50) + '…' : entry.logoUrl}
                      </a>
                    </td>
                    <td className="px-4 py-3">
                      {confirmDeleteId === entry.id ? (
                        /* Inline delete confirmation */
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-danger font-medium">Delete?</span>
                          <button
                            onClick={() => confirmDelete(entry.id)}
                            disabled={deleting}
                            className="text-xs bg-danger text-white rounded px-2 py-1 hover:bg-danger/90 disabled:opacity-50 transition-colors"
                          >
                            {deleting ? '…' : 'Yes'}
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className="text-xs border border-border rounded px-2 py-1 hover:bg-surface transition-colors"
                          >
                            No
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => startEdit(entry)}
                            className="text-xs font-medium text-primary hover:underline px-0 py-0"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(entry.id)}
                            className="text-xs font-medium text-danger hover:underline px-0 py-0"
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-xs text-text-muted">
        Logos uploaded in Gas Chains, Gas Tokens, and CTM Tokens are served by the same API but managed on those pages, not listed here.
      </p>
    </div>
  )
}
