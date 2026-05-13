'use client'
import { useState } from 'react'
import Link from 'next/link'
import { merchantsApi } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { useFileUpload } from '@/hooks/useFileUpload'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Spinner } from '@/components/ui/Spinner'

export default function MerchantApplyPage() {
  const { user } = useAuth()
  const [businessName, setBusinessName] = useState('')
  const [description, setDescription] = useState('')
  const [proofUrl, setProofUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  const { upload, uploading, error: uploadError } = useFileUpload('merchant-proof')

  const kycApproved = user?.kycStatus === 'approved'

  if (!kycApproved) {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 text-center space-y-4">
        <div className="w-16 h-16 rounded-full bg-warning/10 text-warning text-3xl flex items-center justify-center mx-auto">
          ⚠️
        </div>
        <h1 className="text-xl font-bold text-text-primary">KYC Required</h1>
        <p className="text-text-muted text-sm">
          You must complete KYC verification before applying for a merchant account.
          Your current KYC status is <strong>{user?.kycStatus ?? 'not started'}</strong>.
        </p>
        <Link href="/kyc">
          <Button className="mt-2">Complete KYC Verification</Button>
        </Link>
      </div>
    )
  }

  if (success) {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 text-center space-y-4">
        <div className="w-16 h-16 rounded-full bg-success/10 text-success text-3xl flex items-center justify-center mx-auto">
          <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h1 className="text-xl font-bold text-success">Application Submitted!</h1>
        <p className="text-text-muted text-sm">
          Your merchant application has been received. Our team will review it within 24–48 hours.
          You'll be notified via email once a decision is made.
        </p>
        <Link href="/dashboard">
          <Button variant="secondary" className="mt-2">Back to Dashboard</Button>
        </Link>
      </div>
    )
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const url = await upload(file)
      setProofUrl(url)
    } catch { /* handled by hook */ }
  }

  const handleSubmit = async () => {
    if (!businessName.trim()) { setError('Business name is required'); return }
    setSubmitting(true)
    setError('')
    try {
      await merchantsApi.apply({
        businessName: businessName.trim(),
        description: description.trim() || undefined,
        proofKey: proofUrl || undefined,
      })
      setSuccess(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit application')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-6 pb-24 lg:pb-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Apply for Merchant Account</h1>
        <p className="text-sm text-text-muted">Unlock higher limits and a verified merchant badge</p>
      </div>

      {/* Benefits */}
      <div className="bg-primary/5 border border-primary/20 rounded-xl p-5 space-y-2">
        <p className="text-sm font-semibold text-text-primary">Merchant Benefits</p>
        {[
          'Higher daily trading limits',
          'Verified Merchant badge on your profile',
          'Priority customer support',
          'Featured placement in marketplace',
        ].map((b) => (
          <div key={b} className="flex items-center gap-2">
            <div className="w-4 h-4 rounded-full bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
              <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-sm text-text-muted">{b}</p>
          </div>
        ))}
      </div>

      {/* Form */}
      <div className="bg-white border border-border rounded-xl p-5 space-y-5">
        <div>
          <label className="text-sm font-medium text-text-primary block mb-1.5">Business Name *</label>
          <Input
            placeholder="e.g. Ali Crypto Exchange"
            value={businessName}
            onChange={(e) => { setBusinessName(e.target.value); setError('') }}
          />
        </div>

        <div>
          <label className="text-sm font-medium text-text-primary block mb-1.5">Description (optional)</label>
          <textarea
            rows={3}
            placeholder="Describe your trading business, experience, and why you'd like to become a merchant..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full px-3 py-2.5 rounded-lg border border-border text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary resize-none"
          />
        </div>

        <div>
          <label className="text-sm font-medium text-text-primary block mb-1.5">
            Business Proof (optional)
          </label>
          <p className="text-xs text-text-muted mb-2">Upload a business registration, tax certificate, or other proof of your trading business.</p>
          <label className="flex flex-col items-center justify-center border-2 border-dashed border-border rounded-xl p-5 cursor-pointer hover:border-primary/50 transition-colors">
            <div className="text-text-muted text-center">
              {uploading ? (
                <><Spinner size="sm" /><p className="text-sm mt-2">Uploading...</p></>
              ) : proofUrl ? (
                <p className="text-sm text-success font-medium">Document uploaded — click to change</p>
              ) : (
                <>
                  <svg className="w-8 h-8 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  <p className="text-sm">Tap to upload document</p>
                  <p className="text-xs mt-1">JPEG, PNG, WebP — max 10MB</p>
                </>
              )}
            </div>
            <input type="file" accept="image/*" className="hidden" onChange={handleFileChange} disabled={uploading} />
          </label>
          {uploadError && <p className="text-sm text-danger mt-1">{uploadError}</p>}
        </div>
      </div>

      {error && (
        <div className="bg-danger/10 border border-danger/30 rounded-lg p-3 text-sm text-danger">{error}</div>
      )}

      <Button className="w-full" onClick={handleSubmit} disabled={submitting || uploading}>
        {submitting ? <Spinner size="sm" /> : 'Submit Application'}
      </Button>
    </div>
  )
}
