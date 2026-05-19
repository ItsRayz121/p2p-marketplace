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

// Known config keys with metadata
interface KeyMeta {
  label: string
  description: string
  category: string
  sensitive?: boolean
  placeholder?: string
  readonly?: boolean
  readonlyReason?: string
}

const KEY_META: Record<string, KeyMeta> = {
  // Payment Settings
  'fee_platform_percent':        { label: 'Platform Fee %',           description: 'Percentage fee charged on each trade (e.g. 0.5 = 0.5%)', category: 'Payment', placeholder: '0.5' },
  'fee_gas_markup_percent':      { label: 'Gas Fee Markup %',         description: 'Markup over actual gas cost charged to user (e.g. 50 = 50%)', category: 'Payment', placeholder: '50' },
  'pkr_bank_account_title':      { label: 'Bank Account Title',       description: 'Account holder name for PKR bank transfers', category: 'Payment' },
  'pkr_bank_account_number':     { label: 'Bank Account Number',      description: 'Account number for PKR bank transfers', category: 'Payment' },
  'pkr_bank_name':               { label: 'Bank Name',                description: 'Name of the bank for PKR transfers', category: 'Payment' },
  'pkr_easypaisa_number':        { label: 'Easypaisa Number',         description: 'Mobile account number for Easypaisa payments', category: 'Payment' },
  'pkr_jazzcash_number':         { label: 'JazzCash Number',          description: 'Mobile account number for JazzCash payments', category: 'Payment' },
  'payment_proof_expiry_hours':  { label: 'Proof Upload Expiry (hrs)', description: 'Hours before an unconfirmed payment proof expires', category: 'Payment', placeholder: '24' },
  // Crypto Deposit Settings
  'deposit_address_usdt_trc20':  { label: 'USDT TRC20 Deposit',       description: 'Platform TRON deposit address for USDT TRC20 payments', category: 'Crypto Deposit' },
  'deposit_address_usdt_bep20':  { label: 'USDT BEP20 Deposit',       description: 'Platform BSC deposit address for USDT BEP20 payments', category: 'Crypto Deposit' },
  'deposit_address_usdt_erc20':  { label: 'USDT ERC20 Deposit',       description: 'Platform Ethereum deposit address for USDT ERC20 payments', category: 'Crypto Deposit' },
  // Gas System Settings
  'gas_max_usd_limit':           { label: 'Gas Max USD Limit',        description: 'Maximum USD value of gas fee per single order', category: 'Gas System', placeholder: '50' },
  'gas_expiry_minutes':          { label: 'Gas Order Expiry (min)',   description: 'Minutes before an unpaid gas order expires', category: 'Gas System', placeholder: '30' },
  'gas_pkr_proof_expiry_hours':  { label: 'PKR Proof Expiry (hrs)',   description: 'Hours before a PKR payment proof for gas expires', category: 'Gas System', placeholder: '2' },
  'gas_custom_daily_limit':      { label: 'Custom Request Daily Limit', description: 'Max custom gas requests per user per day', category: 'Gas System', placeholder: '3' },
  // Gas PKR Payment Methods
  'gas_pkr_bank_name':           { label: 'Gas Bank Name',            description: 'Bank name shown to users for gas PKR bank transfer payments', category: 'Gas System' },
  'gas_pkr_bank_account_name':   { label: 'Gas Bank Account Name',    description: 'Account holder name for gas PKR bank transfers', category: 'Gas System' },
  'gas_pkr_bank_iban':           { label: 'Gas Bank IBAN',            description: 'IBAN for gas PKR bank transfer payments', category: 'Gas System' },
  'gas_pkr_bank_account_number': { label: 'Gas Bank Account No.',     description: 'Account number for gas PKR bank transfer payments', category: 'Gas System' },
  'gas_pkr_easypaisa_number':    { label: 'Gas Easypaisa Number',     description: 'Easypaisa mobile number for gas PKR payments', category: 'Gas System' },
  'gas_pkr_easypaisa_name':      { label: 'Gas Easypaisa Name',       description: 'Easypaisa account name for gas PKR payments', category: 'Gas System' },
  'gas_pkr_jazzcash_number':     { label: 'Gas JazzCash Number',      description: 'JazzCash mobile number for gas PKR payments', category: 'Gas System' },
  'gas_pkr_jazzcash_name':       { label: 'Gas JazzCash Name',        description: 'JazzCash account name for gas PKR payments', category: 'Gas System' },
  // Gas Crypto Payment Methods
  'gas_usdt_bep20_address':      { label: 'Gas USDT BEP20 Address',   description: 'Platform BSC address to receive USDT BEP20 for gas orders. Leave blank to use mnemonic-derived hot wallet address.', category: 'Gas System' },
  'gas_usdt_aptos_address':      { label: 'Gas USDT Aptos Address',   description: 'Platform Aptos address to receive USDT for gas orders. Set this to enable Aptos payment method.', category: 'Gas System' },
  // Notification Settings
  'admin_email':                 { label: 'Admin Email',              description: 'Primary admin email for system notifications', category: 'Notifications' },
  'alert_email':                 { label: 'Alert Email',              description: 'Email address for critical alerts', category: 'Notifications' },
  // KYC Settings
  'kyc_required':                { label: 'KYC Required',             description: 'Whether users must complete KYC to trade (true/false)', category: 'KYC' },
  'kyc_auto_approve':            { label: 'KYC Auto-Approve',         description: 'Auto-approve KYC submissions without manual review (true/false)', category: 'KYC' },
  // Merchant Settings
  'merchant_fee_percent':        { label: 'Merchant Fee %',           description: 'Fee rate applied to merchant trades', category: 'Merchant', placeholder: '0.3' },
  'merchant_min_volume':         { label: 'Merchant Min Volume',      description: 'Minimum trade volume (PKR) to maintain merchant status', category: 'Merchant' },
  // Referral Settings
  'referral_bonus_percent':      { label: 'Referral Bonus %',         description: 'Percentage bonus awarded to referrer on first trade', category: 'Referral' },
  'referral_min_trade_pkr':      { label: 'Referral Min Trade (PKR)', description: 'Minimum PKR trade size for referral bonus to apply', category: 'Referral' },
  // Site Settings
  'site_maintenance':            { label: 'Maintenance Mode',         description: 'Set to "true" to enable site-wide maintenance mode', category: 'Site' },
  'site_notice':                 { label: 'Site Notice',              description: 'Banner message shown to all users (leave empty to hide)', category: 'Site' },
  // System — read-only counters managed by the application
  'next_evm_derivation_index':   {
    label: 'EVM HD Derivation Counter',
    description: 'Monotonically increasing counter for BIP-32 HD wallet address derivation. Each new user deposit address claims the next index. Editing this value will cause address collisions or skipped derivation paths — do not change it manually.',
    category: 'Other',
    readonly: true,
    readonlyReason: 'System-managed. Editing risks address collisions across user wallets.',
  },
}

const CATEGORY_ORDER = ['Payment', 'Crypto Deposit', 'Gas System', 'KYC', 'Merchant', 'Referral', 'Notifications', 'Site', 'Other']

const SENSITIVE_PATTERNS = ['private_key', 'secret', 'password', 'token', 'api_key']

function isSensitive(key: string): boolean {
  const lower = key.toLowerCase()
  return SENSITIVE_PATTERNS.some((p) => lower.includes(p))
}

function maskValue(value: string): string {
  if (!value) return ''
  if (value.length <= 6) return '••••••'
  return value.slice(0, 3) + '•'.repeat(Math.min(value.length - 6, 20)) + value.slice(-3)
}

function getCategory(key: string): string {
  const meta = KEY_META[key]
  if (meta) return meta.category
  if (key.startsWith('fee_')) return 'Payment'
  if (key.startsWith('deposit_address_')) return 'Crypto Deposit'
  if (key.startsWith('gas_')) return 'Gas System'
  if (key.startsWith('kyc_')) return 'KYC'
  if (key.startsWith('merchant_')) return 'Merchant'
  if (key.startsWith('referral_')) return 'Referral'
  if (key.startsWith('site_')) return 'Site'
  if (key.startsWith('admin_') || key.startsWith('alert_')) return 'Notifications'
  if (key.startsWith('pkr_') || key.startsWith('payment_')) return 'Payment'
  if (key.startsWith('rate_')) return 'Rates'
  return 'Other'
}

export default function ConfigPage() {
  const { user } = useAuthStore()
  const router = useRouter()
  const [rows, setRows] = useState<ConfigRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editKey, setEditKey] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null)
  const [showSensitive, setShowSensitive] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (user && user.role !== 'super_admin') router.replace('/admin')
  }, [user, router])

  const fetchConfig = useCallback(async () => {
    setLoading(true)
    try {
      const data = await adminApi.getConfig()
      setRows(Array.isArray(data) ? data : [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load config')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchConfig() }, [fetchConfig])

  async function saveEdit(key: string) {
    setSaving(true)
    setSaveError(null)
    setSaveSuccess(null)
    try {
      const updated = await adminApi.updateConfig({ key, value: editValue })
      setRows((prev) =>
        prev.map((r) => (r.key === key ? { ...r, value: editValue, updatedAt: updated.updatedAt } : r))
      )
      setSaveSuccess(`"${key}" updated successfully.`)
      setEditKey(null)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save config')
    } finally {
      setSaving(false)
    }
  }

  if (user?.role !== 'super_admin') return null
  if (loading) return <LoadingState message="Loading configuration..." />
  if (error && rows.length === 0) return <ErrorState title={error} onRetry={fetchConfig} />

  // Group rows by category
  const grouped: Record<string, ConfigRow[]> = {}
  for (const row of rows) {
    const cat = getCategory(row.key)
    if (!grouped[cat]) grouped[cat] = []
    grouped[cat].push(row)
  }
  const categories = CATEGORY_ORDER.filter((c) => grouped[c])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Platform Configuration</h1>
        <p className="text-text-muted text-sm mt-0.5">Super admin only — edit platform settings</p>
      </div>

      {rows.length === 0 && (
        <div className="bg-surface rounded-xl border border-border px-5 py-8 text-center text-text-muted text-sm">
          No configuration entries found in the database. Settings that come from environment variables are managed in Railway.
        </div>
      )}

      {saveSuccess && (
        <div className="px-4 py-3 bg-success/10 border border-success/20 rounded-xl text-success text-sm">
          {saveSuccess}
        </div>
      )}

      {categories.map((category) => (
        <div key={category} className="bg-white rounded-xl border border-border overflow-hidden">
          <div className="px-5 py-3 bg-surface border-b border-border">
            <h2 className="text-sm font-semibold text-text-primary">{category}</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface/40">
                <tr>
                  <th className="text-left px-5 py-2.5 font-medium text-text-muted w-48">Setting</th>
                  <th className="text-left px-4 py-2.5 font-medium text-text-muted">Description</th>
                  <th className="text-left px-4 py-2.5 font-medium text-text-muted w-56">Current Value</th>
                  <th className="text-left px-4 py-2.5 font-medium text-text-muted w-36">Last Updated</th>
                  <th className="px-4 py-2.5 w-20" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {grouped[category]!.map((row) => {
                  const meta = KEY_META[row.key]
                  const sensitive = meta?.sensitive ?? isSensitive(row.key)
                  const isReadonly = meta?.readonly ?? false
                  const revealed = showSensitive[row.key]
                  const displayValue = sensitive && !revealed
                    ? maskValue(row.value)
                    : (row.value || <span className="text-text-muted italic">empty</span>)
                  const isEditing = editKey === row.key && !isReadonly

                  return (
                    <tr key={row.key} className="hover:bg-surface/30">
                      <td className="px-5 py-3 align-top">
                        <p className="font-medium text-text-primary text-xs">{meta?.label ?? row.key}</p>
                        <p className="font-mono text-xs text-text-muted mt-0.5">{row.key}</p>
                        {sensitive && (
                          <Badge variant="outline" size="sm" className="mt-1">Sensitive</Badge>
                        )}
                        {isReadonly && (
                          <Badge variant="warning" size="sm" className="mt-1">System-managed</Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top">
                        <p className="text-xs text-text-secondary">{meta?.description ?? 'No description available.'}</p>
                      </td>
                      <td className="px-4 py-3 align-top">
                        {isEditing ? (
                          <div className="space-y-1.5">
                            <input
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              placeholder={meta?.placeholder}
                              className="w-full px-2.5 py-1.5 border border-border rounded-lg text-xs font-mono text-text-primary bg-white focus:outline-none focus:ring-2 focus:ring-primary"
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') saveEdit(row.key)
                                if (e.key === 'Escape') setEditKey(null)
                              }}
                            />
                            {saveError && editKey === row.key && (
                              <p className="text-danger text-xs">{saveError}</p>
                            )}
                            <div className="flex gap-1.5">
                              <Button size="sm" loading={saving} onClick={() => saveEdit(row.key)}>Save</Button>
                              <Button size="sm" variant="secondary" onClick={() => setEditKey(null)} disabled={saving}>Cancel</Button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-xs text-text-secondary break-all">{displayValue}</span>
                            {sensitive && (
                              <button
                                onClick={() => setShowSensitive((prev) => ({ ...prev, [row.key]: !prev[row.key] }))}
                                className="text-xs text-text-muted hover:text-primary underline flex-shrink-0"
                              >
                                {revealed ? 'Hide' : 'Show'}
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top text-xs text-text-muted">
                        {fmtDateTime(row.updatedAt)}
                      </td>
                      <td className="px-4 py-3 align-top text-right">
                        {isReadonly ? (
                          <span
                            title={meta?.readonlyReason ?? 'This value is managed by the system and cannot be edited manually.'}
                            className="text-xs text-text-muted cursor-default select-none"
                          >
                            Read-only
                          </span>
                        ) : !isEditing && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setEditKey(row.key)
                              setEditValue(row.value)
                              setSaveError(null)
                              setSaveSuccess(null)
                            }}
                          >
                            Edit
                          </Button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {/* Infrastructure secrets notice */}
      <div className="bg-surface rounded-xl border border-border px-5 py-4 text-xs text-text-muted">
        <p className="font-semibold text-text-secondary text-sm mb-1">Infrastructure Secrets</p>
        <p>Private keys, wallet seeds, database credentials, and blockchain RPC keys are stored as server-side environment variables and are never exposed here. To rotate or update these secrets, use the deployment dashboard (Railway → Variables).</p>
      </div>
    </div>
  )
}
