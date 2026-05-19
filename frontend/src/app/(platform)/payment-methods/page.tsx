'use client'
import { useState, useEffect, useCallback } from 'react'
import { apiRequest } from '@/lib/api'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { Badge } from '@/components/ui/Badge'
import { Spinner } from '@/components/ui/Spinner'
import { PK_BANKS } from '@/lib/pkPaymentMethods'

// ─── Types ────────────────────────────────────────────────────────────────────

interface PaymentMethod {
  id: string
  type: 'JazzCash' | 'Easypaisa' | 'Bank'
  accountTitle: string
  accountNumber: string
  bankName?: string
  createdAt: string
}

const METHOD_TYPES = ['JazzCash', 'Easypaisa', 'Bank'] as const
type MethodType = typeof METHOD_TYPES[number]

const TYPE_ICONS: Record<MethodType, string> = {
  JazzCash: 'JC',
  Easypaisa: 'EP',
  Bank: 'BK',
}

const TYPE_COLORS: Record<MethodType, string> = {
  JazzCash: 'bg-warning/10 text-warning',
  Easypaisa: 'bg-success/10 text-success',
  Bank: 'bg-primary/10 text-primary',
}

// ─── Add Method Form ─────────────────────────────────────────────────────────

interface AddFormProps {
  onSuccess: (method: PaymentMethod) => void
  onCancel: () => void
}

const inputCls = 'w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary placeholder:text-text-muted'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-sm font-medium text-text-primary block mb-1">{label}</label>
      {hint && <p className="text-xs text-text-muted mb-1.5">{hint}</p>}
      {children}
    </div>
  )
}

function AddMethodForm({ onSuccess, onCancel }: AddFormProps) {
  const [type, setType] = useState<MethodType>('JazzCash')
  // Mobile fields (JazzCash / Easypaisa)
  const [mobileName, setMobileName]     = useState('')
  const [mobileNumber, setMobileNumber] = useState('')
  // Bank fields
  const [bankName, setBankName]         = useState('')
  const [bankAccName, setBankAccName]   = useState('')
  const [bankIban, setBankIban]         = useState('')
  const [bankAccNo, setBankAccNo]       = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    setError('')
    let accountTitle = ''
    let accountNumber = ''
    let bName: string | undefined

    if (type === 'Bank') {
      if (!bankName) { setError('Please select your bank'); return }
      if (!bankAccName.trim()) { setError('Account holder name is required'); return }
      if (!bankIban.trim() && !bankAccNo.trim()) { setError('Enter your IBAN or account number'); return }
      accountTitle  = bankAccName.trim()
      accountNumber = bankIban.trim() || bankAccNo.trim()
      bName         = bankName
    } else {
      if (!mobileName.trim()) { setError('Account name is required'); return }
      if (!mobileNumber.trim()) { setError('Mobile number is required'); return }
      accountTitle  = mobileName.trim()
      accountNumber = mobileNumber.trim()
    }

    setSubmitting(true)
    try {
      const method = await apiRequest<PaymentMethod>('/wallet/payment-methods', {
        method: 'POST',
        body: JSON.stringify({ type, accountTitle, accountNumber, bankName: bName }),
      })
      onSuccess(method)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add payment method')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="bg-white border border-border rounded-xl p-5 space-y-4">
      <h2 className="text-base font-bold text-text-primary">Add Payment Method</h2>

      {/* Type selector */}
      <div>
        <label className="text-sm font-medium text-text-primary block mb-1.5">Type</label>
        <div className="flex gap-2">
          {METHOD_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => { setType(t); setError('') }}
              className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-colors ${
                type === t ? 'border-primary bg-primary/10 text-primary' : 'border-border text-text-muted hover:border-primary/40'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* JazzCash / Easypaisa fields */}
      {type !== 'Bank' && (
        <>
          <Field label="Account Name" hint="Full name registered on this account">
            <input className={inputCls} placeholder="e.g. Muhammad Fazal Elahi" value={mobileName} onChange={(e) => { setMobileName(e.target.value); setError('') }} />
          </Field>
          <Field label="Mobile Number" hint="Registered mobile number (03XXXXXXXXX)">
            <input className={inputCls} placeholder="e.g. 03001234567" value={mobileNumber} onChange={(e) => { setMobileNumber(e.target.value); setError('') }} />
          </Field>
        </>
      )}

      {/* Bank fields */}
      {type === 'Bank' && (
        <>
          <Field label="Bank" hint="Select your bank from the list">
            <select
              className={inputCls + ' cursor-pointer'}
              value={bankName}
              onChange={(e) => { setBankName(e.target.value); setError('') }}
            >
              <option value="">— Select your bank —</option>
              {PK_BANKS.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </Field>
          <Field label="Account Holder Name" hint="Full name exactly as it appears on your account">
            <input className={inputCls} placeholder="e.g. Muhammad Fazal Elahi" value={bankAccName} onChange={(e) => { setBankAccName(e.target.value); setError('') }} />
          </Field>
          <Field label="IBAN" hint="Your 24-character Pakistani IBAN (recommended)">
            <input
              className={inputCls + ' font-mono uppercase tracking-wide'}
              placeholder="PK36HABB0000123456789012"
              value={bankIban}
              maxLength={24}
              onChange={(e) => { setBankIban(e.target.value.toUpperCase()); setError('') }}
            />
          </Field>
          <Field label="Account Number" hint="Optional if IBAN provided above">
            <input className={inputCls + ' font-mono'} placeholder="e.g. 01234567890101" value={bankAccNo} onChange={(e) => { setBankAccNo(e.target.value); setError('') }} />
          </Field>
        </>
      )}

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
      const res = await apiRequest<{ paymentMethods: PaymentMethod[] }>('/wallet/payment-methods')
      setMethods(res.paymentMethods)
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
    <div className="max-w-lg mx-auto px-4 py-6 pb-24 lg:pb-6 space-y-5">
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
          description="Add a JazzCash, Easypaisa, or bank account to start trading."
          action={{ label: 'Add Payment Method', onClick: () => setShowAddForm(true) }}
        />
      ) : (
        <div className="space-y-3">
          {methods.map((method) => (
            <div key={method.id} className="bg-white border border-border rounded-xl p-4 flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${TYPE_COLORS[method.type] ?? 'bg-surface text-text-muted'}`}>
                  {TYPE_ICONS[method.type] ?? method.type.slice(0, 2)}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-text-primary">{method.accountTitle}</p>
                    <Badge variant="default" size="sm">{method.type}</Badge>
                  </div>
                  <p className="text-sm text-text-muted font-mono mt-0.5">{method.accountNumber}</p>
                  {method.bankName && <p className="text-xs text-text-muted">{method.bankName}</p>}
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
          description={`Remove ${deleteTarget.type} account "${deleteTarget.accountTitle}" (${deleteTarget.accountNumber})? You can always add it back later.`}
          confirmLabel="Remove"
          cancelLabel="Cancel"
          onConfirm={handleDelete}
          confirmVariant="danger"
        />
      )}
    </div>
  )
}
