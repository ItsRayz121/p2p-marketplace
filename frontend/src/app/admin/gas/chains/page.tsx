'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import { adminApi, type AdminGasChain, type AdminGasToken } from '@/lib/api'
import { useAdminLogoUpload } from '@/hooks/useAdminLogoUpload'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { useAuthStore } from '@/store/auth.store'

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = 'chains' | 'tokens'

// ─── Chain Form ───────────────────────────────────────────────────────────────

interface ChainFormState {
  name: string
  slug: string
  symbol: string
  category: string
  networkLabel: string
  addressType: string
  logoUrl: string
  explorerBase: string
  backendChainId: string
  platformFeeUsdt: string
  alertThresholdUsd: string
  pauseThresholdUsd: string
  displayOrder: string
  isActive: boolean
  readinessState: string
}

const BLANK_CHAIN: ChainFormState = {
  name: '', slug: '', symbol: '', category: '', networkLabel: '',
  addressType: 'EVM', logoUrl: '', explorerBase: '', backendChainId: '',
  platformFeeUsdt: '0.25', alertThresholdUsd: '', pauseThresholdUsd: '',
  displayOrder: '0', isActive: false, readinessState: 'inactive',
}

// ─── Token Form ───────────────────────────────────────────────────────────────

interface TokenFormState {
  chainConfigId: string
  name: string
  symbol: string
  tokenType: string
  contractAddress: string
  logoUrl: string
  priceSymbol: string
  minAmount: string
  maxUsdValue: string
  presetAmounts: string
  displayOrder: string
  isActive: boolean
}

const BLANK_TOKEN: TokenFormState = {
  chainConfigId: '', name: '', symbol: '', tokenType: 'native',
  contractAddress: '', logoUrl: '', priceSymbol: '', minAmount: '0.1',
  maxUsdValue: '10', presetAmounts: '', displayOrder: '0', isActive: true,
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function presetDisplay(amounts: number[]): string {
  return Array.isArray(amounts) ? amounts.join(', ') : ''
}

function isNonDirectImageUrl(url: string): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    const blockedHosts = ['drive.google.com', 'share.google.com', 'docs.google.com']
    if (blockedHosts.some((h) => u.hostname === h || u.hostname.endsWith('.' + h))) return true
    const imageExts = ['.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif']
    const hasImageExt = imageExts.some((ext) => u.pathname.toLowerCase().endsWith(ext))
    const trustedHosts = ['res.cloudinary.com', 'githubusercontent.com', 'cryptologos.cc', 'icons8.com']
    const isTrustedHost = trustedHosts.some((h) => u.hostname.includes(h))
    return !hasImageExt && !isTrustedHost
  } catch {
    return false
  }
}

// ─── Logo Upload Field ────────────────────────────────────────────────────────

function LogoUploadField({
  logoUrl,
  onLogoUrlChange,
}: {
  logoUrl: string
  onLogoUrlChange: (url: string) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const { upload, uploading, error: uploadError } = useAdminLogoUpload()
  const [imgError, setImgError] = useState(false)

  const urlWarn = isNonDirectImageUrl(logoUrl)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImgError(false)
    try {
      const url = await upload(file)
      onLogoUrlChange(url)
    } catch { /* error shown via uploadError */ }
    e.target.value = ''
  }

  return (
    <div className="col-span-2 space-y-2">
      <label className="text-xs font-medium text-text-muted block">Logo</label>

      {/* Preview */}
      {logoUrl && !imgError && (
        <div className="flex items-center gap-3 p-2 bg-surface rounded-lg border border-border">
          <img
            src={logoUrl}
            alt="Logo preview"
            className="w-10 h-10 rounded-full object-contain border border-border"
            onError={() => setImgError(true)}
          />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-text-muted truncate">{logoUrl}</p>
          </div>
          <button
            type="button"
            onClick={() => { onLogoUrlChange(''); setImgError(false) }}
            className="text-danger text-xs hover:underline flex-shrink-0"
          >
            Remove
          </button>
        </div>
      )}
      {logoUrl && imgError && (
        <div className="flex items-center gap-2 px-3 py-2 bg-danger/10 border border-danger/20 rounded-lg text-danger text-xs">
          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          Image failed to load — URL may be broken or blocked by CORS.
        </div>
      )}

      {/* Upload button */}
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden" onChange={handleFile} />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        className="w-full py-2 border-2 border-dashed border-border rounded-lg text-sm text-text-muted hover:border-primary hover:text-primary transition-colors disabled:opacity-50"
      >
        {uploading ? 'Uploading...' : logoUrl ? 'Replace with upload (PNG/JPG/SVG/WebP · max 2MB)' : 'Upload logo (PNG/JPG/SVG/WebP · max 2MB)'}
      </button>

      {/* Or paste URL */}
      <div>
        <label className="text-xs font-medium text-text-muted block mb-1">Or paste direct image URL</label>
        <input
          type="url"
          placeholder="https://example.com/logo.png"
          value={logoUrl}
          onChange={(e) => { onLogoUrlChange(e.target.value); setImgError(false) }}
          className="w-full border border-border rounded-lg px-3 py-2 text-sm"
        />
        {urlWarn && (
          <p className="text-xs text-warning mt-1">
            Warning: this URL does not look like a direct image link. Google Drive share links are not supported — use a direct CDN or upload the file instead.
          </p>
        )}
      </div>

      {uploadError && <p className="text-xs text-danger">{uploadError}</p>}
    </div>
  )
}

function parsePresets(raw: string): number[] {
  return raw.split(',').map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n) && n > 0)
}

// ─── Chain Modal ─────────────────────────────────────────────────────────────

function ChainModal({
  editing,
  form,
  setForm,
  onSave,
  onClose,
  saving,
  error,
}: {
  editing: AdminGasChain | null
  form: ChainFormState
  setForm: (f: ChainFormState) => void
  onSave: () => void
  onClose: () => void
  saving: boolean
  error: string
}) {
  function field(key: keyof ChainFormState) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm({ ...form, [key]: e.target.value })
  }

  function setLogoUrl(url: string) { setForm({ ...form, logoUrl: url }) }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="p-6 space-y-4">
          <h2 className="text-lg font-bold text-text-primary">
            {editing ? `Edit: ${editing.name}` : 'Add New Chain'}
          </h2>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-xs font-medium text-text-muted block mb-1">Chain Name *</label>
              <Input placeholder="e.g. TRON" value={form.name} onChange={field('name')} />
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Slug (unique ID) *</label>
              <Input placeholder="e.g. TRON" value={form.slug} onChange={field('slug')} disabled={!!editing} />
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Native Symbol *</label>
              <Input placeholder="e.g. TRX" value={form.symbol} onChange={field('symbol')} />
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Category *</label>
              <select className="w-full border border-border rounded-lg px-3 py-2 text-sm" value={form.category} onChange={field('category')}>
                <option value="">Select...</option>
                <option value="tron">TRON</option>
                <option value="bnb">BNB</option>
                <option value="ethereum">Ethereum</option>
                <option value="solana">Solana</option>
                <option value="sui">SUI</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Network Label *</label>
              <Input placeholder="e.g. TRC20" value={form.networkLabel} onChange={field('networkLabel')} />
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Address Type *</label>
              <select className="w-full border border-border rounded-lg px-3 py-2 text-sm" value={form.addressType} onChange={field('addressType')}>
                <option value="EVM">EVM (0x...)</option>
                <option value="TRC20">TRC20 (T...)</option>
                <option value="SOL">Solana (Base58)</option>
                <option value="SUI">SUI (0x64...)</option>
                <option value="TON">TON (UQ.../EQ...)</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Backend Chain ID</label>
              <select className="w-full border border-border rounded-lg px-3 py-2 text-sm" value={form.backendChainId} onChange={field('backendChainId')}>
                <option value="">Not deliverable yet</option>
                <option value="TRON">TRON</option>
                <option value="BSC">BSC</option>
                <option value="ETH">ETH</option>
                <option value="BASE">BASE</option>
                <option value="ARB">ARB</option>
                <option value="OP">OP</option>
                <option value="MATIC">MATIC</option>
                <option value="AVAX">AVAX</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Fixed Platform Fee (USDT)</label>
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder="e.g. 0.25"
                value={form.platformFeeUsdt}
                onChange={field('platformFeeUsdt')}
              />
              <p className="text-xs text-text-muted mt-0.5">Fixed USDT fee added per order (e.g. 0.25 = $0.25)</p>
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Alert Threshold (USD)</label>
              <Input
                type="number"
                min="0"
                step="1"
                placeholder="e.g. 50"
                value={form.alertThresholdUsd}
                onChange={field('alertThresholdUsd')}
              />
              <p className="text-xs text-text-muted mt-0.5">Send alert email below this USD balance</p>
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Pause Threshold (USD)</label>
              <Input
                type="number"
                min="0"
                step="1"
                placeholder="e.g. 10"
                value={form.pauseThresholdUsd}
                onChange={field('pauseThresholdUsd')}
              />
              <p className="text-xs text-text-muted mt-0.5">Wallet auto-pauses below this USD balance.</p>
            </div>
            <LogoUploadField logoUrl={form.logoUrl} onLogoUrlChange={setLogoUrl} />
            <div className="col-span-2">
              <label className="text-xs font-medium text-text-muted block mb-1">Explorer Base URL</label>
              <Input placeholder="https://tronscan.org/#" value={form.explorerBase} onChange={field('explorerBase')} />
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Display Order</label>
              <Input type="number" value={form.displayOrder} onChange={field('displayOrder')} />
            </div>
            <div className="flex items-center gap-2 pt-5">
              <input
                id="chain-active"
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                className="w-4 h-4 accent-primary"
              />
              <label htmlFor="chain-active" className="text-sm font-medium text-text-primary">Active</label>
            </div>
            <div className="col-span-2">
              <label className="text-xs font-medium text-text-muted block mb-1">Readiness State</label>
              <select
                className="w-full border border-border rounded-lg px-3 py-2 text-sm"
                value={form.readinessState}
                onChange={field('readinessState')}
              >
                <option value="inactive">Inactive — hidden from public, not orderable</option>
                <option value="testing">Testing — hidden from public, internal only</option>
                <option value="beta">Beta — visible with Beta badge, orderable</option>
                <option value="stable">Stable — visible with Stable badge, orderable</option>
              </select>
              <p className="text-xs text-text-muted mt-0.5">Controls frontend badge and whether chain appears on the public gas page.</p>
            </div>
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-3 pt-2">
            <Button variant="secondary" className="flex-1" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button className="flex-1" onClick={onSave} disabled={saving || !form.name || !form.slug || !form.symbol}>
              {saving ? 'Saving...' : editing ? 'Save Changes' : 'Create Chain'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Token Modal ─────────────────────────────────────────────────────────────

function TokenModal({
  editing,
  form,
  setForm,
  chains,
  onSave,
  onClose,
  saving,
  error,
}: {
  editing: AdminGasToken | null
  form: TokenFormState
  setForm: (f: TokenFormState) => void
  chains: AdminGasChain[]
  onSave: () => void
  onClose: () => void
  saving: boolean
  error: string
}) {
  function field(key: keyof TokenFormState) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm({ ...form, [key]: e.target.value })
  }

  function setLogoUrl(url: string) { setForm({ ...form, logoUrl: url }) }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="p-6 space-y-4">
          <h2 className="text-lg font-bold text-text-primary">
            {editing ? `Edit: ${editing.name}` : 'Add New Token'}
          </h2>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-xs font-medium text-text-muted block mb-1">Chain *</label>
              <select className="w-full border border-border rounded-lg px-3 py-2 text-sm" value={form.chainConfigId} onChange={field('chainConfigId')} disabled={!!editing}>
                <option value="">Select chain...</option>
                {chains.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.slug})</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Token Name *</label>
              <Input placeholder="e.g. TRX" value={form.name} onChange={field('name')} />
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Symbol *</label>
              <Input placeholder="e.g. TRX" value={form.symbol} onChange={field('symbol')} />
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Token Type *</label>
              <select className="w-full border border-border rounded-lg px-3 py-2 text-sm" value={form.tokenType} onChange={field('tokenType')}>
                <option value="native">Native Gas</option>
                <option value="token">Token (ERC20/TRC20)</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Price Symbol *</label>
              <Input placeholder="e.g. TRX, BNB, ETH" value={form.priceSymbol} onChange={field('priceSymbol')} />
            </div>
            <div className="col-span-2">
              <label className="text-xs font-medium text-text-muted block mb-1">Contract Address</label>
              <Input placeholder="0x... or T... (leave blank for native)" value={form.contractAddress} onChange={field('contractAddress')} />
            </div>
            <LogoUploadField logoUrl={form.logoUrl} onLogoUrlChange={setLogoUrl} />
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Min Amount *</label>
              <Input type="number" step="any" value={form.minAmount} onChange={field('minAmount')} />
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Max USD Value *</label>
              <Input type="number" value={form.maxUsdValue} onChange={field('maxUsdValue')} />
            </div>
            <div className="col-span-2">
              <label className="text-xs font-medium text-text-muted block mb-1">
                Preset Amounts (comma-separated) *
              </label>
              <Input placeholder="10, 50, 100, 200" value={form.presetAmounts} onChange={field('presetAmounts')} />
              <p className="text-xs text-text-muted mt-1">These appear as quick-select buttons on the buy page.</p>
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Display Order</label>
              <Input type="number" value={form.displayOrder} onChange={field('displayOrder')} />
            </div>
            <div className="flex items-center gap-2 pt-5">
              <input
                id="token-active"
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                className="w-4 h-4 accent-primary"
              />
              <label htmlFor="token-active" className="text-sm font-medium text-text-primary">Active</label>
            </div>
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-3 pt-2">
            <Button variant="secondary" className="flex-1" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button className="flex-1" onClick={onSave} disabled={saving || !form.name || !form.chainConfigId || !form.priceSymbol}>
              {saving ? 'Saving...' : editing ? 'Save Changes' : 'Create Token'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function GasChainsAdminPage() {
  const user = useAuthStore((s) => s.user)
  const isSuperAdmin = user?.role === 'super_admin'

  const [tab, setTab] = useState<Tab>('chains')

  // Chains state
  const [chains, setChains] = useState<AdminGasChain[]>([])
  const [chainsLoading, setChainsLoading] = useState(true)
  const [chainsError, setChainsError] = useState<string | null>(null)

  // Tokens state
  const [tokens, setTokens] = useState<AdminGasToken[]>([])
  const [tokensLoading, setTokensLoading] = useState(false)
  const [tokensError, setTokensError] = useState<string | null>(null)

  // Chain modal
  const [showChainModal, setShowChainModal] = useState(false)
  const [editingChain, setEditingChain] = useState<AdminGasChain | null>(null)
  const [chainForm, setChainForm] = useState<ChainFormState>(BLANK_CHAIN)
  const [chainSaving, setChainSaving] = useState(false)
  const [chainFormError, setChainFormError] = useState('')

  // Token modal
  const [showTokenModal, setShowTokenModal] = useState(false)
  const [editingToken, setEditingToken] = useState<AdminGasToken | null>(null)
  const [tokenForm, setTokenForm] = useState<TokenFormState>(BLANK_TOKEN)
  const [tokenSaving, setTokenSaving] = useState(false)
  const [tokenFormError, setTokenFormError] = useState('')

  // Delete confirms
  const [confirmDeleteChain, setConfirmDeleteChain] = useState<AdminGasChain | null>(null)
  const [confirmDeleteToken, setConfirmDeleteToken] = useState<AdminGasToken | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Global success/error
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const fetchChains = useCallback(async () => {
    setChainsLoading(true)
    setChainsError(null)
    try {
      const { chains: c } = await adminApi.getGasChains()
      setChains(c)
    } catch (e: unknown) {
      setChainsError(e instanceof Error ? e.message : 'Failed to load chains')
    } finally {
      setChainsLoading(false)
    }
  }, [])

  const fetchTokens = useCallback(async () => {
    setTokensLoading(true)
    setTokensError(null)
    try {
      const { tokens: t } = await adminApi.getGasTokens()
      setTokens(t)
    } catch (e: unknown) {
      setTokensError(e instanceof Error ? e.message : 'Failed to load tokens')
    } finally {
      setTokensLoading(false)
    }
  }, [])

  useEffect(() => { fetchChains() }, [fetchChains])
  useEffect(() => { if (tab === 'tokens') fetchTokens() }, [tab, fetchTokens])

  function flash(msg: string) {
    setSuccessMsg(msg)
    setTimeout(() => setSuccessMsg(null), 3500)
  }

  // ── Chain CRUD ──────────────────────────────────────────────────────────────

  function openAddChain() {
    setEditingChain(null)
    setChainForm(BLANK_CHAIN)
    setChainFormError('')
    setShowChainModal(true)
  }

  function openEditChain(c: AdminGasChain) {
    setEditingChain(c)
    setChainForm({
      name: c.name,
      slug: c.slug,
      symbol: c.symbol,
      category: c.category,
      networkLabel: c.networkLabel,
      addressType: c.addressType,
      logoUrl: c.logoUrl ?? '',
      explorerBase: c.explorerBase ?? '',
      backendChainId: c.backendChainId ?? '',
      platformFeeUsdt: String(c.platformFeeUsdt ?? 0.25),
      alertThresholdUsd: c.alertThresholdUsd != null ? String(c.alertThresholdUsd) : '',
      pauseThresholdUsd: c.pauseThresholdUsd != null ? String(c.pauseThresholdUsd) : '',
      displayOrder: String(c.displayOrder),
      isActive: c.isActive,
      readinessState: c.readinessState ?? 'inactive',
    })
    setChainFormError('')
    setShowChainModal(true)
  }

  async function saveChain() {
    setChainSaving(true)
    setChainFormError('')
    try {
      const payload = {
        name: chainForm.name,
        slug: chainForm.slug.toUpperCase(),
        symbol: chainForm.symbol,
        category: chainForm.category,
        networkLabel: chainForm.networkLabel,
        addressType: chainForm.addressType,
        logoUrl: chainForm.logoUrl || null,
        explorerBase: chainForm.explorerBase || null,
        backendChainId: chainForm.backendChainId || null,
        platformFeeUsdt: parseFloat(chainForm.platformFeeUsdt) || 0,
        alertThresholdUsd: chainForm.alertThresholdUsd ? parseFloat(chainForm.alertThresholdUsd) : null,
        pauseThresholdUsd: chainForm.pauseThresholdUsd ? parseFloat(chainForm.pauseThresholdUsd) : null,
        displayOrder: parseInt(chainForm.displayOrder) || 0,
        isActive: chainForm.isActive,
        readinessState: chainForm.readinessState,
      }
      if (editingChain) {
        await adminApi.updateGasChain(editingChain.id, payload)
        flash('Chain updated.')
      } else {
        await adminApi.createGasChain(payload)
        flash('Chain created.')
      }
      setShowChainModal(false)
      fetchChains()
    } catch (e: unknown) {
      setChainFormError(e instanceof Error ? e.message : 'Failed to save chain')
    } finally {
      setChainSaving(false)
    }
  }

  async function deleteChain(c: AdminGasChain) {
    setDeleting(true)
    setErrorMsg(null)
    try {
      await adminApi.deleteGasChain(c.id)
      flash(`Chain "${c.name}" deleted.`)
      setConfirmDeleteChain(null)
      fetchChains()
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : 'Failed to delete chain')
    } finally {
      setDeleting(false)
    }
  }

  // ── Token CRUD ──────────────────────────────────────────────────────────────

  function openAddToken(preselectedChainId?: string) {
    setEditingToken(null)
    setTokenForm({ ...BLANK_TOKEN, chainConfigId: preselectedChainId ?? '' })
    setTokenFormError('')
    setShowTokenModal(true)
  }

  function openEditToken(t: AdminGasToken) {
    setEditingToken(t)
    setTokenForm({
      chainConfigId: t.chainConfigId,
      name: t.name,
      symbol: t.symbol,
      tokenType: t.tokenType,
      contractAddress: t.contractAddress ?? '',
      logoUrl: t.logoUrl ?? '',
      priceSymbol: t.priceSymbol,
      minAmount: String(t.minAmount),
      maxUsdValue: String(t.maxUsdValue),
      presetAmounts: presetDisplay(t.presetAmounts),
      displayOrder: String(t.displayOrder),
      isActive: t.isActive,
    })
    setTokenFormError('')
    setShowTokenModal(true)
  }

  async function saveToken() {
    setTokenSaving(true)
    setTokenFormError('')
    try {
      const presets = parsePresets(tokenForm.presetAmounts)
      if (presets.length === 0) { setTokenFormError('Enter at least one preset amount'); return }
      const payload = {
        chainConfigId: tokenForm.chainConfigId,
        name: tokenForm.name,
        symbol: tokenForm.symbol,
        tokenType: tokenForm.tokenType,
        contractAddress: tokenForm.contractAddress || null,
        logoUrl: tokenForm.logoUrl || null,
        priceSymbol: tokenForm.priceSymbol,
        minAmount: parseFloat(tokenForm.minAmount),
        maxUsdValue: parseFloat(tokenForm.maxUsdValue),
        presetAmounts: presets,
        displayOrder: parseInt(tokenForm.displayOrder) || 0,
        isActive: tokenForm.isActive,
      }
      if (editingToken) {
        await adminApi.updateGasToken(editingToken.id, payload)
        flash('Token updated.')
      } else {
        await adminApi.createGasToken(payload)
        flash('Token created.')
      }
      setShowTokenModal(false)
      fetchTokens()
    } catch (e: unknown) {
      setTokenFormError(e instanceof Error ? e.message : 'Failed to save token')
    } finally {
      setTokenSaving(false)
    }
  }

  async function deleteToken(t: AdminGasToken) {
    setDeleting(true)
    setErrorMsg(null)
    try {
      await adminApi.deleteGasToken(t.id)
      flash(`Token "${t.name}" deleted.`)
      setConfirmDeleteToken(null)
      fetchTokens()
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : 'Failed to delete token')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Crypto Gas Fee Config</h1>
          <p className="text-text-muted text-sm mt-0.5">
            Manage crypto gas fee chains and tokens — changes appear on the Buy Gas page immediately.
          </p>
        </div>
      </div>

      {/* Alerts */}
      {successMsg && (
        <div className="px-4 py-3 bg-success/10 border border-success/20 rounded-xl text-success text-sm">{successMsg}</div>
      )}
      {errorMsg && (
        <div className="px-4 py-3 bg-danger/10 border border-danger/20 rounded-xl text-danger text-sm">{errorMsg}</div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 border-b border-border">
        {(['chains', 'tokens'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t ? 'border-primary text-primary' : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
          >
            {t === 'chains' ? 'Chains' : 'Tokens'}
          </button>
        ))}
      </div>

      {/* ── Chains Tab ─────────────────────────────────────────────────────── */}
      {tab === 'chains' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            {isSuperAdmin && (
              <Button onClick={openAddChain} size="sm">+ Add Chain</Button>
            )}
          </div>

          {chainsLoading && <LoadingState message="Loading chains..." />}
          {chainsError && <ErrorState title={chainsError} onRetry={fetchChains} />}

          {!chainsLoading && !chainsError && chains.length === 0 && (
            <EmptyState title="No chains configured" description="Add a chain to get started." />
          )}

          {!chainsLoading && chains.length > 0 && (
            <div className="bg-white rounded-xl border border-border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-surface border-b border-border">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Chain</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Slug</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Category</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Backend</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Fee %</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Tokens</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Readiness</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Order</th>
                      <th className="px-4 py-3 text-right font-medium text-text-muted">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {chains.map((c) => (
                      <tr key={c.id} className="hover:bg-surface/50 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            {c.logoUrl && (
                              <img
                                src={c.logoUrl}
                                alt={c.symbol}
                                className="w-6 h-6 rounded-full object-contain"
                                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                              />
                            )}
                            <span className="font-medium text-text-primary">{c.name}</span>
                            <span className="text-text-muted text-xs">({c.symbol})</span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <code className="text-xs bg-surface px-1.5 py-0.5 rounded">{c.slug}</code>
                        </td>
                        <td className="px-4 py-3 text-text-muted capitalize">{c.category}</td>
                        <td className="px-4 py-3">
                          {c.backendChainId
                            ? <Badge variant="success" size="sm">{c.backendChainId}</Badge>
                            : <Badge variant="default" size="sm">Not Set</Badge>}
                        </td>
                        <td className="px-4 py-3">
                          <div className="text-sm font-semibold text-text-primary">${c.platformFeeUsdt ?? 0.25} USDT</div>
                          {c.alertThresholdUsd != null && (
                            <div className="text-xs text-text-muted">Alert ${ c.alertThresholdUsd} / Pause ${c.pauseThresholdUsd ?? '—'}</div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-text-muted">{c._count?.tokens ?? c.tokens?.length ?? 0}</td>
                        <td className="px-4 py-3">
                          <Badge variant={c.isActive ? 'success' : 'default'} size="sm">
                            {c.isActive ? 'Active' : 'Inactive'}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          {c.readinessState === 'stable'
                            ? <Badge variant="success" size="sm">Stable</Badge>
                            : c.readinessState === 'beta'
                            ? <Badge variant="warning" size="sm">Beta</Badge>
                            : c.readinessState === 'testing'
                            ? <Badge variant="warning" size="sm">Testing</Badge>
                            : <Badge variant="default" size="sm">Inactive</Badge>
                          }
                        </td>
                        <td className="px-4 py-3 text-text-muted">{c.displayOrder}</td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button size="sm" variant="ghost" onClick={() => openEditChain(c)}>Edit</Button>
                            <Button size="sm" variant="ghost" onClick={() => { setTab('tokens'); openAddToken(c.id) }}>
                              + Token
                            </Button>
                            {isSuperAdmin && (
                              <Button size="sm" variant="ghost" onClick={() => setConfirmDeleteChain(c)}>
                                Delete
                              </Button>
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
        </div>
      )}

      {/* ── Tokens Tab ─────────────────────────────────────────────────────── */}
      {tab === 'tokens' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            {isSuperAdmin && (
              <Button onClick={() => openAddToken()} size="sm">+ Add Token</Button>
            )}
          </div>

          {tokensLoading && <LoadingState message="Loading tokens..." />}
          {tokensError && <ErrorState title={tokensError} onRetry={fetchTokens} />}

          {!tokensLoading && !tokensError && tokens.length === 0 && (
            <EmptyState title="No tokens configured" description="Add a token to a chain." />
          )}

          {!tokensLoading && tokens.length > 0 && (
            <div className="bg-white rounded-xl border border-border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-surface border-b border-border">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Token</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Chain</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Type</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Price Symbol</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Min</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Max $</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Presets</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
                      <th className="px-4 py-3 text-right font-medium text-text-muted">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {tokens.map((t) => (
                      <tr key={t.id} className="hover:bg-surface/50 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            {t.logoUrl && (
                              <img
                                src={t.logoUrl}
                                alt={t.symbol}
                                className="w-5 h-5 rounded-full object-contain"
                                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                              />
                            )}
                            <span className="font-medium text-text-primary">{t.name}</span>
                            <span className="text-text-muted text-xs">({t.symbol})</span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <code className="text-xs bg-surface px-1.5 py-0.5 rounded">{t.chain?.slug}</code>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={t.tokenType === 'native' ? 'success' : 'default'} size="sm">
                            {t.tokenType}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-text-muted">{t.priceSymbol}</td>
                        <td className="px-4 py-3 text-text-muted">{Number(t.minAmount)}</td>
                        <td className="px-4 py-3 text-text-muted">${Number(t.maxUsdValue)}</td>
                        <td className="px-4 py-3 text-text-muted text-xs">{presetDisplay(t.presetAmounts)}</td>
                        <td className="px-4 py-3">
                          <Badge variant={t.isActive ? 'success' : 'default'} size="sm">
                            {t.isActive ? 'Active' : 'Inactive'}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button size="sm" variant="ghost" onClick={() => openEditToken(t)}>Edit</Button>
                            {isSuperAdmin && (
                              <Button size="sm" variant="ghost" onClick={() => setConfirmDeleteToken(t)}>Delete</Button>
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
        </div>
      )}

      {/* ── Modals ─────────────────────────────────────────────────────────── */}
      {showChainModal && (
        <ChainModal
          editing={editingChain}
          form={chainForm}
          setForm={setChainForm}
          onSave={saveChain}
          onClose={() => setShowChainModal(false)}
          saving={chainSaving}
          error={chainFormError}
        />
      )}

      {showTokenModal && (
        <TokenModal
          editing={editingToken}
          form={tokenForm}
          setForm={setTokenForm}
          chains={chains}
          onSave={saveToken}
          onClose={() => setShowTokenModal(false)}
          saving={tokenSaving}
          error={tokenFormError}
        />
      )}

      <ConfirmModal
        isOpen={!!confirmDeleteChain}
        onClose={() => setConfirmDeleteChain(null)}
        onConfirm={() => { if (confirmDeleteChain) void deleteChain(confirmDeleteChain) }}
        title={`Delete Gas Chain: ${confirmDeleteChain?.name ?? ''}`}
        description="This will delete the gas chain and all its tokens. Orders referencing these tokens cannot be deleted. This action cannot be undone."
        confirmLabel="Delete"
        confirmVariant="danger"
      />

      <ConfirmModal
        isOpen={!!confirmDeleteToken}
        onClose={() => setConfirmDeleteToken(null)}
        onConfirm={() => { if (confirmDeleteToken) void deleteToken(confirmDeleteToken) }}
        title={`Delete Token: ${confirmDeleteToken?.name ?? ''}`}
        description="This will delete the token. Existing orders referencing it will remain intact. This action cannot be undone."
        confirmLabel="Delete"
        confirmVariant="danger"
      />
    </div>
  )
}
