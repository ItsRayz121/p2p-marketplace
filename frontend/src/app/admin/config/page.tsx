'use client'
import { useState, useCallback, useEffect } from 'react'
import { adminApi } from '@/lib/api'
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
  'gas_pkr_jazzcash_name', 'gas_pkr_jazzcash_number',
  'gas_pkr_easypaisa_name', 'gas_pkr_easypaisa_number',
  'gas_pkr_bank_name', 'gas_pkr_bank_account_name', 'gas_pkr_bank_iban', 'gas_pkr_bank_account_number',
  'gas_usdt_bep20_address', 'gas_usdt_aptos_address',
  'gas_bep20_logo_url', 'gas_aptos_logo_url',
])

// ── Keys shown in the raw "Other Settings" table ──────────────────────────────
const SENSITIVE_PATTERNS = ['private_key', 'secret', 'password', 'token', 'api_key']
function isSensitive(key: string) { return SENSITIVE_PATTERNS.some((p) => key.toLowerCase().includes(p)) }
function maskValue(v: string) { return v.length <= 6 ? '••••••' : v.slice(0, 3) + '•'.repeat(Math.min(v.length - 6, 16)) + v.slice(-3) }

// ── Accordion wrapper ─────────────────────────────────────────────────────────
function Accordion({ title, subtitle, open, onToggle, children, badge }: {
  title: string; subtitle?: string; open: boolean; onToggle: () => void
  children: React.ReactNode; badge?: React.ReactNode
}) {
  return (
    <div className="bg-white rounded-xl border border-border overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-surface/40 transition-colors text-left"
      >
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

const inputCls = 'w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-white focus:outline-none focus:ring-2 focus:ring-primary placeholder:text-text-muted'
const selectCls = inputCls + ' cursor-pointer'

// ── Status badge for a payment method ────────────────────────────────────────
function MethodBadge({ configured }: { configured: boolean }) {
  return configured
    ? <Badge variant="success" size="sm">Configured</Badge>
    : <Badge variant="outline" size="sm">Not set</Badge>
}

export default function ConfigPage() {
  const { user } = useAuthStore()
  const router = useRouter()
  const [rows, setRows] = useState<ConfigRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Accordion open state
  const [pkrOpen, setPkrOpen] = useState(true)
  const [cryptoOpen, setCryptoOpen] = useState(false)
  const [advOpen, setAdvOpen] = useState(false)

  // Global save feedback
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)
  function showToast(msg: string, ok = true) {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 4000)
  }

  // ── Form state: JazzCash ──────────────────────────────────────────────────
  const [jcName, setJcName]       = useState('')
  const [jcNumber, setJcNumber]   = useState('')
  const [jcSaving, setJcSaving]   = useState(false)

  // ── Form state: Easypaisa ─────────────────────────────────────────────────
  const [epName, setEpName]       = useState('')
  const [epNumber, setEpNumber]   = useState('')
  const [epSaving, setEpSaving]   = useState(false)

  // ── Form state: Bank Transfer ─────────────────────────────────────────────
  const [bkName, setBkName]       = useState('')  // bank name
  const [bkAccName, setBkAccName] = useState('')  // account holder name
  const [bkIban, setBkIban]       = useState('')
  const [bkAccNo, setBkAccNo]     = useState('')
  const [bkSaving, setBkSaving]   = useState(false)

  // ── Form state: Crypto ────────────────────────────────────────────────────
  const [bep20Addr, setBep20Addr]       = useState('')
  const [aptosAddr, setAptosAddr]       = useState('')
  const [bep20Logo, setBep20Logo]       = useState('')
  const [aptosLogo, setAptosLogo]       = useState('')
  const [cryptoSaving, setCryptoSaving] = useState(false)

  // ── Raw table edit ────────────────────────────────────────────────────────
  const [editKey, setEditKey]     = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
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
      // Populate form fields from DB
      const m: Record<string, string> = {}
      arr.forEach((r) => { m[r.key] = r.value })
      setJcName(m['gas_pkr_jazzcash_name'] ?? '')
      setJcNumber(m['gas_pkr_jazzcash_number'] ?? '')
      setEpName(m['gas_pkr_easypaisa_name'] ?? '')
      setEpNumber(m['gas_pkr_easypaisa_number'] ?? '')
      setBkName(m['gas_pkr_bank_name'] ?? '')
      setBkAccName(m['gas_pkr_bank_account_name'] ?? '')
      setBkIban(m['gas_pkr_bank_iban'] ?? '')
      setBkAccNo(m['gas_pkr_bank_account_number'] ?? '')
      setBep20Addr(m['gas_usdt_bep20_address'] ?? '')
      setAptosAddr(m['gas_usdt_aptos_address'] ?? '')
      setBep20Logo(m['gas_bep20_logo_url'] ?? '')
      setAptosLogo(m['gas_aptos_logo_url'] ?? '')
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load config')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchConfig() }, [fetchConfig])

  // ── Helper: upsert a key into rows state ──────────────────────────────────
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

  // ── Save JazzCash ─────────────────────────────────────────────────────────
  async function saveJazzCash() {
    setJcSaving(true)
    try {
      await saveKeys([
        { key: 'gas_pkr_jazzcash_name',   value: jcName.trim() },
        { key: 'gas_pkr_jazzcash_number', value: jcNumber.trim() },
      ])
      showToast('JazzCash details saved.')
    } catch { showToast('Failed to save JazzCash details.', false) }
    finally { setJcSaving(false) }
  }

  // ── Save Easypaisa ────────────────────────────────────────────────────────
  async function saveEasypaisa() {
    setEpSaving(true)
    try {
      await saveKeys([
        { key: 'gas_pkr_easypaisa_name',   value: epName.trim() },
        { key: 'gas_pkr_easypaisa_number', value: epNumber.trim() },
      ])
      showToast('Easypaisa details saved.')
    } catch { showToast('Failed to save Easypaisa details.', false) }
    finally { setEpSaving(false) }
  }

  // ── Save Bank Transfer ────────────────────────────────────────────────────
  async function saveBank() {
    setBkSaving(true)
    try {
      await saveKeys([
        { key: 'gas_pkr_bank_name',           value: bkName.trim() },
        { key: 'gas_pkr_bank_account_name',   value: bkAccName.trim() },
        { key: 'gas_pkr_bank_iban',           value: bkIban.trim().toUpperCase() },
        { key: 'gas_pkr_bank_account_number', value: bkAccNo.trim() },
      ])
      showToast('Bank transfer details saved.')
    } catch { showToast('Failed to save bank details.', false) }
    finally { setBkSaving(false) }
  }

  // ── Save Crypto ───────────────────────────────────────────────────────────
  async function saveCrypto() {
    setCryptoSaving(true)
    try {
      const pairs: Array<{ key: string; value: string }> = []
      if (bep20Addr.trim()) pairs.push({ key: 'gas_usdt_bep20_address', value: bep20Addr.trim() })
      if (aptosAddr.trim()) pairs.push({ key: 'gas_usdt_aptos_address', value: aptosAddr.trim() })
      if (bep20Logo.trim()) pairs.push({ key: 'gas_bep20_logo_url', value: bep20Logo.trim() })
      if (aptosLogo.trim()) pairs.push({ key: 'gas_aptos_logo_url', value: aptosLogo.trim() })
      if (pairs.length === 0) { showToast('Enter at least one address.', false); return }
      await saveKeys(pairs)
      showToast('Crypto deposit addresses saved.')
    } catch { showToast('Failed to save crypto addresses.', false) }
    finally { setCryptoSaving(false) }
  }

  // ── Save raw edit ─────────────────────────────────────────────────────────
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
  const bkConfigured  = !!(cfgMap['gas_pkr_bank_name'] && cfgMap['gas_pkr_bank_account_name'])
  const pkrAnySet     = jcConfigured || epConfigured || bkConfigured
  const bep20Set      = !!cfgMap['gas_usdt_bep20_address']
  const aptosSet      = !!cfgMap['gas_usdt_aptos_address']

  // Raw "other" rows — exclude structured keys
  const otherRows = rows.filter((r) => !STRUCTURED_KEYS.has(r.key))

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Platform Configuration</h1>
        <p className="text-text-muted text-sm mt-0.5">Super admin only</p>
      </div>

      {/* ── Toast ─────────────────────────────────────────────────────────── */}
      {toast && (
        <div className={`px-4 py-3 rounded-xl text-sm ${toast.ok ? 'bg-success/10 border border-success/20 text-success' : 'bg-danger/10 border border-danger/20 text-danger'}`}>
          {toast.msg}
        </div>
      )}

      {/* ══ SECTION 1 — PKR Payment Methods ══════════════════════════════════ */}
      <Accordion
        title="PKR Payment Methods"
        subtitle="Bank accounts shown to customers paying with Pakistani Rupees (gas orders)"
        open={pkrOpen}
        onToggle={() => setPkrOpen((v) => !v)}
        badge={pkrAnySet ? <Badge variant="success" size="sm">Active</Badge> : <Badge variant="outline" size="sm">None set</Badge>}
      >
        <div className="p-5 space-y-6">

          {/* ── JazzCash ─────────────────────────────────────────────────── */}
          <div className="rounded-xl border border-border p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-[#CC0000]/10 flex items-center justify-center text-sm font-bold text-[#CC0000]">JC</div>
                <span className="font-semibold text-text-primary">JazzCash</span>
              </div>
              <MethodBadge configured={jcConfigured} />
            </div>
            <Field label="Account Name" hint="Full name on the JazzCash account">
              <input className={inputCls} placeholder="e.g. Muhammad Fazal Elahi" value={jcName} onChange={(e) => setJcName(e.target.value)} />
            </Field>
            <Field label="Mobile Number" hint="Registered JazzCash number (03XXXXXXXXX)">
              <input className={inputCls} placeholder="e.g. 03001234567" value={jcNumber} onChange={(e) => setJcNumber(e.target.value)} />
            </Field>
            <div className="flex justify-end">
              <Button size="sm" loading={jcSaving} onClick={saveJazzCash}>Save JazzCash</Button>
            </div>
          </div>

          {/* ── Easypaisa ────────────────────────────────────────────────── */}
          <div className="rounded-xl border border-border p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-[#00A651]/10 flex items-center justify-center text-sm font-bold text-[#00A651]">EP</div>
                <span className="font-semibold text-text-primary">Easypaisa</span>
              </div>
              <MethodBadge configured={epConfigured} />
            </div>
            <Field label="Account Name" hint="Full name on the Easypaisa account">
              <input className={inputCls} placeholder="e.g. Muhammad Fazal Elahi" value={epName} onChange={(e) => setEpName(e.target.value)} />
            </Field>
            <Field label="Mobile Number" hint="Registered Easypaisa number (03XXXXXXXXX)">
              <input className={inputCls} placeholder="e.g. 03001234567" value={epNumber} onChange={(e) => setEpNumber(e.target.value)} />
            </Field>
            <div className="flex justify-end">
              <Button size="sm" loading={epSaving} onClick={saveEasypaisa}>Save Easypaisa</Button>
            </div>
          </div>

          {/* ── Bank Transfer ─────────────────────────────────────────────── */}
          <div className="rounded-xl border border-border p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-sm font-bold text-primary">BK</div>
                <span className="font-semibold text-text-primary">Bank Transfer</span>
              </div>
              <MethodBadge configured={bkConfigured} />
            </div>
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
            <Field label="Account Number" hint="Your bank account number (optional if IBAN provided)">
              <input className={inputCls + ' font-mono'} placeholder="e.g. 01234567890101" value={bkAccNo} onChange={(e) => setBkAccNo(e.target.value)} />
            </Field>
            <div className="flex justify-end">
              <Button size="sm" loading={bkSaving} onClick={saveBank}>Save Bank Details</Button>
            </div>
          </div>

        </div>
      </Accordion>

      {/* ══ SECTION 2 — Crypto Deposit Addresses ═════════════════════════════ */}
      <Accordion
        title="Crypto Deposit Addresses"
        subtitle="Platform wallet addresses where customers send USDT to pay for gas orders"
        open={cryptoOpen}
        onToggle={() => setCryptoOpen((v) => !v)}
        badge={(bep20Set || aptosSet) ? <Badge variant="success" size="sm">Configured</Badge> : <Badge variant="outline" size="sm">Not set</Badge>}
      >
        <div className="p-5 space-y-4">
          <div className="rounded-xl border border-border p-4 space-y-4">

            <Field
              label="USDT BEP20 (BSC)"
              hint={bep20Set ? 'Override address — using DB value' : 'Leave blank to use mnemonic-derived hot wallet address automatically'}
            >
              <input
                className={inputCls + ' font-mono text-xs'}
                placeholder="0x… (leave blank to auto-use hot wallet)"
                value={bep20Addr}
                onChange={(e) => setBep20Addr(e.target.value)}
              />
            </Field>

            <Field label="BEP20 Logo URL" hint="Image URL shown on the payment network card (e.g. BNB logo)">
              <div className="flex items-center gap-2">
                {bep20Logo && <img src={bep20Logo} alt="BEP20 logo" className="w-8 h-8 rounded-full object-contain border border-border flex-shrink-0" onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />}
                <input
                  className={inputCls + ' flex-1'}
                  placeholder="https://… (PNG/SVG image URL)"
                  value={bep20Logo}
                  onChange={(e) => setBep20Logo(e.target.value)}
                />
              </div>
            </Field>

            <Field
              label="USDT Aptos"
              hint="Must be set to enable Aptos as a payment option"
            >
              <input
                className={inputCls + ' font-mono text-xs'}
                placeholder="0x… (64-char Aptos address)"
                value={aptosAddr}
                onChange={(e) => setAptosAddr(e.target.value)}
              />
            </Field>

            <Field label="Aptos Logo URL" hint="Image URL shown on the payment network card (e.g. APT logo)">
              <div className="flex items-center gap-2">
                {aptosLogo && <img src={aptosLogo} alt="Aptos logo" className="w-8 h-8 rounded-full object-contain border border-border flex-shrink-0" onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />}
                <input
                  className={inputCls + ' flex-1'}
                  placeholder="https://… (PNG/SVG image URL)"
                  value={aptosLogo}
                  onChange={(e) => setAptosLogo(e.target.value)}
                />
              </div>
            </Field>

            <div className="flex justify-end">
              <Button size="sm" loading={cryptoSaving} onClick={saveCrypto}>Save Addresses</Button>
            </div>
          </div>

          <p className="text-xs text-text-muted px-1">
            Other deposit addresses (TRC20, ERC20) are managed in the <strong>Wallet</strong> section of the admin panel.
          </p>
        </div>
      </Accordion>

      {/* ══ SECTION 3 — Advanced / Other Settings ════════════════════════════ */}
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
                  const sensitive = isSensitive(row.key)
                  const revealed  = showSensitive[row.key]
                  const isEditing = editKey === row.key
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
                              className="w-full px-2.5 py-1.5 border border-border rounded-lg text-xs font-mono bg-white focus:outline-none focus:ring-2 focus:ring-primary"
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

      {/* Infrastructure notice */}
      <div className="bg-surface rounded-xl border border-border px-5 py-4 text-xs text-text-muted">
        <p className="font-semibold text-text-secondary text-sm mb-1">Infrastructure Secrets</p>
        <p>Private keys, wallet seeds, database credentials, and blockchain RPC keys are stored as Railway environment variables and are never exposed here.</p>
      </div>
    </div>
  )
}
