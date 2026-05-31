'use client'
import { useState, useEffect, useCallback } from 'react'
import { apiRequest } from '@/lib/api'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { CreditCard } from 'lucide-react'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { Spinner } from '@/components/ui/Spinner'
import { PK_BANKS } from '@/lib/pkPaymentMethods'
import { EntityLogo } from '@/components/ui/EntityLogo'

// ─── Types ────────────────────────────────────────────────────────────────────

type MobileType = 'jazzcash' | 'easypaisa' | 'sadapay' | 'nayapay'
type MethodType = MobileType | 'bank_transfer'

interface PaymentMethod {
  id: string
  type: MethodType
  displayName: string
  accountName: string
  mobileNumber?: string
  bankName?: string
  ibanNumber?: string
  accountNumber?: string
  createdAt: string
}

const MOBILE_METHODS: { value: MobileType; label: string }[] = [
  { value: 'jazzcash',  label: 'JazzCash'  },
  { value: 'easypaisa', label: 'Easypaisa' },
  { value: 'sadapay',   label: 'SadaPay'   },
  { value: 'nayapay',   label: 'NayaPay'   },
]

const TYPE_LABELS: Record<MethodType, string> = {
  jazzcash:     'JazzCash',
  easypaisa:    'Easypaisa',
  sadapay:      'SadaPay',
  nayapay:      'NayaPay',
  bank_transfer: 'Bank Transfer',
}

const TYPE_ICONS: Record<MethodType, string> = {
  jazzcash:     'JC',
  easypaisa:    'EP',
  sadapay:      'SP',
  nayapay:      'NP',
  bank_transfer: 'BK',
}

const TYPE_COLORS: Record<MethodType, string> = {
  jazzcash:     'bg-orange-100 text-orange-700',
  easypaisa:    'bg-green-100 text-green-700',
  sadapay:      'bg-teal-100 text-teal-700',
  nayapay:      'bg-indigo-100 text-indigo-700',
  bank_transfer: 'bg-primary/10 text-primary',
}

// ─── Add Method Form ─────────────────────────────────────────────────────────

const inputCls = 'w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary placeholder:text-text-muted'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-sm font-medium text-text-primary block mb-1">{label}</label>
      {hint && <p className="text-xs text-text-muted mb-1.5">{hint}</p>}
      {children}
    </div>
  )
}

function AddMethodForm({ onSuccess, onCancel }: { onSuccess: (m: PaymentMethod) => void; onCancel: () => void }) {
  const [type, setType] = useState<MethodType>('jazzcash')
  const [accountName, setAccountName] = useState('')
  const [mobileNumber, setMobileNumber] = useState('')
  const [bankName, setBankName] = useState('')
  const [ibanNumber, setIbanNumber] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const isMobile = type !== 'bank_transfer'

  const handleSubmit = async () => {
    setError('')
    if (!accountName.trim()) { setError('Account holder name is required'); return }
    if (isMobile && !mobileNumber.trim()) { setError('Mobile number is required'); return }
    if (!isMobile) {
      if (!bankName) { setError('Please select your bank'); return }
      if (!ibanNumber.trim() && !accountNumber.trim()) { setError('Enter your IBAN or account number'); return }
    }

    const displayName = isMobile
      ? `${TYPE_LABELS[type]} — ${mobileNumber.trim()}`
      : `${bankName} — ${accountName.trim()}`

    setSubmitting(true)
    try {
      const method = await apiRequest<PaymentMethod>('/wallet/payment-methods', {
        method: 'POST',
        body: JSON.stringify({
          type,
          displayName,
          accountName: accountName.trim(),
          ...(isMobile ? { mobileNumber: mobileNumber.trim() } : {}),
          ...(!isMobile ? { bankName, ibanNumber: ibanNumber.trim() || undefined, accountNumber: accountNumber.trim() || undefined } : {}),
        }),
      })
      onSuccess(method)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add payment method')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="bg-surface shadow-card border border-border rounded-xl p-5 space-y-4">
      <h2 className="text-base font-bold text-text-primary">Add Payment Method</h2>

      {/* Mobile wallets */}
      <div>
        <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">Mobile Wallets</p>
        <div className="flex flex-wrap gap-2">
          {MOBILE_METHODS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => { setType(value); setError('') }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${
                type === value
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-text-muted hover:border-primary/40'
              }`}
            >
              <EntityLogo type="payment_method" slug={label} size="xs" className="flex-shrink-0" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Bank transfer */}
      <div>
        <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">Bank Transfer</p>
        <button
          onClick={() => { setType('bank_transfer'); setError('') }}
          className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${
            type === 'bank_transfer'
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border text-text-muted hover:border-primary/40'
          }`}
        >
          Bank Account
        </button>
      </div>

      <div className="border-t border-border pt-4 space-y-3">
        {/* Mobile wallet fields */}
        {isMobile && (
          <>
            <Field label="Account Holder Name" hint="Full name registered on this account">
              <input className={inputCls} placeholder="e.g. Muhammad Fazal Elahi" value={accountName}
                onChange={(e) => { setAccountName(e.target.value); setError('') }} />
            </Field>
            <Field label="Account / Payment Number" hint="Registered mobile number (03XXXXXXXXX)">
              <input className={inputCls} placeholder="e.g. 03001234567" value={mobileNumber}
                onChange={(e) => { setMobileNumber(e.target.value); setError('') }} />
            </Field>
          </>
        )}

        {/* Bank fields */}
        {!isMobile && (
          <>
            <Field label="Bank" hint="Select your bank">
              <select className={inputCls + ' cursor-pointer'} value={bankName}
                onChange={(e) => { setBankName(e.target.value); setError('') }}>
                <option value="">— Select your bank —</option>
                {PK_BANKS.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </Field>
            <Field label="Account Holder Name" hint="Full name exactly as it appears on your account">
              <input className={inputCls} placeholder="e.g. Muhammad Fazal Elahi" value={accountName}
                onChange={(e) => { setAccountName(e.target.value); setError('') }} />
            </Field>
            <Field label="IBAN" hint="Your 24-character Pakistani IBAN (recommended)">
              <input className={inputCls + ' font-mono uppercase tracking-wide'} placeholder="PK36HABB0000123456789012"
                value={ibanNumber} maxLength={24}
                onChange={(e) => { setIbanNumber(e.target.value.toUpperCase()); setError('') }} />
            </Field>
            <Field label="Account Number" hint="Optional if IBAN provided above">
              <input className={inputCls + ' font-mono'} placeholder="e.g. 01234567890101"
                value={accountNumber}
                onChange={(e) => { setAccountNumber(e.target.value); setError('') }} />
            </Field>
          </>
        )}
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="flex gap-3">
        <Button variant="secondary" className="flex-1" onClick={onCancel} disabled={submitting}>Cancel</Button>
        <Button className="flex-1" onClick={handleSubmit} disabled={submitting}>
          {submitting ? <Spinner size="sm" /> : 'Add Method'}
        </Button>
      </div>
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function PaymentMethodsPage() {
  const [methods, setMethods] = useState<PaymentMethod[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showAddForm, setShowAddForm] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<PaymentMethod | null>(null)
  const [deleting, setDeleting] = useState(false)

  const fetchMethods = useCallback(async () => {
    try {
      const res = await apiRequest<PaymentMethod[]>('/wallet/payment-methods')
      setMethods(Array.isArray(res) ? res : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load payment methods')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchMethods() }, [fetchMethods])

  const handleAddSuccess = (method: PaymentMethod) => {
    setMethods((prev) => [...prev, method])
    setShowAddForm(false)
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await apiRequest(`/wallet/payment-methods/${deleteTarget.id}`, { method: 'DELETE' })
      setMethods((prev) => prev.filter((m) => m.id !== deleteTarget.id))
      setDeleteTarget(null)
    } catch { /* silent */ } finally {
      setDeleting(false)
    }
  }

  if (loading) return <LoadingState message="Loading payment methods..." />
  if (error) return <ErrorState title={error} onRetry={fetchMethods} />

  return (
    <div className="max-w-lg mx-auto px-4 py-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Payment Methods</h1>
          <p className="text-sm text-text-muted">Manage your payment accounts for trading</p>
        </div>
        {!showAddForm && (
          <Button size="sm" onClick={() => setShowAddForm(true)}>+ Add</Button>
        )}
      </div>

      {showAddForm && (
        <AddMethodForm
          onSuccess={handleAddSuccess}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {methods.length === 0 && !showAddForm ? (
        <EmptyState
          title="No payment methods"
          description="Add JazzCash, Easypaisa, SadaPay, NayaPay, or a bank account to start trading."
          icon={CreditCard}
          action={{ label: 'Add Payment Method', onClick: () => setShowAddForm(true) }}
        />
      ) : (
        <div className="space-y-3">
          {methods.map((method) => (
            <div key={method.id} className="bg-surface shadow-card border border-border rounded-xl p-4 flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <EntityLogo
                  type={method.type === 'bank_transfer' ? 'bank' : 'payment_method'}
                  slug={method.type === 'bank_transfer' ? (method.bankName ?? 'bank') : TYPE_LABELS[method.type]}
                  size="md"
                  className="flex-shrink-0"
                />
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold text-text-primary">{method.accountName}</p>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${TYPE_COLORS[method.type] ?? 'bg-surface text-text-muted'}`}>
                      {TYPE_LABELS[method.type] ?? method.type}
                    </span>
                  </div>
                  {method.mobileNumber && (
                    <p className="text-sm text-text-muted font-mono mt-0.5">{method.mobileNumber}</p>
                  )}
                  {method.bankName && (
                    <p className="text-xs text-text-muted">{method.bankName}</p>
                  )}
                  {(method.ibanNumber || method.accountNumber) && (
                    <p className="text-sm text-text-muted font-mono mt-0.5">
                      {method.ibanNumber || method.accountNumber}
                    </p>
                  )}
                </div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                className="text-danger hover:bg-danger/10 flex-shrink-0"
                onClick={() => setDeleteTarget(method)}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="bg-surface border border-border rounded-xl p-4 text-sm text-text-muted">
        <p className="font-medium text-text-primary mb-1">Security Note</p>
        <p>Your payment details are only shared with your trade counterparty during active trades.</p>
      </div>

      {deleteTarget && (
        <ConfirmModal
          isOpen={!!deleteTarget}
          onClose={() => setDeleteTarget(null)}
          title="Remove Payment Method"
          description={`Remove this ${TYPE_LABELS[deleteTarget.type] ?? deleteTarget.type} account? You can always add it back later.`}
          confirmLabel={deleting ? 'Removing…' : 'Remove'}
          cancelLabel="Cancel"
          onConfirm={handleDelete}
          confirmVariant="danger"
        />
      )}
    </div>
  )
}
