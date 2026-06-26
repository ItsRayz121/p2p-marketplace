'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import { adminApi } from '@/lib/api'
import { useAdminLogoUpload } from '@/hooks/useAdminLogoUpload'
import { useAuthStore } from '@/store/auth.store'
import { useRouter } from 'next/navigation'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Button } from '@/components/ui/Button'
import { fmtDateTime } from '@/lib/fmt'
import { Badge } from '@/components/ui/Badge'

type ConfigRow = { id: string; key: string; value: string; updatedAt: string }

// ── Pakistani banks list ──────────────────────────────────────────────────────
const PK_BANKS = [
  'HBL — Habib Bank Limited',
  'MCB — Muslim Commercial Bank',
  'UBL — United Bank Limited',
  'Allied Bank',
  'Bank Alfalah',
  'Meezan Bank (Islamic)',
  'National Bank of Pakistan (NBP)',
  'Standard Chartered Pakistan',
  'Askari Bank',
  'Faysal Bank',
  'JS Bank',
  'Bank of Punjab',
  'Silk Bank',
  'Soneri Bank',
  'Summit Bank',
  'Other',
]

// ── Keys handled by structured panels (hidden from raw table) ─────────────────
const STRUCTURED_KEYS = new Set([
  'gas_pkr_jazzcash_name', 'gas_pkr_jazzcash_number', 'gas_pkr_jazzcash_logo',
  'gas_pkr_easypaisa_name', 'gas_pkr_easypaisa_number', 'gas_pkr_easypaisa_logo',
  'gas_pkr_nayapay_name', 'gas_pkr_nayapay_number', 'gas_pkr_nayapay_logo',
  'gas_pkr_sadapay_name', 'gas_pkr_sadapay_number', 'gas_pkr_sadapay_logo',
  'gas_pkr_bank_name', 'gas_pkr_bank_account_name', 'gas_pkr_bank_iban',
  'gas_pkr_bank_account_number', 'gas_pkr_bank_logo',
  'gas_usdt_bep20_address', 'gas_usdt_aptos_address',
  'gas_bep20_logo_url', 'gas_aptos_logo_url',
  'home_offers_mode', 'home_pinned_ad_ids',
  'noncustodial_p2p_enabled', 'noncustodial_max_order_usdt_l1', 'noncustodial_max_order_usdt_l2',
  'noncustodial_l1_max_ads', 'noncustodial_l1_max_ads_ctm',
  'maker_bond_enabled', 'maker_bond_ratio_pct', 'maker_bond_min_usdt',
  'gas_promo_enabled', 'gas_referral_enabled', 'gas_giveaway_enabled', 'gas_free_grant_enabled',
  'usdt_price_margin_pct', 'ctm_price_margin_pct',
  'usdt_bid_margin_pct', 'ctm_bid_margin_pct',
  'max_concurrent_trades', 'max_concurrent_trades_with_dispute', 'trade_limit_bypass_user_ids',
])

const SENSITIVE_PATTERNS = ['private_key', 'secret', 'password', 'token', 'api_key']
function isSensitive(key: string) { return SENSITIVE_PATTERNS.some((p) => key.toLowerCase().includes(p)) }
function maskValue(v: string) { return v.length <= 6 ? '••••••' : v.slice(0, 3) + '•'.repeat(Math.min(v.length - 6, 16)) + v.slice(-3) }

function isNonDirectImageUrl(url: string): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    const blocked = ['drive.google.com', 'share.google.com', 'docs.google.com']
    if (blocked.some((h) => u.hostname === h || u.hostname.endsWith('.' + h))) return true
    const exts = ['.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif']
    const trusted = ['res.cloudinary.com', 'githubusercontent.com', 'cryptologos.cc', 'icons8.com']
    return !exts.some((e) => u.pathname.toLowerCase().endsWith(e)) && !trusted.some((h) => u.hostname.includes(h))
  } catch { return false }
}

// ── Shared logo upload field (same as Gas Chains) ─────────────────────────────
function LogoUploadField({ logoUrl, onLogoUrlChange }: { logoUrl: string; onLogoUrlChange: (url: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const { upload, uploading, error: uploadError } = useAdminLogoUpload()
  const [imgError, setImgError] = useState(false)
  const urlWarn = isNonDirectImageUrl(logoUrl)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImgError(false)
    try { const url = await upload(file); onLogoUrlChange(url) } catch { /* error shown via uploadError */ }
    e.target.value = ''
  }

  return (
    <div className="space-y-2">
      <label className="text-xs font-medium text-text-muted block">Logo</label>

      {logoUrl && !imgError && (
        <div className="flex items-center gap-3 p-2 bg-surface rounded-lg border border-border">
          <img src={logoUrl} alt="Logo preview" className="w-10 h-10 rounded-full object-contain border border-border" onError={() => setImgError(true)} />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-text-muted truncate">{logoUrl}</p>
          </div>
          <button type="button" onClick={() => { onLogoUrlChange(''); setImgError(false) }} className="text-danger text-xs hover:underline flex-shrink-0">Remove</button>
        </div>
      )}
      {logoUrl && imgError && (
        <div className="flex items-center gap-2 px-3 py-2 bg-danger/10 border border-danger/20 rounded-lg text-danger text-xs">
          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          Image failed to load — URL may be broken or blocked by CORS.
        </div>
      )}
      {uploadError && <p className="text-xs text-danger">{uploadError}</p>}

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
          className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
        {urlWarn && <p className="text-xs text-warning mt-1">Warning: this URL does not look like a direct image link. Use a CDN URL or upload the file instead.</p>}
      </div>
    </div>
  )
}

// ── Accordion wrapper ─────────────────────────────────────────────────────────
function Accordion({ title, subtitle, open, onToggle, children, badge }: {
  title: string; subtitle?: string; open: boolean; onToggle: () => void
  children: React.ReactNode; badge?: React.ReactNode
}) {
  return (
    <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-center justify-between px-5 py-4 hover:bg-surface/40 transition-colors text-left">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-semibold text-text-primary">{title}</span>
            {badge}
          </div>
          {subtitle && <p className="text-xs text-text-muted mt-0.5">{subtitle}</p>}
        </div>
        <svg className={`w-5 h-5 text-text-muted transition-transform flex-shrink-0 ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className="border-t border-border">{children}</div>}
    </div>
  )
}

// ── Sub-section header ────────────────────────────────────────────────────────
function SubSection({ label }: { label: string }) {
  return <p className="text-xs font-semibold text-text-muted uppercase tracking-wider px-1 pt-2">{label}</p>
}

// ── Field row ─────────────────────────────────────────────────────────────────
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start gap-1.5 sm:gap-4">
      <div className="sm:w-44 flex-shrink-0 pt-1.5">
        <p className="text-sm font-medium text-text-primary">{label}</p>
        {hint && <p className="text-xs text-text-muted mt-0.5">{hint}</p>}
      </div>
      <div className="flex-1">{children}</div>
    </div>
  )
}

const inputCls = 'w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary placeholder:text-text-muted'
const selectCls = inputCls + ' cursor-pointer'

function MethodBadge({ configured }: { configured: boolean }) {
  return configured
    ? <Badge variant="success" size="sm">Configured</Badge>
    : <Badge variant="outline" size="sm">Not set</Badge>
}

// ── Provider card wrapper ─────────────────────────────────────────────────────
function ProviderCard({ icon, label, configured, children }: {
  icon: React.ReactNode; label: string; configured: boolean; children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-border p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <span className="font-semibold text-text-primary">{label}</span>
        </div>
        <MethodBadge configured={configured} />
      </div>
      {children}
    </div>
  )
}

export default function ConfigPage() {
  const { user } = useAuthStore()
  const router = useRouter()
  const [rows, setRows] = useState<ConfigRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [walletOpen, setWalletOpen] = useState(false) // Phase 9: collapsed by default like other sections
  const [emiOpen, setEmiOpen] = useState(false)
  const [bankOpen, setBankOpen] = useState(false)
  const [cryptoOpen, setCryptoOpen] = useState(false)
  const [offersOpen, setOffersOpen] = useState(false)
  const [advOpen, setAdvOpen] = useState(false)
  const [ncOpen, setNcOpen] = useState(false)
  const [mktOpen, setMktOpen] = useState(false)
  const [pricingOpen, setPricingOpen] = useState(false)

  // ── Pricing guardrails ───────────────────────────────────────────────────────
  const [usdtMargin, setUsdtMargin] = useState('5')
  const [ctmMargin, setCtmMargin] = useState('5')
  const [usdtBidMargin, setUsdtBidMargin] = useState('10')
  const [ctmBidMargin, setCtmBidMargin] = useState('10')
  const [marginSaving, setMarginSaving] = useState(false)

  // ── Trade limits (concurrency) ────────────────────────────────────────────────
  const [limitsOpen, setLimitsOpen] = useState(false)
  const [maxConcurrent, setMaxConcurrent] = useState('3')
  const [maxConcurrentDispute, setMaxConcurrentDispute] = useState('1')
  const [bypassUserIds, setBypassUserIds] = useState('')
  const [limitsSaving, setLimitsSaving] = useState(false)

  // ── Non-Custodial P2P ────────────────────────────────────────────────────────
  const [ncEnabled, setNcEnabled] = useState(false)
  const [ncMaxOrderL1, setNcMaxOrderL1] = useState('50')
  const [ncMaxOrderL2, setNcMaxOrderL2] = useState('500')
  const [ncL1AdsUsdt, setNcL1AdsUsdt] = useState('1')
  const [ncL1AdsCtm, setNcL1AdsCtm] = useState('2')
  const [ncSaving, setNcSaving] = useState(false)
  // Maker collateral bond (Phase 5)
  const [bondEnabled, setBondEnabled] = useState(false)
  const [bondRatioPct, setBondRatioPct] = useState('10')
  const [bondMinUsdt, setBondMinUsdt] = useState('0')

  // ── Marketing & Growth (gas promo / referral / giveaway / free-gas flags) ────
  const [promoFlag, setPromoFlag] = useState(false)
  const [referralFlag, setReferralFlag] = useState(false)
  const [affiliateFlag, setAffiliateFlag] = useState(false)
  const [giveawayFlag, setGiveawayFlag] = useState(false)
  const [freeGrantFlag, setFreeGrantFlag] = useState(false)
  const [mktSaving, setMktSaving] = useState(false)

  // ── Homepage Top Offers ─────────────────────────────────────────────────────
  const [offersMode, setOffersMode] = useState<'top' | 'latest' | 'pinned'>('top')
  const [pinnedAdIds, setPinnedAdIds] = useState('')
  const [offersSaving, setOffersSaving] = useState(false)

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)
  function showToast(msg: string, ok = true) { setToast({ msg, ok }); setTimeout(() => setToast(null), 4000) }

  // ── JazzCash ──────────────────────────────────────────────────────────────
  const [jcName, setJcName]     = useState('')
  const [jcNumber, setJcNumber] = useState('')
  const [jcLogo, setJcLogo]     = useState('')
  const [jcSaving, setJcSaving] = useState(false)

  // ── Easypaisa ─────────────────────────────────────────────────────────────
  const [epName, setEpName]     = useState('')
  const [epNumber, setEpNumber] = useState('')
  const [epLogo, setEpLogo]     = useState('')
  const [epSaving, setEpSaving] = useState(false)

  // ── Nayapay ───────────────────────────────────────────────────────────────
  const [npName, setNpName]     = useState('')
  const [npNumber, setNpNumber] = useState('')
  const [npLogo, setNpLogo]     = useState('')
  const [npSaving, setNpSaving] = useState(false)

  // ── Sadapay ───────────────────────────────────────────────────────────────
  const [spName, setSpName]     = useState('')
  const [spNumber, setSpNumber] = useState('')
  const [spLogo, setSpLogo]     = useState('')
  const [spSaving, setSpSaving] = useState(false)

  // ── Bank Transfer ─────────────────────────────────────────────────────────
  const [bkName, setBkName]       = useState('')
  const [bkAccName, setBkAccName] = useState('')
  const [bkIban, setBkIban]       = useState('')
  const [bkAccNo, setBkAccNo]     = useState('')
  const [bkLogo, setBkLogo]       = useState('')
  const [bkSaving, setBkSaving]   = useState(false)

  // ── Crypto ────────────────────────────────────────────────────────────────
  const [bep20Addr, setBep20Addr] = useState('')
  const [aptosAddr, setAptosAddr] = useState('')
  const [bep20Logo, setBep20Logo] = useState('')
  const [aptosLogo, setAptosLogo] = useState('')
  const [cryptoSaving, setCryptoSaving] = useState(false)

  // ── Raw table edit ────────────────────────────────────────────────────────
  const [editKey, setEditKey]       = useState<string | null>(null)
  const [editValue, setEditValue]   = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [showSensitive, setShowSensitive] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (user && user.role !== 'super_admin') router.replace('/admin')
  }, [user, router])

  const fetchConfig = useCallback(async () => {
    setLoading(true)
    try {
      const data = await adminApi.getConfig()
      const arr: ConfigRow[] = Array.isArray(data) ? data : []
      setRows(arr)
      const m: Record<string, string> = {}
      arr.forEach((r) => { m[r.key] = r.value })
      setJcName(m['gas_pkr_jazzcash_name']        ?? '')
      setJcNumber(m['gas_pkr_jazzcash_number']     ?? '')
      setJcLogo(m['gas_pkr_jazzcash_logo']         ?? '')
      setEpName(m['gas_pkr_easypaisa_name']        ?? '')
      setEpNumber(m['gas_pkr_easypaisa_number']    ?? '')
      setEpLogo(m['gas_pkr_easypaisa_logo']        ?? '')
      setNpName(m['gas_pkr_nayapay_name']          ?? '')
      setNpNumber(m['gas_pkr_nayapay_number']      ?? '')
      setNpLogo(m['gas_pkr_nayapay_logo']          ?? '')
      setSpName(m['gas_pkr_sadapay_name']          ?? '')
      setSpNumber(m['gas_pkr_sadapay_number']      ?? '')
      setSpLogo(m['gas_pkr_sadapay_logo']          ?? '')
      setBkName(m['gas_pkr_bank_name']             ?? '')
      setBkAccName(m['gas_pkr_bank_account_name']  ?? '')
      setBkIban(m['gas_pkr_bank_iban']             ?? '')
      setBkAccNo(m['gas_pkr_bank_account_number']  ?? '')
      setBkLogo(m['gas_pkr_bank_logo']             ?? '')
      setBep20Addr(m['gas_usdt_bep20_address']     ?? '')
      setAptosAddr(m['gas_usdt_aptos_address']     ?? '')
      setBep20Logo(m['gas_bep20_logo_url']         ?? '')
      setAptosLogo(m['gas_aptos_logo_url']         ?? '')
      {
        const mode = (m['home_offers_mode'] ?? 'top').trim().toLowerCase()
        setOffersMode((['top', 'latest', 'pinned'].includes(mode) ? mode : 'top') as 'top' | 'latest' | 'pinned')
      }
      setPinnedAdIds(m['home_pinned_ad_ids'] ?? '')
      setNcEnabled(m['noncustodial_p2p_enabled'] === 'true')
      setNcMaxOrderL1(m['noncustodial_max_order_usdt_l1'] ?? '50')
      setNcMaxOrderL2(m['noncustodial_max_order_usdt_l2'] ?? '500')
      setNcL1AdsUsdt(m['noncustodial_l1_max_ads'] ?? '1')
      setNcL1AdsCtm(m['noncustodial_l1_max_ads_ctm'] ?? '2')
      setBondEnabled(m['maker_bond_enabled'] === 'true')
      setBondRatioPct(m['maker_bond_ratio_pct'] ?? '10')
      setBondMinUsdt(m['maker_bond_min_usdt'] ?? '0')
      setPromoFlag(m['gas_promo_enabled'] === 'true')
      setReferralFlag(m['gas_referral_enabled'] === 'true')
      setAffiliateFlag(m['gas_affiliate_enabled'] === 'true')
      setGiveawayFlag(m['gas_giveaway_enabled'] === 'true')
      setFreeGrantFlag(m['gas_free_grant_enabled'] === 'true')
      setUsdtMargin(m['usdt_price_margin_pct'] ?? '5')
      setCtmMargin(m['ctm_price_margin_pct'] ?? '5')
      setUsdtBidMargin(m['usdt_bid_margin_pct'] ?? '10')
      setCtmBidMargin(m['ctm_bid_margin_pct'] ?? '10')
      setMaxConcurrent(m['max_concurrent_trades'] ?? '3')
      setMaxConcurrentDispute(m['max_concurrent_trades_with_dispute'] ?? '1')
      setBypassUserIds(m['trade_limit_bypass_user_ids'] ?? '')
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load config')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchConfig() }, [fetchConfig])

  function applyRows(updates: Array<{ key: string; value: string; updatedAt: string }>) {
    setRows((prev) => {
      const next = [...prev]
      for (const u of updates) {
        const idx = next.findIndex((r) => r.key === u.key)
        if (idx >= 0) next[idx] = { ...next[idx]!, value: u.value, updatedAt: u.updatedAt }
        else next.push({ id: u.key, key: u.key, value: u.value, updatedAt: u.updatedAt })
      }
      return next
    })
  }

  async function saveKeys(pairs: Array<{ key: string; value: string }>) {
    const results = await Promise.all(pairs.map((p) => adminApi.updateConfig(p)))
    applyRows(results.map((r, i) => ({ key: pairs[i]!.key, value: pairs[i]!.value, updatedAt: r.updatedAt })))
  }

  async function saveJazzCash() {
    setJcSaving(true)
    try {
      await saveKeys([
        { key: 'gas_pkr_jazzcash_name',   value: jcName.trim() },
        { key: 'gas_pkr_jazzcash_number', value: jcNumber.trim() },
        { key: 'gas_pkr_jazzcash_logo',   value: jcLogo.trim() },
      ])
      showToast('JazzCash details saved.')
    } catch { showToast('Failed to save JazzCash details.', false) }
    finally { setJcSaving(false) }
  }

  async function saveEasypaisa() {
    setEpSaving(true)
    try {
      await saveKeys([
        { key: 'gas_pkr_easypaisa_name',   value: epName.trim() },
        { key: 'gas_pkr_easypaisa_number', value: epNumber.trim() },
        { key: 'gas_pkr_easypaisa_logo',   value: epLogo.trim() },
      ])
      showToast('Easypaisa details saved.')
    } catch { showToast('Failed to save Easypaisa details.', false) }
    finally { setEpSaving(false) }
  }

  async function saveNayapay() {
    setNpSaving(true)
    try {
      await saveKeys([
        { key: 'gas_pkr_nayapay_name',   value: npName.trim() },
        { key: 'gas_pkr_nayapay_number', value: npNumber.trim() },
        { key: 'gas_pkr_nayapay_logo',   value: npLogo.trim() },
      ])
      showToast('Nayapay details saved.')
    } catch { showToast('Failed to save Nayapay details.', false) }
    finally { setNpSaving(false) }
  }

  async function saveSadapay() {
    setSpSaving(true)
    try {
      await saveKeys([
        { key: 'gas_pkr_sadapay_name',   value: spName.trim() },
        { key: 'gas_pkr_sadapay_number', value: spNumber.trim() },
        { key: 'gas_pkr_sadapay_logo',   value: spLogo.trim() },
      ])
      showToast('Sadapay details saved.')
    } catch { showToast('Failed to save Sadapay details.', false) }
    finally { setSpSaving(false) }
  }

  async function saveBank() {
    setBkSaving(true)
    try {
      await saveKeys([
        { key: 'gas_pkr_bank_name',           value: bkName.trim() },
        { key: 'gas_pkr_bank_account_name',   value: bkAccName.trim() },
        { key: 'gas_pkr_bank_iban',           value: bkIban.trim().toUpperCase() },
        { key: 'gas_pkr_bank_account_number', value: bkAccNo.trim() },
        { key: 'gas_pkr_bank_logo',           value: bkLogo.trim() },
      ])
      showToast('Bank transfer details saved.')
    } catch { showToast('Failed to save bank details.', false) }
    finally { setBkSaving(false) }
  }

  async function saveCrypto() {
    setCryptoSaving(true)
    try {
      const pairs: Array<{ key: string; value: string }> = []
      if (bep20Addr.trim()) pairs.push({ key: 'gas_usdt_bep20_address', value: bep20Addr.trim() })
      if (aptosAddr.trim()) pairs.push({ key: 'gas_usdt_aptos_address', value: aptosAddr.trim() })
      if (bep20Logo.trim()) pairs.push({ key: 'gas_bep20_logo_url',      value: bep20Logo.trim() })
      if (aptosLogo.trim()) pairs.push({ key: 'gas_aptos_logo_url',      value: aptosLogo.trim() })
      if (pairs.length === 0) { showToast('Enter at least one address.', false); return }
      await saveKeys(pairs)
      showToast('Crypto deposit addresses saved.')
    } catch { showToast('Failed to save crypto addresses.', false) }
    finally { setCryptoSaving(false) }
  }

  async function saveOffers() {
    setOffersSaving(true)
    try {
      await saveKeys([
        { key: 'home_offers_mode', value: offersMode },
        { key: 'home_pinned_ad_ids', value: pinnedAdIds.trim() },
      ])
      showToast('Homepage Top Offers settings saved. Changes appear within ~2 minutes.')
    } catch { showToast('Failed to save Top Offers settings.', false) }
    finally { setOffersSaving(false) }
  }

  async function saveNonCustodial() {
    setNcSaving(true)
    try {
      await saveKeys([
        { key: 'noncustodial_p2p_enabled', value: ncEnabled ? 'true' : 'false' },
        { key: 'noncustodial_max_order_usdt_l1', value: String(parseFloat(ncMaxOrderL1) || 50) },
        { key: 'noncustodial_max_order_usdt_l2', value: String(Math.max(parseFloat(ncMaxOrderL2) || 0, 0)) },
        { key: 'noncustodial_l1_max_ads', value: String(parseInt(ncL1AdsUsdt, 10) || 1) },
        { key: 'noncustodial_l1_max_ads_ctm', value: String(parseInt(ncL1AdsCtm, 10) || 2) },
        { key: 'maker_bond_enabled', value: bondEnabled ? 'true' : 'false' },
        { key: 'maker_bond_ratio_pct', value: String(Math.max(parseFloat(bondRatioPct) || 0, 0)) },
        { key: 'maker_bond_min_usdt', value: String(Math.max(parseFloat(bondMinUsdt) || 0, 0)) },
      ])
      showToast(ncEnabled ? 'Non-custodial mode is ON.' : 'Non-custodial mode is OFF.')
    } catch { showToast('Failed to save non-custodial settings.', false) }
    finally { setNcSaving(false) }
  }

  async function saveMarketing() {
    setMktSaving(true)
    try {
      await saveKeys([
        { key: 'gas_promo_enabled', value: promoFlag ? 'true' : 'false' },
        { key: 'gas_referral_enabled', value: referralFlag ? 'true' : 'false' },
        { key: 'gas_affiliate_enabled', value: affiliateFlag ? 'true' : 'false' },
        { key: 'gas_giveaway_enabled', value: giveawayFlag ? 'true' : 'false' },
        { key: 'gas_free_grant_enabled', value: freeGrantFlag ? 'true' : 'false' },
      ])
      showToast('Marketing & Growth settings saved. Takes effect within ~15s.')
    } catch { showToast('Failed to save marketing settings.', false) }
    finally { setMktSaving(false) }
  }

  async function savePricing() {
    setMarginSaving(true)
    try {
      await saveKeys([
        { key: 'usdt_price_margin_pct', value: String(Math.max(parseFloat(usdtMargin) || 0, 0)) },
        { key: 'ctm_price_margin_pct', value: String(Math.max(parseFloat(ctmMargin) || 0, 0)) },
        { key: 'usdt_bid_margin_pct', value: String(Math.max(parseFloat(usdtBidMargin) || 0, 0)) },
        { key: 'ctm_bid_margin_pct', value: String(Math.max(parseFloat(ctmBidMargin) || 0, 0)) },
      ])
      showToast('Pricing guardrails saved.')
    } catch { showToast('Failed to save pricing guardrails.', false) }
    finally { setMarginSaving(false) }
  }

  async function saveLimits() {
    setLimitsSaving(true)
    try {
      await saveKeys([
        { key: 'max_concurrent_trades', value: String(Math.max(parseInt(maxConcurrent, 10) || 0, 0)) },
        { key: 'max_concurrent_trades_with_dispute', value: String(Math.max(parseInt(maxConcurrentDispute, 10) || 0, 0)) },
        { key: 'trade_limit_bypass_user_ids', value: bypassUserIds.split(',').map((s) => s.trim()).filter(Boolean).join(',') },
      ])
      showToast('Trade limits saved.')
    } catch { showToast('Failed to save trade limits.', false) }
    finally { setLimitsSaving(false) }
  }

  async function saveEdit(key: string) {
    setEditSaving(true)
    try {
      const updated = await adminApi.updateConfig({ key, value: editValue })
      applyRows([{ key, value: editValue, updatedAt: updated.updatedAt }])
      showToast(`"${key}" updated.`)
      setEditKey(null)
    } catch { showToast('Failed to save.', false) }
    finally { setEditSaving(false) }
  }

  if (user?.role !== 'super_admin') return null
  if (loading) return <LoadingState message="Loading configuration..." />
  if (error && rows.length === 0) return <ErrorState title={error} onRetry={fetchConfig} />

  const cfgMap: Record<string, string> = {}
  rows.forEach((r) => { cfgMap[r.key] = r.value })

  const jcConfigured  = !!(cfgMap['gas_pkr_jazzcash_name'] && cfgMap['gas_pkr_jazzcash_number'])
  const epConfigured  = !!(cfgMap['gas_pkr_easypaisa_name'] && cfgMap['gas_pkr_easypaisa_number'])
  const npConfigured  = !!(cfgMap['gas_pkr_nayapay_name'] && cfgMap['gas_pkr_nayapay_number'])
  const spConfigured  = !!(cfgMap['gas_pkr_sadapay_name'] && cfgMap['gas_pkr_sadapay_number'])
  const bkConfigured  = !!(cfgMap['gas_pkr_bank_name'] && cfgMap['gas_pkr_bank_account_name'])
  const bep20Set      = !!cfgMap['gas_usdt_bep20_address']
  const aptosSet      = !!cfgMap['gas_usdt_aptos_address']

  const otherRows = rows.filter((r) => !STRUCTURED_KEYS.has(r.key))

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Platform Configuration</h1>
        <p className="text-text-muted text-sm mt-0.5">Super admin only</p>
      </div>

      {toast && (
        <div className={`px-4 py-3 rounded-xl text-sm ${toast.ok ? 'bg-success/10 border border-success/20 text-success' : 'bg-danger/10 border border-danger/20 text-danger'}`}>
          {toast.msg}
        </div>
      )}

      {/* ══ Non-Custodial P2P ═════════════════════════════════════════════════ */}
      <Accordion
        title="Non-Custodial P2P"
        subtitle="Master switch for non-custodial mode (identity, KYC tiers, verified-receipt, caps)"
        open={ncOpen}
        onToggle={() => setNcOpen((v) => !v)}
        badge={ncEnabled ? <Badge variant="success" size="sm">ON</Badge> : <Badge variant="outline" size="sm">OFF</Badge>}
      >
        <div className="p-5 space-y-5">
          <label className="flex items-start gap-3 rounded-xl border border-border p-3 cursor-pointer hover:bg-surface/40 transition-colors">
            <input type="checkbox" checked={ncEnabled} onChange={(e) => setNcEnabled(e.target.checked)} className="mt-0.5 accent-primary w-4 h-4" />
            <div>
              <p className="text-sm font-medium text-text-primary">Enable non-custodial mode</p>
              <p className="text-xs text-text-muted mt-0.5">
                Turns on the whole non-custodial system: CNIC-name identity + privacy, KYC tiers
                (L1 trades / L1 gets 1 ad / L2 unlimited ads), verified-receipt, release-window
                escalation, concurrency + anti-griefing, payment-name match, and the order cap.
                Reversible instantly — untick to return to current behavior.
              </p>
            </div>
          </label>

          <Field label="L1 max order (USDT)" hint="Per-order cap for Level-1 users — USDT-equivalent, applies to USDT + CTM">
            <input className={inputCls} type="number" min="1" value={ncMaxOrderL1} onChange={(e) => setNcMaxOrderL1(e.target.value)} placeholder="50" />
          </Field>

          <Field label="L2 max order (USDT)" hint="Per-order cap for Level-2 users (recommended 300–500). 0 = unlimited">
            <input className={inputCls} type="number" min="0" value={ncMaxOrderL2} onChange={(e) => setNcMaxOrderL2(e.target.value)} placeholder="500" />
          </Field>

          <Field label="Level-1 ads — USDT" hint="Active USDT ads a Level-1 user may keep">
            <input className={inputCls} type="number" min="0" value={ncL1AdsUsdt} onChange={(e) => setNcL1AdsUsdt(e.target.value)} placeholder="1" />
          </Field>

          <Field label="Level-1 ads — CTM" hint="Active CTM listings a Level-1 user may keep">
            <input className={inputCls} type="number" min="0" value={ncL1AdsCtm} onChange={(e) => setNcL1AdsCtm(e.target.value)} placeholder="2" />
          </Field>

          {/* ── Maker collateral bond (Phase 5) ── */}
          <div className="border-t border-border pt-3 mt-1">
            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={bondEnabled} onChange={(e) => setBondEnabled(e.target.checked)} className="mt-0.5 accent-primary w-4 h-4" />
              <div>
                <span className="text-sm font-medium text-text-primary">Maker collateral bond</span>
                <p className="text-xs text-text-muted mt-0.5">
                  When ON, opening a trade locks a USDT bond from the maker&apos;s deposited
                  balance. It releases on a clean close and is seized 100% to the victim if
                  the maker loses a dispute. Requires deposits to be funded.
                </p>
              </div>
            </label>
          </div>

          <Field label="Bond ratio (%)" hint="Bond locked per trade as % of trade size (10 = $1 bond per $10 trade)">
            <input className={inputCls} type="number" min="0" step="0.1" value={bondRatioPct} onChange={(e) => setBondRatioPct(e.target.value)} placeholder="10" />
          </Field>

          <Field label="Bond minimum (USDT)" hint="Floor per bond regardless of ratio. 0 = no minimum">
            <input className={inputCls} type="number" min="0" step="0.01" value={bondMinUsdt} onChange={(e) => setBondMinUsdt(e.target.value)} placeholder="0" />
          </Field>

          <div className="flex justify-end">
            <Button size="sm" loading={ncSaving} onClick={saveNonCustodial}>Save Non-Custodial Settings</Button>
          </div>
        </div>
      </Accordion>

      {/* ══ Marketing & Growth ════════════════════════════════════════════════ */}
      <Accordion
        title="Marketing & Growth"
        subtitle="Master switches for gas promo codes, referrals, giveaways and admin free-gas"
        open={mktOpen}
        onToggle={() => setMktOpen((v) => !v)}
        badge={
          (promoFlag || referralFlag || giveawayFlag || freeGrantFlag)
            ? <Badge variant="success" size="sm">{[promoFlag, referralFlag, giveawayFlag, freeGrantFlag].filter(Boolean).length} ON</Badge>
            : <Badge variant="outline" size="sm">All OFF</Badge>
        }
      >
        <div className="p-5 space-y-4">
          <p className="text-xs text-text-muted">
            Each switch is OFF by default. Turning one ON activates that feature platform-wide;
            turning it OFF instantly disables it. Discounts &amp; rewards only ever come from the
            platform margin — never the base gas cost.
          </p>

          <label className="flex items-start gap-3 rounded-xl border border-border p-3 cursor-pointer hover:bg-surface/40 transition-colors">
            <input type="checkbox" checked={promoFlag} onChange={(e) => setPromoFlag(e.target.checked)} className="mt-0.5 accent-primary w-4 h-4" />
            <div>
              <p className="text-sm font-medium text-text-primary">Promo codes <span className="font-mono text-xs text-text-muted">gas_promo_enabled</span></p>
              <p className="text-xs text-text-muted mt-0.5">Shows the &ldquo;Have a promo code?&rdquo; field on the gas payment screens and lets codes from Marketing → Promo Codes apply a margin discount.</p>
            </div>
          </label>

          <label className="flex items-start gap-3 rounded-xl border border-border p-3 cursor-pointer hover:bg-surface/40 transition-colors">
            <input type="checkbox" checked={referralFlag} onChange={(e) => setReferralFlag(e.target.checked)} className="mt-0.5 accent-primary w-4 h-4" />
            <div>
              <p className="text-sm font-medium text-text-primary">Referrals <span className="font-mono text-xs text-text-muted">gas_referral_enabled</span></p>
              <p className="text-xs text-text-muted mt-0.5">Activates the user Referral page: referral codes, binding, margin-share accrual and withdrawals.</p>
            </div>
          </label>

          <label className="flex items-start gap-3 rounded-xl border border-border p-3 cursor-pointer hover:bg-surface/40 transition-colors">
            <input type="checkbox" checked={affiliateFlag} onChange={(e) => setAffiliateFlag(e.target.checked)} className="mt-0.5 accent-primary w-4 h-4" />
            <div>
              <p className="text-sm font-medium text-text-primary">Custom links &amp; affiliate <span className="font-mono text-xs text-text-muted">gas_affiliate_enabled</span></p>
              <p className="text-xs text-text-muted mt-0.5">Adds self-service custom referral links (standard 5% friend discount + 5% commission), the buyer auto-discount at gas checkout, and the &ldquo;Become an affiliate&rdquo; application. Needs Referrals ON too.</p>
            </div>
          </label>

          <label className="flex items-start gap-3 rounded-xl border border-border p-3 cursor-pointer hover:bg-surface/40 transition-colors">
            <input type="checkbox" checked={giveawayFlag} onChange={(e) => setGiveawayFlag(e.target.checked)} className="mt-0.5 accent-primary w-4 h-4" />
            <div>
              <p className="text-sm font-medium text-text-primary">Giveaways <span className="font-mono text-xs text-text-muted">gas_giveaway_enabled</span></p>
              <p className="text-xs text-text-muted mt-0.5">Lets users enter KOL giveaway campaigns and lets admins draw winners (Marketing → Giveaways). Campaigns can be created while OFF, but entry &amp; draw are blocked until ON.</p>
            </div>
          </label>

          <label className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 cursor-pointer hover:bg-amber-500/10 transition-colors">
            <input type="checkbox" checked={freeGrantFlag} onChange={(e) => setFreeGrantFlag(e.target.checked)} className="mt-0.5 accent-primary w-4 h-4" />
            <div>
              <p className="text-sm font-medium text-text-primary">Admin free-gas delivery <span className="font-mono text-xs text-text-muted">gas_free_grant_enabled</span></p>
              <p className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">⚠️ Sends <b>real on-chain funds at the platform&apos;s expense</b>. Enables Marketing → Free Gas and giveaway draws. Only turn ON when you intend to sponsor users.</p>
            </div>
          </label>

          <div className="flex justify-end">
            <Button size="sm" loading={mktSaving} onClick={saveMarketing}>Save Marketing Settings</Button>
          </div>
        </div>
      </Accordion>

      {/* ══ Pricing Guardrails ════════════════════════════════════════════════ */}
      <Accordion
        title="Pricing Guardrails"
        subtitle="Max % a listing's price may deviate from the marketplace average (anti-scam)"
        open={pricingOpen}
        onToggle={() => setPricingOpen((v) => !v)}
        badge={<Badge variant="success" size="sm">±{usdtMargin || '5'}% / ±{ctmMargin || '5'}%</Badge>}
      >
        <div className="p-5 space-y-5">
          <p className="text-xs text-text-muted">
            New / edited listings must price within ±X% of <strong>our own marketplace</strong> average
            (USDT: average of active USDT ads · CTM: average of that token&apos;s listings). This blocks
            deceptive off-market prices. Set to <strong>0</strong> to disable a guardrail. When a coin/token
            has no listings yet, the first listings set the market and are not restricted.
          </p>
          <Field label="USDT margin (%)" hint="e.g. 5 = a USDT ad must be within ±5% of the marketplace average. 0 = off.">
            <input className={inputCls} type="number" min="0" step="0.5" value={usdtMargin} onChange={(e) => setUsdtMargin(e.target.value)} placeholder="5" />
          </Field>
          <Field label="CTM token margin (%)" hint="e.g. 5 = a token listing must be within ±5% of that token's average. 0 = off.">
            <input className={inputCls} type="number" min="0" step="0.5" value={ctmMargin} onChange={(e) => setCtmMargin(e.target.value)} placeholder="5" />
          </Field>
          <p className="text-xs text-text-muted pt-1">
            <strong>Bid bands (anti-scam):</strong> a bid must price within ±X% of the <strong>listed price</strong> of the
            ad/listing it targets, so a wildly off bid can&apos;t be used to bait a maker. Set to <strong>0</strong> to disable.
          </p>
          <Field label="USDT bid margin (%)" hint="e.g. 10 = a USDT bid must be within ±10% of the ad's listed price. 0 = off.">
            <input className={inputCls} type="number" min="0" step="0.5" value={usdtBidMargin} onChange={(e) => setUsdtBidMargin(e.target.value)} placeholder="10" />
          </Field>
          <Field label="CTM bid margin (%)" hint="e.g. 10 = a token bid must be within ±10% of the listing's price. 0 = off.">
            <input className={inputCls} type="number" min="0" step="0.5" value={ctmBidMargin} onChange={(e) => setCtmBidMargin(e.target.value)} placeholder="10" />
          </Field>
          <div className="flex justify-end">
            <Button size="sm" loading={marginSaving} onClick={savePricing}>Save Pricing Guardrails</Button>
          </div>
        </div>
      </Accordion>

      {/* ══ Trade Limits ══════════════════════════════════════════════════════ */}
      <Accordion
        title="Trade Limits"
        subtitle="Max simultaneous active trades per user (anti-scam concurrency cap)"
        open={limitsOpen}
        onToggle={() => setLimitsOpen((v) => !v)}
        badge={<Badge variant="success" size="sm">{maxConcurrent || '3'} / {maxConcurrentDispute || '1'}</Badge>}
      >
        <div className="p-5 space-y-5">
          <p className="text-xs text-text-muted">
            Caps how many in-progress trades a user can be part of at once (buyer OR seller,
            USDT + CTM combined). This stops one person collecting payment from several
            counterparties without delivering. Checked for <strong>both</strong> parties when a
            trade opens. Set to <strong>0</strong> for unlimited.
          </p>
          <Field label="Max active trades" hint="Normal cap per user (recommended 3). 0 = unlimited.">
            <input className={inputCls} type="number" min="0" value={maxConcurrent} onChange={(e) => setMaxConcurrent(e.target.value)} placeholder="3" />
          </Field>
          <Field label="Max with open dispute" hint="Reduced cap while a user has an unresolved dispute (recommended 1). 0 = unlimited.">
            <input className={inputCls} type="number" min="0" value={maxConcurrentDispute} onChange={(e) => setMaxConcurrentDispute(e.target.value)} placeholder="1" />
          </Field>
          <div className="border-t border-border pt-4">
            <Field label="Cap-exempt accounts" hint="Test / staff accounts that bypass the cap entirely. Comma-separated usernames or user IDs. Leave blank for none. Real users stay capped.">
              <input className={inputCls} value={bypassUserIds} onChange={(e) => setBypassUserIds(e.target.value)} placeholder="awazedil223, test_seller, …" />
            </Field>
            <p className="text-xs text-warning mt-2">For testing only — exempt accounts can hold unlimited simultaneous trades. Clear this list before launch.</p>
          </div>
          <div className="flex justify-end">
            <Button size="sm" loading={limitsSaving} onClick={saveLimits}>Save Trade Limits</Button>
          </div>
        </div>
      </Accordion>

      {/* ══ Branchless Wallets ════════════════════════════════════════════════ */}
      <Accordion
        title="Branchless Wallets"
        subtitle="Mobile wallet accounts shown to PKR customers (JazzCash, Easypaisa)"
        open={walletOpen}
        onToggle={() => setWalletOpen((v) => !v)}
        badge={(jcConfigured || epConfigured) ? <Badge variant="success" size="sm">Active</Badge> : <Badge variant="outline" size="sm">None set</Badge>}
      >
        <div className="p-5 space-y-6">

          {/* JazzCash */}
          <ProviderCard
            label="JazzCash"
            configured={jcConfigured}
            icon={<div className="w-8 h-8 rounded-lg bg-[#CC0000]/10 flex items-center justify-center text-sm font-bold text-[#CC0000]">JC</div>}
          >
            <LogoUploadField logoUrl={jcLogo} onLogoUrlChange={setJcLogo} />
            <Field label="Account Name" hint="Full name on the JazzCash account">
              <input className={inputCls} placeholder="e.g. Muhammad Fazal Elahi" value={jcName} onChange={(e) => setJcName(e.target.value)} />
            </Field>
            <Field label="Account / Payment Number" hint="Registered JazzCash number (03XXXXXXXXX)">
              <input className={inputCls} placeholder="e.g. 03001234567" value={jcNumber} onChange={(e) => setJcNumber(e.target.value)} />
            </Field>
            <div className="flex justify-end">
              <Button size="sm" loading={jcSaving} onClick={saveJazzCash}>Save JazzCash</Button>
            </div>
          </ProviderCard>

          {/* Easypaisa */}
          <ProviderCard
            label="Easypaisa"
            configured={epConfigured}
            icon={<div className="w-8 h-8 rounded-lg bg-[#00A651]/10 flex items-center justify-center text-sm font-bold text-[#00A651]">EP</div>}
          >
            <LogoUploadField logoUrl={epLogo} onLogoUrlChange={setEpLogo} />
            <Field label="Account Name" hint="Full name on the Easypaisa account">
              <input className={inputCls} placeholder="e.g. Muhammad Fazal Elahi" value={epName} onChange={(e) => setEpName(e.target.value)} />
            </Field>
            <Field label="Account / Payment Number" hint="Registered Easypaisa number (03XXXXXXXXX)">
              <input className={inputCls} placeholder="e.g. 03001234567" value={epNumber} onChange={(e) => setEpNumber(e.target.value)} />
            </Field>
            <div className="flex justify-end">
              <Button size="sm" loading={epSaving} onClick={saveEasypaisa}>Save Easypaisa</Button>
            </div>
          </ProviderCard>

        </div>
      </Accordion>

      {/* ══ EMIs / Fintechs ══════════════════════════════════════════════════ */}
      <Accordion
        title="EMIs / Fintechs"
        subtitle="Digital banking accounts shown to PKR customers (Nayapay, Sadapay)"
        open={emiOpen}
        onToggle={() => setEmiOpen((v) => !v)}
        badge={(npConfigured || spConfigured) ? <Badge variant="success" size="sm">Active</Badge> : <Badge variant="outline" size="sm">None set</Badge>}
      >
        <div className="p-5 space-y-6">

          {/* Nayapay */}
          <ProviderCard
            label="Nayapay"
            configured={npConfigured}
            icon={<div className="w-8 h-8 rounded-lg bg-purple-500/15 flex items-center justify-center text-sm font-bold text-purple-600 dark:text-purple-400">NP</div>}
          >
            <LogoUploadField logoUrl={npLogo} onLogoUrlChange={setNpLogo} />
            <Field label="Account Name" hint="Full name on the Nayapay account">
              <input className={inputCls} placeholder="e.g. Muhammad Fazal Elahi" value={npName} onChange={(e) => setNpName(e.target.value)} />
            </Field>
            <Field label="Account / IBAN" hint="Nayapay account number or IBAN">
              <input className={inputCls + ' font-mono'} placeholder="e.g. 03001234567 or PK…" value={npNumber} onChange={(e) => setNpNumber(e.target.value)} />
            </Field>
            <div className="flex justify-end">
              <Button size="sm" loading={npSaving} onClick={saveNayapay}>Save Nayapay</Button>
            </div>
          </ProviderCard>

          {/* Sadapay */}
          <ProviderCard
            label="Sadapay"
            configured={spConfigured}
            icon={<div className="w-8 h-8 rounded-lg bg-orange-500/15 flex items-center justify-center text-sm font-bold text-orange-600 dark:text-orange-400">SP</div>}
          >
            <LogoUploadField logoUrl={spLogo} onLogoUrlChange={setSpLogo} />
            <Field label="Account Name" hint="Full name on the Sadapay account">
              <input className={inputCls} placeholder="e.g. Muhammad Fazal Elahi" value={spName} onChange={(e) => setSpName(e.target.value)} />
            </Field>
            <Field label="Account / IBAN" hint="Sadapay account number or IBAN">
              <input className={inputCls + ' font-mono'} placeholder="e.g. 03001234567 or PK…" value={spNumber} onChange={(e) => setSpNumber(e.target.value)} />
            </Field>
            <div className="flex justify-end">
              <Button size="sm" loading={spSaving} onClick={saveSadapay}>Save Sadapay</Button>
            </div>
          </ProviderCard>

        </div>
      </Accordion>

      {/* ══ Commercial Banks ══════════════════════════════════════════════════ */}
      <Accordion
        title="Commercial Banks"
        subtitle="Bank account shown to PKR customers paying via bank transfer"
        open={bankOpen}
        onToggle={() => setBankOpen((v) => !v)}
        badge={bkConfigured ? <Badge variant="success" size="sm">Configured</Badge> : <Badge variant="outline" size="sm">Not set</Badge>}
      >
        <div className="p-5">
          <ProviderCard
            label="Bank Transfer"
            configured={bkConfigured}
            icon={<div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-sm font-bold text-primary">BK</div>}
          >
            <LogoUploadField logoUrl={bkLogo} onLogoUrlChange={setBkLogo} />
            <Field label="Bank" hint="Select your bank">
              <select className={selectCls} value={bkName} onChange={(e) => setBkName(e.target.value)}>
                <option value="">— Select bank —</option>
                {PK_BANKS.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </Field>
            <Field label="Account Holder Name" hint="Full name exactly as on your account">
              <input className={inputCls} placeholder="e.g. Muhammad Fazal Elahi" value={bkAccName} onChange={(e) => setBkAccName(e.target.value)} />
            </Field>
            <Field label="IBAN" hint="24-character Pakistani IBAN (PK + 22 digits)">
              <input
                className={inputCls + ' font-mono tracking-wide uppercase'}
                placeholder="PK36HABB0000123456789012"
                value={bkIban}
                onChange={(e) => setBkIban(e.target.value.toUpperCase())}
                maxLength={24}
              />
            </Field>
            <Field label="Account Number" hint="Optional if IBAN is provided">
              <input className={inputCls + ' font-mono'} placeholder="e.g. 01234567890101" value={bkAccNo} onChange={(e) => setBkAccNo(e.target.value)} />
            </Field>
            <div className="flex justify-end">
              <Button size="sm" loading={bkSaving} onClick={saveBank}>Save Bank Details</Button>
            </div>
          </ProviderCard>
        </div>
      </Accordion>

      {/* ══ Crypto Deposit Addresses ══════════════════════════════════════════ */}
      <Accordion
        title="Crypto Deposit Addresses"
        subtitle="Platform wallet addresses where customers send USDT to pay for gas orders"
        open={cryptoOpen}
        onToggle={() => setCryptoOpen((v) => !v)}
        badge={(bep20Set || aptosSet) ? <Badge variant="success" size="sm">Configured</Badge> : <Badge variant="outline" size="sm">Not set</Badge>}
      >
        <div className="p-5 space-y-6">

          {/* BEP20 */}
          <ProviderCard
            label="USDT BEP20 (BSC)"
            configured={bep20Set}
            icon={<div className="w-8 h-8 rounded-lg bg-yellow-500/15 flex items-center justify-center text-sm font-bold text-yellow-700 dark:text-yellow-300">BNB</div>}
          >
            <LogoUploadField logoUrl={bep20Logo} onLogoUrlChange={setBep20Logo} />
            <Field label="Deposit Address" hint={bep20Set ? 'Override — using DB value' : 'Leave blank to auto-use hot wallet'}>
              <input
                className={inputCls + ' font-mono text-xs'}
                placeholder="0x… (leave blank to auto-use hot wallet)"
                value={bep20Addr}
                onChange={(e) => setBep20Addr(e.target.value)}
              />
            </Field>
          </ProviderCard>

          {/* Aptos */}
          <ProviderCard
            label="USDT Aptos"
            configured={aptosSet}
            icon={<div className="w-8 h-8 rounded-lg bg-teal-500/15 flex items-center justify-center text-sm font-bold text-teal-700 dark:text-teal-300">APT</div>}
          >
            <LogoUploadField logoUrl={aptosLogo} onLogoUrlChange={setAptosLogo} />
            <Field label="Deposit Address" hint="64-char Aptos address">
              <input
                className={inputCls + ' font-mono text-xs'}
                placeholder="0x… (64-char Aptos address)"
                value={aptosAddr}
                onChange={(e) => setAptosAddr(e.target.value)}
              />
            </Field>
          </ProviderCard>

          <div className="flex justify-end">
            <Button size="sm" loading={cryptoSaving} onClick={saveCrypto}>Save Addresses</Button>
          </div>

          <p className="text-xs text-text-muted px-1">
            Other deposit addresses (TRC20, ERC20) are managed in the <strong>Wallet</strong> section of the admin panel.
          </p>
        </div>
      </Accordion>

      {/* ══ Homepage Top Offers ═══════════════════════════════════════════════ */}
      <Accordion
        title="Homepage Top Offers"
        subtitle="Control which USDT offers are featured in the homepage Top Offers section"
        open={offersOpen}
        onToggle={() => setOffersOpen((v) => !v)}
        badge={<Badge variant="success" size="sm">{offersMode === 'top' ? 'Top recommended' : offersMode === 'latest' ? 'Latest' : 'Manually pinned'}</Badge>}
      >
        <div className="p-5 space-y-4">
          <div className="space-y-2">
            {([
              { value: 'top' as const, label: 'Show top recommended offers', hint: 'Ranked by trust score, completion rate, rating and trade volume.' },
              { value: 'latest' as const, label: 'Show latest offers', hint: 'Newest active offers first — gives more traders exposure.' },
              { value: 'pinned' as const, label: 'Manually pin offers', hint: 'Feature specific offers by their Ad IDs (top offers fill remaining slots).' },
            ]).map((opt) => (
              <label key={opt.value} className={`flex items-start gap-3 rounded-xl border p-3 cursor-pointer transition-colors ${offersMode === opt.value ? 'border-primary bg-primary/5' : 'border-border hover:bg-surface/40'}`}>
                <input
                  type="radio"
                  name="home_offers_mode"
                  checked={offersMode === opt.value}
                  onChange={() => setOffersMode(opt.value)}
                  className="mt-0.5 accent-primary"
                />
                <div>
                  <p className="text-sm font-medium text-text-primary">{opt.label}</p>
                  <p className="text-xs text-text-muted mt-0.5">{opt.hint}</p>
                </div>
              </label>
            ))}
          </div>

          {offersMode === 'pinned' && (
            <Field label="Pinned Ad IDs" hint="Comma-separated Ad IDs, shown in order. Find IDs in the Trades/Ads admin views.">
              <input
                className={inputCls + ' font-mono text-xs'}
                placeholder="adId1, adId2, adId3, adId4"
                value={pinnedAdIds}
                onChange={(e) => setPinnedAdIds(e.target.value)}
              />
            </Field>
          )}

          <div className="flex justify-end">
            <Button size="sm" loading={offersSaving} onClick={saveOffers}>Save Top Offers</Button>
          </div>
        </div>
      </Accordion>

      {/* ══ Advanced / Other Settings ═════════════════════════════════════════ */}
      {otherRows.length > 0 && (
        <Accordion
          title="Advanced Settings"
          subtitle={`${otherRows.length} other configuration values`}
          open={advOpen}
          onToggle={() => setAdvOpen((v) => !v)}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface/40">
                <tr>
                  <th className="text-left px-5 py-2.5 font-medium text-text-muted w-52">Key</th>
                  <th className="text-left px-4 py-2.5 font-medium text-text-muted w-44">Current Value</th>
                  <th className="text-left px-4 py-2.5 font-medium text-text-muted w-36">Last Updated</th>
                  <th className="px-4 py-2.5 w-16" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {otherRows.map((row) => {
                  const sensitive  = isSensitive(row.key)
                  const revealed   = showSensitive[row.key]
                  const isEditing  = editKey === row.key
                  const isReadonly = row.key === 'next_evm_derivation_index'
                  return (
                    <tr key={row.key} className="hover:bg-surface/30">
                      <td className="px-5 py-3 align-top">
                        <p className="font-mono text-xs text-text-primary break-all">{row.key}</p>
                        {isReadonly && <Badge variant="warning" size="sm" className="mt-1">System-managed</Badge>}
                      </td>
                      <td className="px-4 py-3 align-top">
                        {isEditing ? (
                          <div className="space-y-1.5">
                            <input
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              className="w-full px-2.5 py-1.5 border border-border rounded-lg text-xs font-mono bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
                              autoFocus
                              onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(row.key); if (e.key === 'Escape') setEditKey(null) }}
                            />
                            <div className="flex gap-1.5">
                              <Button size="sm" loading={editSaving} onClick={() => saveEdit(row.key)}>Save</Button>
                              <Button size="sm" variant="secondary" onClick={() => setEditKey(null)} disabled={editSaving}>Cancel</Button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-xs text-text-secondary break-all">
                              {sensitive && !revealed ? maskValue(row.value) : (row.value || <span className="text-text-muted italic">empty</span>)}
                            </span>
                            {sensitive && (
                              <button onClick={() => setShowSensitive((p) => ({ ...p, [row.key]: !p[row.key] }))} className="text-xs text-text-muted hover:text-primary underline flex-shrink-0">
                                {revealed ? 'Hide' : 'Show'}
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top text-xs text-text-muted">{fmtDateTime(row.updatedAt)}</td>
                      <td className="px-4 py-3 align-top text-right">
                        {isReadonly ? (
                          <span className="text-xs text-text-muted" title="System-managed — do not edit">Read-only</span>
                        ) : !isEditing && (
                          <Button size="sm" variant="ghost" onClick={() => { setEditKey(row.key); setEditValue(row.value) }}>Edit</Button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Accordion>
      )}

      <div className="bg-surface rounded-xl border border-border px-5 py-4 text-xs text-text-muted">
        <p className="font-semibold text-text-secondary text-sm mb-1">Infrastructure Secrets</p>
        <p>Private keys, wallet seeds, database credentials, and blockchain RPC keys are stored as Railway environment variables and are never exposed here.</p>
      </div>
    </div>
  )
}
