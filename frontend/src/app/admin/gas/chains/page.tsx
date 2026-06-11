'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import { adminApi, type AdminGasChain, type AdminGasToken, type TokenLookupResult, type GasChainLookupResult, type TokenAddressLookupResult } from '@/lib/api'
import { CHAIN_META, CHAIN_CATEGORIES, ADDRESS_TYPES } from '@/lib/chainTokenStandards'
import { useAdminLogoUpload } from '@/hooks/useAdminLogoUpload'
import { invalidateLogoCache } from '@/hooks/useLogoRegistry'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Globe, Coins } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { Modal } from '@/components/ui/Modal'
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
  defaultMinAmount: string
  defaultMaxUsdValue: string
  displayOrder: string
  isActive: boolean
  readinessState: string
  // Operational / chain-registry fields
  chainType: string
  rpcUrl: string
  rpcUrlFallback: string
  feeMethod: string
  fixedFeeUsd: string
  coingeckoId: string
  isPaymentEnabled: boolean
  depositAddressOverride: string
  usdtContractAddress: string
  usdtDecimals: string
}

const BLANK_CHAIN: ChainFormState = {
  name: '', slug: '', symbol: '', category: '', networkLabel: '',
  addressType: 'EVM', logoUrl: '', explorerBase: '', backendChainId: '',
  platformFeeUsdt: '0.25', alertThresholdUsd: '', pauseThresholdUsd: '',
  defaultMinAmount: '', defaultMaxUsdValue: '',
  displayOrder: '0', isActive: false, readinessState: 'inactive',
  chainType: 'EVM', rpcUrl: '', rpcUrlFallback: '', feeMethod: 'EVM_RPC',
  fixedFeeUsd: '', coingeckoId: '', isPaymentEnabled: false,
  depositAddressOverride: '', usdtContractAddress: '', usdtDecimals: '6',
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
  platformFeeUsdt: string   // blank = inherit from chain
  minAmount: string         // blank = inherit from chain
  maxUsdValue: string       // blank = inherit from chain
  presetAmounts: string
  displayOrder: string
  isActive: boolean
}

const BLANK_TOKEN: TokenFormState = {
  chainConfigId: '', name: '', symbol: '', tokenType: 'native',
  contractAddress: '', logoUrl: '', priceSymbol: '',
  platformFeeUsdt: '', minAmount: '', maxUsdValue: '',
  presetAmounts: '', displayOrder: '0', isActive: true,
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

function parsePresets(raw: string): number[] {
  return raw.split(',').map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n) && n > 0)
}

// Resolve effective value (token override → chain default → fallback)
function resolveEffective(tokenVal: string, chainDefault: number | null, fallback: number): number {
  const tv = parseFloat(tokenVal)
  if (!isNaN(tv) && tv > 0) return tv
  return chainDefault ?? fallback
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

      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden" onChange={handleFile} />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        className="w-full py-2 border-2 border-dashed border-border rounded-lg text-sm text-text-muted hover:border-primary hover:text-primary transition-colors disabled:opacity-50"
      >
        {uploading ? 'Uploading...' : logoUrl ? 'Replace with upload (PNG/JPG/SVG/WebP · max 2MB)' : 'Upload logo (PNG/JPG/SVG/WebP · max 2MB)'}
      </button>

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

// ─── Inherit hint component ───────────────────────────────────────────────────

function InheritHint({ label, value }: { label: string; value: string | number | null }) {
  if (value == null) return null
  return (
    <p className="text-xs text-text-muted mt-0.5">
      Chain default: <span className="font-medium text-text-primary">{value}</span>. Leave blank to inherit.
    </p>
  )
}

// ─── Chain Modal ─────────────────────────────────────────────────────────────

function ChainModal({
  editing,
  form,
  setForm,
  chains,
  onSave,
  onClose,
  saving,
  error,
}: {
  editing: AdminGasChain | null
  form: ChainFormState
  setForm: (f: ChainFormState) => void
  chains: AdminGasChain[]
  onSave: () => void
  onClose: () => void
  saving: boolean
  error: string
}) {
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchResult, setSearchResult] = useState<GasChainLookupResult | null>(null)
  const [searchErr, setSearchErr] = useState<string | null>(null)

  async function handleAutoFill() {
    if (!searchQuery.trim()) return
    setSearching(true)
    setSearchResult(null)
    setSearchErr(null)
    try {
      const result = await adminApi.lookupGasChain(searchQuery.trim())
      setSearchResult(result)
      setForm({
        ...form,
        name:         result.suggestedName        || form.name,
        slug:         result.suggestedSlug        || form.slug,
        symbol:       result.suggestedSymbol      || form.symbol,
        category:     result.suggestedCategory    || form.category,
        addressType:  result.suggestedAddressType || form.addressType,
        networkLabel: result.suggestedNetworkLabel|| form.networkLabel,
        explorerBase: result.suggestedExplorerBase|| form.explorerBase,
        logoUrl:      result.suggestedLogoUrl     || form.logoUrl,
      })
    } catch (e) {
      setSearchErr(e instanceof Error ? e.message : 'Lookup failed')
    } finally {
      setSearching(false)
    }
  }

  function field(key: keyof ChainFormState) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm({ ...form, [key]: e.target.value })
  }

  function setLogoUrl(url: string) { setForm({ ...form, logoUrl: url }) }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={editing ? `Edit: ${editing.name}` : 'Add New Chain'}
      size="lg"
      footer={
        <div className="flex gap-3">
          <Button variant="secondary" className="flex-1" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button className="flex-1" onClick={onSave} disabled={saving || !form.name || !form.slug || !form.symbol}>
            {saving ? 'Saving...' : editing ? 'Save Changes' : 'Create Chain'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">

          {/* ── Auto-fill search (new chain only) ── */}
          {!editing && (
            <div className="space-y-2">
              <label className="text-xs font-medium text-text-muted block">Auto-fill from name or symbol</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="e.g. tron, solana, bnb…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void handleAutoFill()}
                  className="flex-1 border border-border rounded-lg px-3 py-2 text-sm"
                />
                <button
                  type="button"
                  onClick={() => void handleAutoFill()}
                  disabled={searching || !searchQuery.trim()}
                  className="shrink-0 px-3 py-2 text-xs font-medium bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
                >
                  {searching ? 'Searching…' : 'Auto-fill'}
                </button>
              </div>
              {searchErr && <p className="text-xs text-danger">{searchErr}</p>}
              {searchResult && (
                <div className={`text-xs px-3 py-2 rounded-lg border ${
                  searchResult.confidence === 'high'    ? 'bg-success/10 border-success/30 text-success' :
                  searchResult.confidence === 'partial' ? 'bg-warning/10 border-warning/30 text-warning' :
                                                          'bg-surface border-border text-text-muted'
                }`}>
                  <span className="font-semibold capitalize">{searchResult.confidence} confidence</span>
                  {' '}— fields pre-filled. Review before saving.
                  {searchResult.warnings.length > 0 && (
                    <ul className="mt-1 list-disc list-inside space-y-0.5">
                      {searchResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  )}
                </div>
              )}
              <div className="border-t border-border" />
            </div>
          )}

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
              <select
                className="w-full border border-border rounded-lg px-3 py-2 text-sm"
                value={form.category}
                onChange={(e) => {
                  const cat = e.target.value
                  const meta = CHAIN_CATEGORIES.find((c) => c.value === cat)
                  const chainMeta = CHAIN_META[cat]
                  setForm({
                    ...form,
                    category: cat,
                    addressType: meta?.addressType ?? form.addressType,
                    networkLabel: form.networkLabel || chainMeta?.networkLabel || '',
                    symbol: form.symbol || chainMeta?.nativeSymbol || '',
                    explorerBase: form.explorerBase || chainMeta?.explorerBase || '',
                  })
                }}
              >
                <option value="">Select...</option>
                {CHAIN_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
              {form.category && CHAIN_META[form.category] && (
                <p className="text-xs text-text-muted mt-0.5">
                  Address format: <span className="font-medium text-text-primary">{CHAIN_META[form.category]?.addressFormat.example}</span>
                </p>
              )}
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Network Label *</label>
              <Input placeholder="e.g. TRC20" value={form.networkLabel} onChange={field('networkLabel')} />
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Address Type *</label>
              <select className="w-full border border-border rounded-lg px-3 py-2 text-sm" value={form.addressType} onChange={field('addressType')}>
                {ADDRESS_TYPES.map((a) => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Backend Chain ID</label>
              {(() => {
                // Build set of backendChainIds already in use by OTHER chains
                const taken = new Set(
                  chains
                    .filter((c) => c.id !== editing?.id && c.backendChainId)
                    .map((c) => c.backendChainId as string)
                )
                const GAS_CHAINS = ['TRON','BSC','ETH','BASE','ARB','OP','MATIC','AVAX','SOL','TON','SUI']
                return (
                  <select className="w-full border border-border rounded-lg px-3 py-2 text-sm" value={form.backendChainId} onChange={field('backendChainId')}>
                    <option value="">Not deliverable yet</option>
                    {GAS_CHAINS.map((id) => {
                      const inUse = taken.has(id)
                      return (
                        <option key={id} value={id} disabled={inUse}>
                          {id}{inUse ? ' (already assigned)' : ''}
                        </option>
                      )
                    })}
                  </select>
                )
              })()}
              {form.backendChainId && (
                <p className="text-xs text-text-muted mt-0.5">
                  Delivery engine will process orders for this chain via the <span className="font-medium text-text-primary">{form.backendChainId}</span> hot wallet.
                </p>
              )}
            </div>

            {/* ── Chain-level defaults (inherited by tokens) ── */}
            <div className="col-span-2 pt-1">
              <div className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2 border-t border-border pt-3">
                Token Defaults (inherited by new tokens)
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Default Platform Fee (USDT) *</label>
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder="e.g. 0.25"
                value={form.platformFeeUsdt}
                onChange={field('platformFeeUsdt')}
              />
              <p className="text-xs text-text-muted mt-0.5">Fixed USDT fee per order — inherited by tokens unless overridden.</p>
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Default Min Amount</label>
              <Input
                type="number"
                min="0"
                step="any"
                placeholder="e.g. 0.1"
                value={form.defaultMinAmount}
                onChange={field('defaultMinAmount')}
              />
              <p className="text-xs text-text-muted mt-0.5">Minimum native amount. Inherited by tokens that have no override.</p>
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Default Max USD Value</label>
              <Input
                type="number"
                min="0"
                step="1"
                placeholder="e.g. 100"
                value={form.defaultMaxUsdValue}
                onChange={field('defaultMaxUsdValue')}
              />
              <p className="text-xs text-text-muted mt-0.5">Maximum order value in USD. Inherited by tokens that have no override.</p>
            </div>

            {/* ── Operational thresholds ── */}
            <div className="col-span-2 pt-1">
              <div className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2 border-t border-border pt-3">
                Operational Thresholds
              </div>
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
              <p className="text-xs text-text-muted mt-0.5">Send alert email below this USD wallet balance.</p>
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

            {/* ── Operational / Chain Registry ── */}
            <div className="col-span-2 pt-1">
              <div className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2 border-t border-border pt-3">
                Operational Config (Chain Registry)
              </div>
              <p className="text-xs text-text-muted mb-3">These fields power automatic price fetching, fee calculation, balance monitoring, and payment detection — no code changes needed when set correctly.</p>
            </div>

            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Chain Type *</label>
              <select className="w-full border border-border rounded-lg px-3 py-2 text-sm" value={form.chainType} onChange={field('chainType')}>
                <option value="EVM">EVM (Ethereum-compatible)</option>
                <option value="TRON">TRON</option>
                <option value="APTOS">Aptos</option>
                <option value="SOLANA">Solana</option>
                <option value="TON">TON</option>
                <option value="SUI">SUI</option>
                <option value="CUSTOM">Custom (requires code plugin)</option>
              </select>
              <p className="text-xs text-text-muted mt-0.5">Controls which scanning and delivery engine is used.</p>
            </div>

            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Fee Estimation Method</label>
              <select className="w-full border border-border rounded-lg px-3 py-2 text-sm" value={form.feeMethod} onChange={field('feeMethod')}>
                <option value="EVM_RPC">EVM RPC (eth_gasPrice)</option>
                <option value="TRON_API">Tron API</option>
                <option value="APTOS_API">Aptos API</option>
                <option value="SOLANA_API">Solana API</option>
                <option value="TON_API">TON API</option>
                <option value="FIXED">Fixed (use value below)</option>
                <option value="CUSTOM">Custom (code only)</option>
              </select>
            </div>

            {form.feeMethod === 'FIXED' && (
              <div className="col-span-2">
                <label className="text-xs font-medium text-text-muted block mb-1">Fixed Fee (USD)</label>
                <input
                  type="number"
                  min="0"
                  step="0.0001"
                  placeholder="e.g. 0.50"
                  value={form.fixedFeeUsd}
                  onChange={(e) => setForm({ ...form, fixedFeeUsd: e.target.value })}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm"
                />
              </div>
            )}

            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">CoinGecko ID</label>
              <input
                type="text"
                placeholder="e.g. aptos, binancecoin, tron"
                value={form.coingeckoId}
                onChange={(e) => setForm({ ...form, coingeckoId: e.target.value })}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm"
              />
              <p className="text-xs text-text-muted mt-0.5">Used for automatic price feed. Find on CoinGecko coin page URL.</p>
            </div>

            <div className="flex items-center gap-2 pt-5">
              <input
                id="chain-payment"
                type="checkbox"
                checked={form.isPaymentEnabled}
                onChange={(e) => setForm({ ...form, isPaymentEnabled: e.target.checked })}
                className="w-4 h-4 accent-primary"
              />
              <label htmlFor="chain-payment" className="text-sm font-medium text-text-primary">Accept USDT Payments</label>
            </div>

            <div className="col-span-2">
              <label className="text-xs font-medium text-text-muted block mb-1">Primary RPC URL</label>
              <input
                type="url"
                placeholder="https://bsc-dataseed.binance.org/"
                value={form.rpcUrl}
                onChange={(e) => setForm({ ...form, rpcUrl: e.target.value })}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm"
              />
              <p className="text-xs text-text-muted mt-0.5">Used for EVM fee estimation and balance monitoring.</p>
            </div>
            <div className="col-span-2">
              <label className="text-xs font-medium text-text-muted block mb-1">Fallback RPC URL</label>
              <input
                type="url"
                placeholder="https://bsc.publicnode.com"
                value={form.rpcUrlFallback}
                onChange={(e) => setForm({ ...form, rpcUrlFallback: e.target.value })}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm"
              />
            </div>

            <div className="col-span-2">
              <label className="text-xs font-medium text-text-muted block mb-1">USDT Contract Address</label>
              <input
                type="text"
                placeholder="0x55d398326f99059fF775485246999027B3197955"
                value={form.usdtContractAddress}
                onChange={(e) => setForm({ ...form, usdtContractAddress: e.target.value })}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm"
              />
              <p className="text-xs text-text-muted mt-0.5">USDT token contract on this chain (for payment detection).</p>
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">USDT Decimals</label>
              <input
                type="number"
                min="0"
                max="18"
                placeholder="6"
                value={form.usdtDecimals}
                onChange={(e) => setForm({ ...form, usdtDecimals: e.target.value })}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Deposit Address Override</label>
              <input
                type="text"
                placeholder="Leave blank to use mnemonic-derived address"
                value={form.depositAddressOverride}
                onChange={(e) => setForm({ ...form, depositAddressOverride: e.target.value })}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
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
  const [lookupResult, setLookupResult] = useState<TokenLookupResult | null>(null)
  const [looking, setLooking] = useState(false)
  const [lookupErr, setLookupErr] = useState<string | null>(null)

  // Address-first auto-fill state
  const [addrLookup, setAddrLookup] = useState<TokenAddressLookupResult | null>(null)
  const [addrLooking, setAddrLooking] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Keep latest form in a ref so the debounced callback reads fresh values
  const formRef = useRef(form)
  useEffect(() => { formRef.current = form })

  function field(key: keyof TokenFormState) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm({ ...form, [key]: e.target.value })
  }

  function setLogoUrl(url: string) { setForm({ ...form, logoUrl: url }) }

  const selectedChain = chains.find((c) => c.id === form.chainConfigId) ?? null
  const chainMeta = selectedChain ? CHAIN_META[selectedChain.category] : null
  const tokenStandards = chainMeta?.tokenStandards ?? [
    { value: 'native', label: 'Native Gas', isNative: true, hasContract: false },
    { value: 'erc20',  label: 'ERC-20 (Fungible Token)',    hasContract: true  },
  ]
  // "token" is the legacy DB value before named standards were introduced — treat it as hasContract=true
  const selectedStandard = tokenStandards.find((s) => s.value === form.tokenType)
    ?? (form.tokenType !== 'native'
      ? { value: form.tokenType, label: form.tokenType, hasContract: true }
      : tokenStandards[0])

  // Debounced address-first auto-fill: fires 800ms after user stops typing a valid address
  useEffect(() => {
    const addr = form.contractAddress.trim()
    const regex = chainMeta?.addressFormat.regex
    const canLookup = selectedStandard?.hasContract && addr && regex && new RegExp(regex).test(addr) && selectedChain?.slug

    if (!canLookup) {
      setAddrLookup(null)
      return
    }

    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setAddrLooking(true)
      setAddrLookup(null)
      try {
        const result = await adminApi.lookupGasTokenByAddress(addr, selectedChain!.slug)
        setAddrLookup(result)
        const cur = formRef.current
        setForm({
          ...cur,
          name:        (!cur.name        && result.name)    ? result.name    : cur.name,
          symbol:      (!cur.symbol      && result.symbol)  ? result.symbol  : cur.symbol,
          priceSymbol: (!cur.priceSymbol && result.symbol)  ? result.symbol  : cur.priceSymbol,
          logoUrl:     (!cur.logoUrl     && result.logoUrl) ? result.logoUrl : cur.logoUrl,
        })
      } catch {
        // non-fatal — user can still fill manually
      } finally {
        setAddrLooking(false)
      }
    }, 800)

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.contractAddress, selectedChain?.slug, selectedStandard?.hasContract])

  async function handleCoinGeckoLookup() {
    if (!form.symbol || !selectedChain?.backendChainId) return
    const chainSlugMap: Record<string, string> = {
      ETH: 'ethereum', BSC: 'bsc', MATIC: 'polygon',
      ARB: 'arbitrum', OP: 'optimism', BASE: 'base', AVAX: 'avalanche',
    }
    const chainSlug = chainSlugMap[selectedChain.backendChainId]
    if (!chainSlug) { setLookupErr(`No deposit chain mapping for ${selectedChain.backendChainId}`); return }
    setLooking(true)
    setLookupResult(null)
    setLookupErr(null)
    try {
      const result = await adminApi.lookupDepositToken(form.symbol, chainSlug)
      setLookupResult(result)
      if (result.address) setForm({ ...form, contractAddress: result.address })
    } catch (e) {
      setLookupErr(e instanceof Error ? e.message : 'Lookup failed')
    } finally {
      setLooking(false)
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={editing ? `Edit: ${editing.name}` : 'Add New Token'}
      size="lg"
      footer={
        <div className="flex gap-3">
          <Button variant="secondary" className="flex-1" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button className="flex-1" onClick={onSave} disabled={saving || !form.name || !form.chainConfigId || !form.priceSymbol}>
            {saving ? 'Saving...' : editing ? 'Save Changes' : 'Create Token'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
          {/* Inheritance info banner */}
          {selectedChain && (
            <div className="px-3 py-2 bg-primary/5 border border-primary/20 rounded-lg text-xs text-text-muted">
              Token config inherits from <span className="font-semibold text-text-primary">{selectedChain.name}</span> chain defaults.
              Fields left blank will use the chain&apos;s values.
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-xs font-medium text-text-muted block mb-1">Chain *</label>
              <select
                className="w-full border border-border rounded-lg px-3 py-2 text-sm"
                value={form.chainConfigId}
                disabled={!!editing}
                onChange={(e) => {
                  const newChainId = e.target.value
                  const newChain = chains.find((c) => c.id === newChainId)
                  const newMeta = newChain ? CHAIN_META[newChain.category] : null
                  const firstStandard = newMeta?.tokenStandards[0]?.value ?? 'native'
                  setForm({
                    ...form,
                    chainConfigId: newChainId,
                    tokenType: firstStandard,
                    contractAddress: '',
                  })
                }}
              >
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
              <select
                className="w-full border border-border rounded-lg px-3 py-2 text-sm"
                value={form.tokenType}
                onChange={(e) => {
                  const next = e.target.value
                  const std = tokenStandards.find((s) => s.value === next)
                  setForm({
                    ...form,
                    tokenType: next,
                    contractAddress: std?.hasContract ? form.contractAddress : '',
                  })
                }}
              >
                {tokenStandards.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
              {!selectedChain && (
                <p className="text-xs text-warning mt-0.5">Select a chain first to see correct token standards.</p>
              )}
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Price Symbol *</label>
              <Input placeholder="e.g. TRX, BNB, ETH" value={form.priceSymbol} onChange={field('priceSymbol')} />
            </div>
            {selectedStandard?.hasContract !== false && (
            <div className="col-span-2">
              <label className="text-xs font-medium text-text-muted block mb-1">
                Contract Address {selectedStandard?.hasContract ? '*' : ''}
              </label>
              <div className="flex gap-2">
                <Input
                  placeholder={chainMeta ? `e.g. ${chainMeta.addressFormat.example}` : '0x... or T...'}
                  value={form.contractAddress}
                  onChange={(e) => {
                    setForm({ ...form, contractAddress: e.target.value })
                  }}
                  className="flex-1"
                />
                {form.symbol && selectedChain?.backendChainId && (
                  <button
                    type="button"
                    onClick={handleCoinGeckoLookup}
                    disabled={looking}
                    className="shrink-0 px-3 py-2 text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-100 disabled:opacity-50 transition-colors"
                  >
                    {looking ? '…' : '🔍 CoinGecko'}
                  </button>
                )}
              </div>
              {chainMeta && form.contractAddress && !new RegExp(chainMeta.addressFormat.regex).test(form.contractAddress) && (
                <p className="text-xs text-danger mt-1">
                  Invalid format for {selectedChain?.category ?? 'this chain'}. Expected: {chainMeta.addressFormat.example}
                </p>
              )}
              {lookupErr && <p className="text-xs text-red-500 mt-1">{lookupErr}</p>}
              {/* Address-first auto-fill status */}
              {addrLooking && (
                <p className="text-xs text-text-muted mt-1 animate-pulse">Looking up contract…</p>
              )}
              {addrLookup && !addrLooking && (
                <div className="mt-2 flex gap-2 flex-wrap">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${addrLookup.onChainVerified ? 'bg-emerald-100 text-emerald-700' : 'bg-surface-alt text-text-muted'}`}>
                    {addrLookup.onChainVerified ? '✓' : '–'} On-chain
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${addrLookup.coingeckoVerified ? 'bg-emerald-100 text-emerald-700' : 'bg-surface-alt text-text-muted'}`}>
                    {addrLookup.coingeckoVerified ? '✓' : '–'} CoinGecko
                  </span>
                  {addrLookup.symbol && <span className="text-xs text-text-muted">symbol: {addrLookup.symbol}</span>}
                  {addrLookup.decimals != null && <span className="text-xs text-text-muted">decimals: {addrLookup.decimals}</span>}
                </div>
              )}
              {lookupResult && (
                <div className="mt-2 flex gap-2 flex-wrap">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${lookupResult.coingeckoVerified ? 'bg-emerald-100 text-emerald-700' : 'bg-surface-alt text-text-muted'}`}>
                    {lookupResult.coingeckoVerified ? '✓' : '–'} CoinGecko
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${lookupResult.onChainVerified ? 'bg-emerald-100 text-emerald-700' : 'bg-surface-alt text-text-muted'}`}>
                    {lookupResult.onChainVerified ? '✓' : '–'} On-chain
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${lookupResult.trustWalletVerified ? 'bg-emerald-100 text-emerald-700' : 'bg-surface-alt text-text-muted'}`}>
                    {lookupResult.trustWalletVerified ? '✓' : '–'} TrustWallet
                  </span>
                  {lookupResult.decimals != null && (
                    <span className="text-xs text-text-muted">decimals: {lookupResult.decimals}</span>
                  )}
                </div>
              )}
            </div>
            )}
            <LogoUploadField logoUrl={form.logoUrl} onLogoUrlChange={setLogoUrl} />

            {/* ── Per-token config overrides ── */}
            <div className="col-span-2 pt-1">
              <div className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-1 border-t border-border pt-3">
                Config Overrides
              </div>
              <p className="text-xs text-text-muted mb-2">
                Leave blank to inherit from the parent chain default.
              </p>
            </div>

            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Platform Fee (USDT)</label>
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder={selectedChain ? `Chain default: ${selectedChain.platformFeeUsdt}` : 'e.g. 0.25'}
                value={form.platformFeeUsdt}
                onChange={field('platformFeeUsdt')}
              />
              <InheritHint label="Platform fee" value={selectedChain?.platformFeeUsdt ?? null} />
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Min Amount</label>
              <Input
                type="number"
                step="any"
                min="0"
                placeholder={selectedChain?.defaultMinAmount != null ? `Chain default: ${selectedChain.defaultMinAmount}` : 'e.g. 0.1'}
                value={form.minAmount}
                onChange={field('minAmount')}
              />
              <InheritHint label="Min amount" value={selectedChain?.defaultMinAmount ?? null} />
            </div>
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Max USD Value</label>
              <Input
                type="number"
                min="0"
                step="1"
                placeholder={selectedChain?.defaultMaxUsdValue != null ? `Chain default: ${selectedChain.defaultMaxUsdValue}` : 'e.g. 100'}
                value={form.maxUsdValue}
                onChange={field('maxUsdValue')}
              />
              <InheritHint label="Max USD value" value={selectedChain?.defaultMaxUsdValue ?? null} />
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
      </div>
    </Modal>
  )
}

// ─── Withdrawal Fees Panel ────────────────────────────────────────────────────

const WITHDRAWAL_FEE_NETWORKS = [
  { label: 'BNB (BEP20)', network: 'BEP20' },
  { label: 'Aptos', network: 'APTOS' },
]

function WithdrawalFeesPanel({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const [fees, setFees] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    async function load() {
      try {
        const configs = await adminApi.getConfig()
        const map: Record<string, string> = {}
        configs.forEach((c) => {
          if (c.key.startsWith('withdrawal_gas_fee_') || c.key.startsWith('withdrawal_platform_fee_')) {
            map[c.key] = c.value
          }
        })
        setFees(map)
      } catch { /* non-critical */ }
    }
    load()
  }, [])

  function val(key: string) {
    return key in editing ? editing[key] : (fees[key] ?? '')
  }

  async function save(key: string) {
    const value = val(key)
    setSaving(key)
    setMsg(null)
    try {
      await adminApi.updateConfig({ key, value })
      setFees((f) => ({ ...f, [key]: value }))
      setEditing((e) => { const n = { ...e }; delete n[key]; return n })
      setMsg({ type: 'success', text: 'Saved.' })
      setTimeout(() => setMsg(null), 2500)
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : 'Save failed' })
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="bg-surface shadow-card border border-border rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-border">
        <h2 className="text-sm font-semibold text-text-primary">Wallet Withdrawal Fees</h2>
        <p className="text-xs text-text-muted mt-0.5">
          Fees charged when users withdraw from their platform wallet. Shown as a breakdown (Gas Fee + Platform Fee) in the withdrawal modal.
        </p>
      </div>

      {msg && (
        <div className={`mx-5 mt-3 px-3 py-2 rounded-lg text-xs ${msg.type === 'success' ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}>
          {msg.text}
        </div>
      )}

      <div className="divide-y divide-border">
        {WITHDRAWAL_FEE_NETWORKS.map(({ label, network }) => {
          const gasKey = `withdrawal_gas_fee_${network}`
          const platformKey = `withdrawal_platform_fee_${network}`
          return (
            <div key={network} className="px-5 py-4">
              <p className="text-xs font-semibold text-text-primary mb-3">{label}</p>
              <div className="grid grid-cols-2 gap-4">
                {/* Gas Fee */}
                <div>
                  <label className="block text-xs font-medium text-text-muted mb-1">Gas Fee (USDT)</label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      min="0"
                      step="0.0001"
                      disabled={!isSuperAdmin}
                      value={val(gasKey)}
                      onChange={(e) => setEditing((ed) => ({ ...ed, [gasKey]: e.target.value }))}
                      placeholder="0"
                      className="flex-1 px-3 py-1.5 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary disabled:bg-surface disabled:text-text-muted"
                    />
                    {isSuperAdmin && gasKey in editing && (
                      <button
                        onClick={() => save(gasKey)}
                        disabled={saving === gasKey}
                        className="px-3 py-1.5 text-xs font-medium bg-primary text-white rounded-lg hover:opacity-90 disabled:opacity-50"
                      >
                        {saving === gasKey ? '…' : 'Save'}
                      </button>
                    )}
                  </div>
                </div>
                {/* Platform Fee */}
                <div>
                  <label className="block text-xs font-medium text-text-muted mb-1">Platform Fee (USDT)</label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      min="0"
                      step="0.0001"
                      disabled={!isSuperAdmin}
                      value={val(platformKey)}
                      onChange={(e) => setEditing((ed) => ({ ...ed, [platformKey]: e.target.value }))}
                      placeholder="0"
                      className="flex-1 px-3 py-1.5 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary disabled:bg-surface disabled:text-text-muted"
                    />
                    {isSuperAdmin && platformKey in editing && (
                      <button
                        onClick={() => save(platformKey)}
                        disabled={saving === platformKey}
                        className="px-3 py-1.5 text-xs font-medium bg-primary text-white rounded-lg hover:opacity-90 disabled:opacity-50"
                      >
                        {saving === platformKey ? '…' : 'Save'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
              {(fees[gasKey] || fees[platformKey]) && (
                <p className="text-xs text-text-muted mt-2">
                  Total fee charged: {((parseFloat(fees[gasKey] ?? '0') || 0) + (parseFloat(fees[platformKey] ?? '0') || 0)).toFixed(4)} USDT
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Non-EVM Hot Wallet Setup Panel ──────────────────────────────────────────

const NON_EVM_BACKEND_IDS = new Set(['SOL', 'TON', 'SUI'])

interface HotWalletRow {
  id: string
  chain: string
  address: string
  friendlyAddress?: string | null
  isActive: boolean
}

/** Display form of a hot wallet address — user-friendly UQ… for TON, raw otherwise. */
function displayWalletAddress(w: HotWalletRow): string {
  return w.chain === 'TON' && w.friendlyAddress ? w.friendlyAddress : w.address
}

function NonEvmSetupPanel({
  chains,
  isSuperAdmin,
  onFlash,
}: {
  chains: AdminGasChain[]
  isSuperAdmin: boolean
  onFlash: (msg: string) => void
}) {
  const nonEvmChains = chains.filter(
    (c) => c.backendChainId && NON_EVM_BACKEND_IDS.has(c.backendChainId),
  )

  const [wallets, setWallets] = useState<Record<string, HotWalletRow | null | undefined>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [msgs, setMsgs] = useState<Record<string, { text: string; ok: boolean }>>({})

  const chainKey = nonEvmChains.map((c) => c.backendChainId).join(',')

  useEffect(() => {
    if (!nonEvmChains.length) return
    setWallets({})
    void Promise.all(
      nonEvmChains.map(async (c) => {
        try {
          const { wallets: ws } = await adminApi.listHotWallets(c.backendChainId!)
          setWallets((prev) => ({ ...prev, [c.backendChainId!]: ws[0] ?? null }))
        } catch {
          setWallets((prev) => ({ ...prev, [c.backendChainId!]: null }))
        }
      }),
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainKey])

  if (nonEvmChains.length === 0) return null

  async function handleSeed(backendChainId: string) {
    setBusy((b) => ({ ...b, [backendChainId]: true }))
    setMsgs((m) => ({ ...m, [backendChainId]: { text: '', ok: true } }))
    try {
      const result = await adminApi.addHotWallet(backendChainId)
      const seededRow: HotWalletRow = { id: result.id, chain: backendChainId, address: result.address, friendlyAddress: result.friendlyAddress, isActive: false }
      setWallets((w) => ({
        ...w,
        [backendChainId]: seededRow,
      }))
      setMsgs((m) => ({
        ...m,
        [backendChainId]: { text: `Wallet seeded: ${displayWalletAddress(seededRow)} — fund it, then click Activate.`, ok: true },
      }))
      onFlash(`${backendChainId} hot wallet created. Fund the address then activate it.`)
    } catch (e) {
      setMsgs((m) => ({
        ...m,
        [backendChainId]: { text: e instanceof Error ? e.message : 'Seed failed', ok: false },
      }))
    } finally {
      setBusy((b) => ({ ...b, [backendChainId]: false }))
    }
  }

  async function handleToggle(backendChainId: string, walletId: string) {
    setBusy((b) => ({ ...b, [backendChainId]: true }))
    setMsgs((m) => ({ ...m, [backendChainId]: { text: '', ok: true } }))
    try {
      const result = await adminApi.toggleHotWallet(walletId)
      setWallets((w) => ({
        ...w,
        [backendChainId]: { ...w[backendChainId]!, isActive: result.isActive },
      }))
      onFlash(`${backendChainId} hot wallet ${result.isActive ? 'activated' : 'deactivated'}.`)
    } catch (e) {
      setMsgs((m) => ({
        ...m,
        [backendChainId]: { text: e instanceof Error ? e.message : 'Action failed', ok: false },
      }))
    } finally {
      setBusy((b) => ({ ...b, [backendChainId]: false }))
    }
  }

  return (
    <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
      <div className="px-5 py-4 border-b border-border">
        <h3 className="text-sm font-semibold text-text-primary">Non-EVM Hot Wallet Setup</h3>
        <p className="text-xs text-text-muted mt-0.5">
          SOL, TON, and SUI require a hot wallet DB row derived from your mnemonic before they can be activated.
          Seed → Fund → Activate, then set the chain to Active.
        </p>
      </div>
      <div className="divide-y divide-border">
        {nonEvmChains.map((chain) => {
          const bid = chain.backendChainId!
          const wallet = wallets[bid]
          const isBusy = busy[bid] ?? false
          const msg = msgs[bid]
          const loading = !(bid in wallets)

          return (
            <div key={bid} className="px-5 py-4 flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  {chain.logoUrl && (
                    <img src={chain.logoUrl} alt={chain.name} className="w-5 h-5 rounded-full object-contain" />
                  )}
                  <span className="font-medium text-text-primary text-sm">{chain.name}</span>
                  <Badge variant="default" size="sm">{bid}</Badge>
                  {loading ? (
                    <Badge variant="default" size="sm">Checking…</Badge>
                  ) : wallet?.isActive ? (
                    <Badge variant="success" size="sm">Hot Wallet Active ✓</Badge>
                  ) : wallet ? (
                    <Badge variant="warning" size="sm">Seeded — Not Active</Badge>
                  ) : (
                    <Badge variant="danger" size="sm">No Hot Wallet</Badge>
                  )}
                  {chain.isActive && <Badge variant="success" size="sm">Chain Active</Badge>}
                </div>

                {wallet?.address && (
                  <p className="text-xs font-mono text-text-muted break-all mt-0.5">{displayWalletAddress(wallet)}</p>
                )}
                {!wallet && !loading && (
                  <p className="text-xs text-text-muted mt-0.5">
                    No hot wallet yet. Seed to derive address from your mnemonic, fund it with {bid}, then activate.
                  </p>
                )}
                {wallet && !wallet.isActive && (
                  <p className="text-xs text-text-muted mt-0.5">
                    Fund the address above with {bid}, then click Activate Wallet. Once active, you can enable the chain.
                  </p>
                )}
                {msg?.text && (
                  <p className={`text-xs mt-1 ${msg.ok ? 'text-success' : 'text-danger'}`}>{msg.text}</p>
                )}
              </div>

              {isSuperAdmin && !loading && (
                <div className="flex-shrink-0 flex gap-2">
                  {!wallet && (
                    <Button size="sm" variant="secondary" disabled={isBusy} onClick={() => void handleSeed(bid)}>
                      {isBusy ? 'Seeding…' : 'Seed Wallet'}
                    </Button>
                  )}
                  {wallet && (
                    <Button
                      size="sm"
                      variant={wallet.isActive ? 'ghost' : 'secondary'}
                      disabled={isBusy}
                      onClick={() => void handleToggle(bid, wallet.id)}
                    >
                      {isBusy ? '…' : wallet.isActive ? 'Deactivate' : 'Activate Wallet'}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function GasChainsAdminPage() {
  const user = useAuthStore((s) => s.user)
  const isSuperAdmin = user?.role === 'super_admin'

  const [tab, setTab] = useState<Tab>('chains')

  const [chains, setChains] = useState<AdminGasChain[]>([])
  const [chainsLoading, setChainsLoading] = useState(true)
  const [chainsError, setChainsError] = useState<string | null>(null)

  const [tokens, setTokens] = useState<AdminGasToken[]>([])
  const [tokensLoading, setTokensLoading] = useState(false)
  const [tokensError, setTokensError] = useState<string | null>(null)

  const [showChainModal, setShowChainModal] = useState(false)
  const [editingChain, setEditingChain] = useState<AdminGasChain | null>(null)
  const [chainForm, setChainForm] = useState<ChainFormState>(BLANK_CHAIN)
  const [chainSaving, setChainSaving] = useState(false)
  const [chainFormError, setChainFormError] = useState('')

  const [showTokenModal, setShowTokenModal] = useState(false)
  const [editingToken, setEditingToken] = useState<AdminGasToken | null>(null)
  const [tokenForm, setTokenForm] = useState<TokenFormState>(BLANK_TOKEN)
  const [tokenSaving, setTokenSaving] = useState(false)
  const [tokenFormError, setTokenFormError] = useState('')

  const [confirmDeleteChain, setConfirmDeleteChain] = useState<AdminGasChain | null>(null)
  const [confirmDeleteToken, setConfirmDeleteToken] = useState<AdminGasToken | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [togglingVisibility, setTogglingVisibility] = useState<Record<string, boolean>>({})

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
      defaultMinAmount: c.defaultMinAmount != null ? String(c.defaultMinAmount) : '',
      defaultMaxUsdValue: c.defaultMaxUsdValue != null ? String(c.defaultMaxUsdValue) : '',
      displayOrder: String(c.displayOrder),
      isActive: c.isActive,
      readinessState: c.readinessState ?? 'inactive',
      chainType: c.chainType ?? 'EVM',
      rpcUrl: c.rpcUrl ?? '',
      rpcUrlFallback: c.rpcUrlFallback ?? '',
      feeMethod: c.feeMethod ?? 'EVM_RPC',
      fixedFeeUsd: c.fixedFeeUsd != null ? String(c.fixedFeeUsd) : '',
      coingeckoId: c.coingeckoId ?? '',
      isPaymentEnabled: c.isPaymentEnabled ?? false,
      depositAddressOverride: c.depositAddressOverride ?? '',
      usdtContractAddress: c.usdtContractAddress ?? '',
      usdtDecimals: String(c.usdtDecimals ?? 6),
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
        defaultMinAmount: chainForm.defaultMinAmount ? parseFloat(chainForm.defaultMinAmount) : null,
        defaultMaxUsdValue: chainForm.defaultMaxUsdValue ? parseFloat(chainForm.defaultMaxUsdValue) : null,
        displayOrder: parseInt(chainForm.displayOrder) || 0,
        isActive: chainForm.isActive,
        readinessState: chainForm.readinessState,
        // Operational / chain-registry fields
        chainType: chainForm.chainType || 'EVM',
        rpcUrl: chainForm.rpcUrl || null,
        rpcUrlFallback: chainForm.rpcUrlFallback || null,
        feeMethod: chainForm.feeMethod || 'EVM_RPC',
        fixedFeeUsd: chainForm.fixedFeeUsd ? parseFloat(chainForm.fixedFeeUsd) : null,
        coingeckoId: chainForm.coingeckoId || null,
        isPaymentEnabled: chainForm.isPaymentEnabled,
        depositAddressOverride: chainForm.depositAddressOverride || null,
        usdtContractAddress: chainForm.usdtContractAddress || null,
        usdtDecimals: parseInt(chainForm.usdtDecimals) || 6,
      }
      if (editingChain) {
        await adminApi.updateGasChain(editingChain.id, payload)
        flash('Chain updated.')
      } else {
        await adminApi.createGasChain(payload)
        flash('Chain created.')
      }
      invalidateLogoCache()
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

  async function toggleChainVisibility(c: AdminGasChain) {
    setTogglingVisibility((prev) => ({ ...prev, [c.id]: true }))
    setErrorMsg(null)
    try {
      await adminApi.toggleGasChainVisibility(c.id, !c.isVisibleToUsers)
      flash(`Chain "${c.name}" ${c.isVisibleToUsers ? 'hidden from users' : 'shown to users'}.`)
      fetchChains()
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : 'Failed to update visibility')
    } finally {
      setTogglingVisibility((prev) => ({ ...prev, [c.id]: false }))
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
      platformFeeUsdt: t.platformFeeUsdt != null ? String(t.platformFeeUsdt) : '',
      minAmount: t.minAmount != null ? String(t.minAmount) : '',
      maxUsdValue: t.maxUsdValue != null ? String(t.maxUsdValue) : '',
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

      // blank string → null (inherit from chain)
      const platformFeeUsdtVal = tokenForm.platformFeeUsdt.trim()
      const minAmountVal = tokenForm.minAmount.trim()
      const maxUsdValueVal = tokenForm.maxUsdValue.trim()

      const payload = {
        chainConfigId: tokenForm.chainConfigId,
        name: tokenForm.name,
        symbol: tokenForm.symbol,
        tokenType: tokenForm.tokenType,
        contractAddress: tokenForm.contractAddress || null,
        logoUrl: tokenForm.logoUrl || null,
        priceSymbol: tokenForm.priceSymbol,
        platformFeeUsdt: platformFeeUsdtVal !== '' ? parseFloat(platformFeeUsdtVal) : null,
        minAmount: minAmountVal !== '' ? parseFloat(minAmountVal) : null,
        maxUsdValue: maxUsdValueVal !== '' ? parseFloat(maxUsdValueVal) : null,
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
      invalidateLogoCache()
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

  async function toggleTokenVisibility(t: AdminGasToken) {
    setTogglingVisibility((prev) => ({ ...prev, [t.id]: true }))
    setErrorMsg(null)
    try {
      await adminApi.toggleGasTokenVisibility(t.id, !t.isVisibleToUsers)
      flash(`Token "${t.name}" ${t.isVisibleToUsers ? 'hidden from users' : 'shown to users'}.`)
      fetchTokens()
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : 'Failed to update token visibility')
    } finally {
      setTogglingVisibility((prev) => ({ ...prev, [t.id]: false }))
    }
  }

  // ── Resolve effective token values for display ──────────────────────────────

  function getEffectiveFee(t: AdminGasToken): string {
    if (t.platformFeeUsdt != null) return `$${t.platformFeeUsdt} (override)`
    const chain = chains.find((c) => c.id === t.chainConfigId)
    if (chain) return `$${chain.platformFeeUsdt} (chain)`
    return '—'
  }

  function getEffectiveMin(t: AdminGasToken): string {
    if (t.minAmount != null) return `${Number(t.minAmount)} (override)`
    const chain = chains.find((c) => c.id === t.chainConfigId)
    if (chain?.defaultMinAmount != null) return `${chain.defaultMinAmount} (chain)`
    return '0.1 (fallback)'
  }

  function getEffectiveMax(t: AdminGasToken): string {
    if (t.maxUsdValue != null) return `$${Number(t.maxUsdValue)} (override)`
    const chain = chains.find((c) => c.id === t.chainConfigId)
    if (chain?.defaultMaxUsdValue != null) return `$${chain.defaultMaxUsdValue} (chain)`
    return '$10 (fallback)'
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

      {successMsg && (
        <div className="px-4 py-3 bg-success/10 border border-success/20 rounded-xl text-success text-sm">{successMsg}</div>
      )}
      {errorMsg && (
        <div className="px-4 py-3 bg-danger/10 border border-danger/20 rounded-xl text-danger text-sm">{errorMsg}</div>
      )}

      {/* Withdrawal Fees */}
      <WithdrawalFeesPanel isSuperAdmin={isSuperAdmin} />

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

          {!chainsLoading && !chainsError && (
            <NonEvmSetupPanel chains={chains} isSuperAdmin={isSuperAdmin} onFlash={flash} />
          )}

          {chainsLoading && <LoadingState message="Loading chains..." />}
          {chainsError && <ErrorState title={chainsError} onRetry={fetchChains} />}

          {!chainsLoading && !chainsError && chains.length === 0 && (
            <EmptyState icon={Globe} title="No chains configured" description="Add a chain to get started." />
          )}

          {!chainsLoading && chains.length > 0 && (
            <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-surface border-b border-border">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Chain</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Slug</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Backend</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Default Fee</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Default Limits</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Tokens</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Readiness</th>
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
                        <td className="px-4 py-3">
                          {c.backendChainId
                            ? <Badge variant="success" size="sm">{c.backendChainId}</Badge>
                            : <Badge variant="default" size="sm">Not Set</Badge>}
                        </td>
                        <td className="px-4 py-3">
                          <div className="text-sm font-semibold text-text-primary">${c.platformFeeUsdt ?? 0.25} USDT</div>
                          {c.alertThresholdUsd != null && (
                            <div className="text-xs text-text-muted">Alert ${c.alertThresholdUsd} / Pause ${c.pauseThresholdUsd ?? '—'}</div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-text-muted">
                          {c.defaultMinAmount != null && <div>Min: {c.defaultMinAmount}</div>}
                          {c.defaultMaxUsdValue != null && <div>Max: ${c.defaultMaxUsdValue}</div>}
                          {c.defaultMinAmount == null && c.defaultMaxUsdValue == null && <span className="text-text-muted/50">—</span>}
                        </td>
                        <td className="px-4 py-3 text-text-muted">{c._count?.tokens ?? c.tokens?.length ?? 0}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-col gap-1">
                            <Badge variant={c.isActive ? 'success' : 'default'} size="sm">
                              {c.isActive ? 'Active' : 'Inactive'}
                            </Badge>
                            <Badge variant={c.isVisibleToUsers !== false ? 'outline' : 'warning'} size="sm">
                              {c.isVisibleToUsers !== false ? 'Visible' : 'Hidden'}
                            </Badge>
                          </div>
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
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-2 flex-wrap">
                            <Button size="sm" variant="ghost" onClick={() => openEditChain(c)}>Edit</Button>
                            <Button size="sm" variant="ghost" onClick={() => { setTab('tokens'); openAddToken(c.id) }}>
                              + Token
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={togglingVisibility[c.id]}
                              onClick={() => void toggleChainVisibility(c)}
                            >
                              {c.isVisibleToUsers !== false ? 'Hide' : 'Show'}
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
            <EmptyState icon={Coins} title="No tokens configured" description="Add a token to a chain." />
          )}

          {!tokensLoading && tokens.length > 0 && (
            <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-surface border-b border-border">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Token</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Chain</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Type</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Platform Fee</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Min Amount</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Max USD</th>
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
                        <td className="px-4 py-3 text-xs text-text-muted">{getEffectiveFee(t)}</td>
                        <td className="px-4 py-3 text-xs text-text-muted">{getEffectiveMin(t)}</td>
                        <td className="px-4 py-3 text-xs text-text-muted">{getEffectiveMax(t)}</td>
                        <td className="px-4 py-3 text-text-muted text-xs">{presetDisplay(t.presetAmounts)}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-col gap-1">
                            <Badge variant={t.isActive ? 'success' : 'default'} size="sm">
                              {t.isActive ? 'Active' : 'Inactive'}
                            </Badge>
                            <Badge variant={t.isVisibleToUsers !== false ? 'outline' : 'warning'} size="sm">
                              {t.isVisibleToUsers !== false ? 'Visible' : 'Hidden'}
                            </Badge>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-2 flex-wrap">
                            <Button size="sm" variant="ghost" onClick={() => openEditToken(t)}>Edit</Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={togglingVisibility[t.id]}
                              onClick={() => void toggleTokenVisibility(t)}
                            >
                              {t.isVisibleToUsers !== false ? 'Hide' : 'Show'}
                            </Button>
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
          chains={chains}
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
        description="Deleting this chain may break historical records and cannot be undone. Use the Hide button instead if you only want to remove it from user-facing pages — it stays in admin and can be shown again later."
        confirmLabel="Delete Anyway"
        confirmVariant="danger"
      />

      <ConfirmModal
        isOpen={!!confirmDeleteToken}
        onClose={() => setConfirmDeleteToken(null)}
        onConfirm={() => { if (confirmDeleteToken) void deleteToken(confirmDeleteToken) }}
        title={`Delete Token: ${confirmDeleteToken?.name ?? ''}`}
        description="Deleting this token may affect historical records. Use the Hide button instead to remove it from users without losing the config. Existing orders will remain intact."
        confirmLabel="Delete Anyway"
        confirmVariant="danger"
      />
    </div>
  )
}
