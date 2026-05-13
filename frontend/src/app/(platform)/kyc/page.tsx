'use client'
import { useState, useEffect, useCallback } from 'react'
import { kycApi } from '@/lib/api'
import type { KycDocument } from '@/lib/api'
import { useFileUpload } from '@/hooks/useFileUpload'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'

// ─── Types ────────────────────────────────────────────────────────────────────

type KycTier = 'basic' | 'enhanced'

interface SocialLink {
  platform: string
  url: string
}

type UIState = 'loading' | 'error' | 'none' | 'selecting' | 'submitting' | 'pending' | 'approved' | 'rejected'

const SOCIAL_PLATFORMS = ['Facebook', 'Twitter/X', 'LinkedIn', 'Instagram', 'WhatsApp', 'Telegram']

// ─── Tier card ────────────────────────────────────────────────────────────────

function TierCard({
  tier, onSelect,
}: {
  tier: KycTier
  onSelect: () => void
}) {
  const isBasic = tier === 'basic'
  return (
    <div
      className={`bg-white rounded-xl border-2 p-6 cursor-pointer hover:border-primary transition-colors ${
        isBasic ? 'border-border' : 'border-primary/30'
      }`}
      onClick={onSelect}
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-bold text-text-primary">{isBasic ? 'Basic KYC' : 'Enhanced KYC'}</h3>
        <Badge variant={isBasic ? 'default' : 'gold'} size="sm">
          {isBasic ? 'Level 1' : 'Level 2'}
        </Badge>
      </div>
      <ul className="text-sm text-text-secondary space-y-2 mb-4">
        {isBasic ? (
          <>
            <li className="flex gap-2"><span className="text-success">✓</span> CNIC Front &amp; Back photos</li>
            <li className="flex gap-2"><span className="text-success">✓</span> Selfie with CNIC</li>
            <li className="flex gap-2"><span className="text-success">✓</span> Daily limit: PKR 50,000</li>
          </>
        ) : (
          <>
            <li className="flex gap-2"><span className="text-success">✓</span> Everything in Basic</li>
            <li className="flex gap-2"><span className="text-success">✓</span> 2+ social media profiles</li>
            <li className="flex gap-2"><span className="text-success">✓</span> Daily limit: PKR 200,000</li>
            <li className="flex gap-2"><span className="text-success">✓</span> Merchant eligibility</li>
          </>
        )}
      </ul>
      <Button fullWidth variant={isBasic ? 'secondary' : 'primary'} onClick={onSelect}>
        Select {isBasic ? 'Basic' : 'Enhanced'}
      </Button>
    </div>
  )
}

// ─── File upload field ────────────────────────────────────────────────────────

function FileUploadField({
  label, hint, uploadType, onUploaded,
}: {
  label: string
  hint: string
  uploadType: 'kyc-front' | 'kyc-back' | 'kyc-selfie'
  onUploaded: (url: string) => void
}) {
  const { upload, uploading, error } = useFileUpload(uploadType)
  const [preview, setPreview] = useState<string | null>(null)

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setPreview(URL.createObjectURL(file))
    try {
      const url = await upload(file)
      onUploaded(url)
    } catch { /* error shown below */ }
  }

  return (
    <div>
      <label className="block text-sm font-medium text-text-primary mb-1">{label}</label>
      <p className="text-xs text-text-muted mb-2">{hint}</p>
      <label className={`block w-full border-2 border-dashed rounded-xl p-4 cursor-pointer text-center transition-colors ${
        preview ? 'border-success/40 bg-success/5' : 'border-border hover:border-primary/40 bg-surface'
      }`}>
        {uploading ? (
          <div className="flex flex-col items-center gap-2 py-4">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-text-muted">Uploading...</span>
          </div>
        ) : preview ? (
          <div className="space-y-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview} alt="Preview" className="h-24 object-cover rounded-lg mx-auto" />
            <p className="text-xs text-success font-medium">Uploaded</p>
          </div>
        ) : (
          <div className="py-4">
            <svg className="w-8 h-8 text-text-muted mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
            <p className="text-xs text-text-muted">Tap to upload (JPEG / PNG / WebP, max 10 MB)</p>
          </div>
        )}
        <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleChange} />
      </label>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function KycPage() {
  const [uiState, setUiState] = useState<UIState>('loading')
  const [kycStatus, setKycStatus] = useState<string>('none')
  const [kycLevel, setKycLevel] = useState<string>('none')
  const [documents, setDocuments] = useState<KycDocument[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  const [selectedTier, setSelectedTier] = useState<KycTier | null>(null)

  // Form state
  const [cnicNumber, setCnicNumber] = useState('')
  const [frontUrl, setFrontUrl] = useState('')
  const [backUrl, setBackUrl] = useState('')
  const [selfieUrl, setSelfieUrl] = useState('')
  const [socialLinks, setSocialLinks] = useState<SocialLink[]>([{ platform: 'Facebook', url: '' }])
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await kycApi.getStatus()
      setKycStatus(res.status)
      setKycLevel(res.level)
      setDocuments(res.documents)

      if (res.status === 'none' || res.status === '') setUiState('none')
      else if (res.status === 'pending') setUiState('pending')
      else if (res.status === 'approved') setUiState('approved')
      else if (res.status === 'rejected') setUiState('rejected')
      else setUiState('none')
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load KYC status')
      setUiState('error')
    }
  }, [])

  useEffect(() => { fetchStatus() }, [fetchStatus])

  const handleSelectTier = (tier: KycTier) => {
    setSelectedTier(tier)
    setUiState('submitting')
    setSubmitError(null)
  }

  const handleBack = () => {
    setSelectedTier(null)
    setUiState('none')
    setSubmitError(null)
  }

  const addSocialLink = () => {
    if (socialLinks.length >= 3) return
    setSocialLinks((prev) => [...prev, { platform: 'Twitter/X', url: '' }])
  }

  const removeSocialLink = (i: number) => {
    setSocialLinks((prev) => prev.filter((_, idx) => idx !== i))
  }

  const updateSocialLink = (i: number, field: keyof SocialLink, value: string) => {
    setSocialLinks((prev) => prev.map((l, idx) => idx === i ? { ...l, [field]: value } : l))
  }

  const handleSubmit = async () => {
    if (!frontUrl || !backUrl || !selfieUrl || !cnicNumber) {
      setSubmitError('Please fill all required fields and upload all documents.')
      return
    }
    if (selectedTier === 'enhanced') {
      const validLinks = socialLinks.filter((l) => l.url.trim())
      if (validLinks.length < 2) {
        setSubmitError('Enhanced KYC requires at least 2 social media profiles.')
        return
      }
    }

    setSubmitting(true)
    setSubmitError(null)
    try {
      if (selectedTier === 'basic') {
        await kycApi.submitBasic({
          documentType: 'cnic',
          frontKey: frontUrl,
          backKey: backUrl,
        })
      } else {
        await kycApi.submitEnhanced({ selfieKey: selfieUrl })
      }
      await fetchStatus()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Submission failed')
    } finally {
      setSubmitting(false)
    }
  }

  const lastDoc = documents.at(-1)

  if (uiState === 'loading') return <LoadingState message="Loading KYC status..." />
  if (uiState === 'error') return <ErrorState title={loadError ?? 'Error'} onRetry={fetchStatus} />

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 pb-24 lg:pb-8">
      <h1 className="text-2xl font-bold text-text-primary mb-2">KYC Verification</h1>
      <p className="text-sm text-text-muted mb-6">Complete identity verification to increase your trading limits.</p>

      {/* ── Approved ── */}
      {uiState === 'approved' && (
        <div className="bg-success/10 border border-success/20 rounded-xl p-6 text-center space-y-3">
          <div className="w-14 h-14 bg-success/20 rounded-full flex items-center justify-center mx-auto text-2xl">✓</div>
          <h2 className="text-lg font-bold text-success">KYC Approved</h2>
          <Badge variant="success">
            {kycLevel.charAt(0).toUpperCase() + kycLevel.slice(1)} KYC
          </Badge>
          <p className="text-sm text-text-secondary">
            Your identity has been verified. Enjoy increased trading limits.
          </p>
        </div>
      )}

      {/* ── Pending ── */}
      {uiState === 'pending' && (
        <div className="bg-warning/10 border border-warning/20 rounded-xl p-6 text-center space-y-3">
          <div className="w-14 h-14 bg-warning/20 rounded-full flex items-center justify-center mx-auto text-2xl">⏳</div>
          <h2 className="text-lg font-bold text-warning">Under Review</h2>
          <p className="text-sm text-text-secondary">
            Your documents are being reviewed. This usually takes 1-2 business days.
          </p>
          {lastDoc && (
            <p className="text-xs text-text-muted">
              Submitted {new Date(lastDoc.createdAt).toLocaleDateString()}
            </p>
          )}
        </div>
      )}

      {/* ── Rejected ── */}
      {uiState === 'rejected' && (
        <div className="bg-danger/10 border border-danger/20 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-danger/20 rounded-full flex items-center justify-center text-danger text-lg">✗</div>
            <div>
              <h2 className="text-base font-bold text-danger">Verification Rejected</h2>
              {lastDoc?.notes && <p className="text-sm text-text-secondary mt-0.5">{lastDoc.notes}</p>}
            </div>
          </div>
          <Button onClick={() => { setUiState('none'); setSubmitError(null) }}>
            Resubmit Verification
          </Button>
        </div>
      )}

      {/* ── Tier selector ── */}
      {uiState === 'none' && (
        <div className="space-y-4">
          <h2 className="text-base font-semibold text-text-primary">Choose Verification Level</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            <TierCard tier="basic" onSelect={() => handleSelectTier('basic')} />
            <TierCard tier="enhanced" onSelect={() => handleSelectTier('enhanced')} />
          </div>
        </div>
      )}

      {/* ── Submission form ── */}
      {uiState === 'submitting' && selectedTier && (
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            <button onClick={handleBack} className="p-1.5 rounded-lg hover:bg-surface text-text-muted hover:text-text-primary transition-colors">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h2 className="text-base font-semibold text-text-primary">
              {selectedTier === 'basic' ? 'Basic' : 'Enhanced'} KYC Submission
            </h2>
          </div>

          {/* CNIC Number */}
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">CNIC Number</label>
            <input
              type="text"
              value={cnicNumber}
              onChange={(e) => setCnicNumber(e.target.value)}
              placeholder="XXXXX-XXXXXXX-X"
              maxLength={15}
              className="w-full px-4 py-3 border border-border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <p className="text-xs text-text-muted mt-1">Your CNIC number will be securely hashed on our servers.</p>
          </div>

          {/* Document uploads */}
          <FileUploadField
            label="CNIC Front"
            hint="Clear photo of the front side of your CNIC"
            uploadType="kyc-front"
            onUploaded={setFrontUrl}
          />

          <FileUploadField
            label="CNIC Back"
            hint="Clear photo of the back side of your CNIC"
            uploadType="kyc-back"
            onUploaded={setBackUrl}
          />

          <FileUploadField
            label="Selfie with CNIC"
            hint="Hold your CNIC next to your face, clearly showing both"
            uploadType="kyc-selfie"
            onUploaded={setSelfieUrl}
          />

          {/* Enhanced: social links */}
          {selectedTier === 'enhanced' && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-text-primary">Social Media Profiles (min 2)</label>
                {socialLinks.length < 3 && (
                  <Button size="sm" variant="ghost" onClick={addSocialLink}>+ Add</Button>
                )}
              </div>
              <div className="space-y-3">
                {socialLinks.map((link, i) => (
                  <div key={i} className="flex gap-2">
                    <select
                      value={link.platform}
                      onChange={(e) => updateSocialLink(i, 'platform', e.target.value)}
                      className="w-36 px-2 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary"
                    >
                      {SOCIAL_PLATFORMS.map((p) => <option key={p}>{p}</option>)}
                    </select>
                    <input
                      type="url"
                      value={link.url}
                      onChange={(e) => updateSocialLink(i, 'url', e.target.value)}
                      placeholder="https://..."
                      className="flex-1 px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                    {socialLinks.length > 1 && (
                      <button
                        onClick={() => removeSocialLink(i)}
                        className="p-2 text-text-muted hover:text-danger rounded-lg hover:bg-danger/10 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Progress indicators */}
          <div className="bg-surface rounded-lg p-4">
            <p className="text-xs font-medium text-text-muted mb-3">Submission Checklist</p>
            <div className="space-y-2">
              {[
                { label: 'CNIC number entered', done: !!cnicNumber },
                { label: 'CNIC front uploaded', done: !!frontUrl },
                { label: 'CNIC back uploaded', done: !!backUrl },
                { label: 'Selfie uploaded', done: !!selfieUrl },
                ...(selectedTier === 'enhanced' ? [
                  { label: 'At least 2 social links', done: socialLinks.filter((l) => l.url.trim()).length >= 2 },
                ] : []),
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className={`w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 ${item.done ? 'bg-success text-white' : 'border border-border'}`}>
                    {item.done && (
                      <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                  <span className={`text-xs ${item.done ? 'text-success' : 'text-text-muted'}`}>{item.label}</span>
                </div>
              ))}
            </div>
          </div>

          {submitError && (
            <div className="bg-danger/10 border border-danger/20 rounded-lg px-4 py-3 text-sm text-danger">
              {submitError}
            </div>
          )}

          <Button fullWidth size="lg" loading={submitting} onClick={handleSubmit}>
            Submit for Review
          </Button>
        </div>
      )}
    </div>
  )
}
