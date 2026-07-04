'use client'
import { useState, useEffect, useCallback } from 'react'
import { kycApi, marketplaceApi } from '@/lib/api'
import type { KycDocument } from '@/lib/api'
import { analytics } from '@/lib/analytics'
import { useFileUpload } from '@/hooks/useFileUpload'
import { usePolling } from '@/hooks/usePolling'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Clock, ShieldCheck, ShieldPlus } from 'lucide-react'
import { TraderLevelCard } from '@/components/ui/TraderLevelCard'
import Link from 'next/link'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatCnic(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 13)
  if (digits.length <= 5) return digits
  if (digits.length <= 12) return `${digits.slice(0, 5)}-${digits.slice(5)}`
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`
}

function isValidCnic(cnic: string): boolean {
  return /^\d{5}-\d{7}-\d$/.test(cnic)
}

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

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
      className={`bg-surface shadow-card rounded-xl border-2 p-6 cursor-pointer hover:border-primary transition-colors ${
        isBasic ? 'border-border' : 'border-primary/30'
      }`}
      onClick={onSelect}
    >
      <div className="flex items-center justify-between mb-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isBasic ? 'bg-blue-500/10' : 'bg-amber-500/10'}`}>
          {isBasic
            ? <ShieldCheck size={20} className="text-blue-500" aria-hidden />
            : <ShieldPlus size={20} className="text-amber-500" aria-hidden />
          }
        </div>
        <Badge variant={isBasic ? 'default' : 'gold'} size="sm">
          {isBasic ? 'Level 1' : 'Level 2'}
        </Badge>
      </div>
      <h3 className="text-base font-bold text-text-primary mb-3">{isBasic ? 'Basic KYC' : 'Enhanced KYC'}</h3>
      <ul className="text-sm text-text-secondary space-y-2 mb-4">
        {isBasic ? (
          <>
            <li className="flex gap-2"><span className="text-success">✓</span> CNIC Front &amp; Back photos</li>
            <li className="flex gap-2"><span className="text-success">✓</span> Simple selfie</li>
            <li className="flex gap-2"><span className="text-success">✓</span> Unlocks trading, wallet, ads, CTM &amp; gas</li>
            <li className="flex gap-2"><span className="text-success">✓</span> Daily limit: PKR 50,000</li>
          </>
        ) : (
          <>
            <li className="flex gap-2"><span className="text-success">✓</span> Everything in Basic</li>
            <li className="flex gap-2"><span className="text-success">✓</span> 2+ social media profiles</li>
            <li className="flex gap-2"><span className="text-success">✓</span> Short video verification</li>
            <li className="flex gap-2"><span className="text-success">✓</span> Daily limit: PKR 200,000</li>
            <li className="flex gap-2"><span className="text-success">✓</span> Higher trust score + faster badge progression</li>
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
  uploadType: 'kyc-front' | 'kyc-back' | 'kyc-selfie' | 'kyc-video'
  onUploaded: (url: string) => void
}) {
  const isVideo = uploadType === 'kyc-video'
  const maxBytes = isVideo ? 50 * 1024 * 1024 : MAX_FILE_SIZE
  const maxLabel = isVideo ? '50 MB' : '10 MB'
  const { upload, uploading, error } = useFileUpload(uploadType)
  const [preview, setPreview] = useState<string | null>(null)
  const [uploaded, setUploaded] = useState(false)
  const [lastFile, setLastFile] = useState<File | null>(null)
  const [sizeError, setSizeError] = useState<string | null>(null)

  const doUpload = async (file: File) => {
    setUploaded(false)
    try {
      const url = await upload(file)
      onUploaded(url)
      setUploaded(true)
    } catch { /* error shown below */ }
  }

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > maxBytes) {
      setPreview(null)
      setUploaded(false)
      e.target.value = ''
      setSizeError(`File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max ${maxLabel}.`)
      return
    }
    setSizeError(null)
    setPreview(URL.createObjectURL(file))
    setLastFile(file)
    await doUpload(file)
  }

  const handleRetry = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (lastFile) await doUpload(lastFile)
  }

  const borderClass = uploaded
    ? 'border-success/40 bg-success/5'
    : (error || sizeError)
    ? 'border-danger/40 bg-danger/5'
    : preview
    ? 'border-primary/40 bg-primary/5'
    : 'border-border hover:border-primary/40 bg-surface'

  return (
    <div>
      <label className="block text-sm font-medium text-text-primary mb-1">{label}</label>
      <p className="text-xs text-text-muted mb-2">{hint}</p>
      <label className={`block w-full border-2 border-dashed rounded-xl p-4 cursor-pointer text-center transition-colors ${borderClass}`}>
        {uploading ? (
          <div className="flex flex-col items-center gap-2 py-4">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-text-muted">Uploading...</span>
          </div>
        ) : preview ? (
          <div className="space-y-2">
            {isVideo ? (
              <video src={preview} className="h-24 rounded-lg mx-auto" controls />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="Preview" className="h-24 object-cover rounded-lg mx-auto" />
            )}
            {uploaded ? (
              <p className="text-xs text-success font-medium">Uploaded — pending admin review</p>
            ) : error ? (
              <p className="text-xs text-danger font-medium">Upload failed — tap to choose a different file</p>
            ) : (
              <p className="text-xs text-text-muted font-medium">Preview selected</p>
            )}
          </div>
        ) : (
          <div className="py-4">
            <svg className="w-8 h-8 text-text-muted mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
            <p className="text-xs text-text-muted">{isVideo ? 'Tap to upload (MP4 / MOV / WebM, max 50 MB)' : 'Tap to upload (JPEG / PNG / WebP, max 10 MB)'}</p>
          </div>
        )}
        <input type="file" accept={isVideo ? 'video/mp4,video/quicktime,video/webm' : 'image/jpeg,image/png,image/webp'} className="hidden" onChange={handleChange} />
      </label>
      {(sizeError || error) && (
        <div className="mt-1 flex items-center justify-between gap-2">
          <p className="text-xs text-danger">{sizeError ?? error}</p>
          {!sizeError && lastFile && (
            <button
              type="button"
              onClick={handleRetry}
              className="text-xs font-medium text-primary hover:underline"
              disabled={uploading}
            >
              Retry upload
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function KycPage() {
  const { user } = useAuth()
  const [uiState, setUiState] = useState<UIState>('loading')
  const [kycStatus, setKycStatus] = useState<string>('none')
  const [kycLevel, setKycLevel] = useState<string>('none')
  const [latestSubmission, setLatestSubmission] = useState<KycDocument | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Non-custodial mode gates the new Level-1 requirements (legal name + social).
  // When OFF, the form looks/behaves exactly as before.
  const [nonCustodial, setNonCustodial] = useState(false)

  const [selectedTier, setSelectedTier] = useState<KycTier | null>(null)

  // Form state
  const [cnicNumber, setCnicNumber] = useState('')
  const [legalName, setLegalName] = useState('')
  const [frontUrl, setFrontUrl] = useState('')
  const [backUrl, setBackUrl] = useState('')
  const [selfieUrl, setSelfieUrl] = useState('')
  const [videoUrl, setVideoUrl] = useState('')
  // Show three social-profile fields by default for Enhanced KYC (min 2 required).
  const [socialLinks, setSocialLinks] = useState<SocialLink[]>([
    { platform: 'Facebook', url: '' },
    { platform: 'Instagram', url: '' },
    { platform: 'Twitter/X', url: '' },
  ])
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await kycApi.getStatus()
      setKycStatus(res.status ?? 'none')
      setKycLevel(res.level ?? 'none')
      setLatestSubmission(res.latestSubmission)

      const s = res.status ?? 'none'
      if (!s || s === 'none' || s === '') setUiState('none')
      else if (s === 'pending') setUiState('pending')
      else if (s === 'approved') setUiState('approved')
      else if (s === 'rejected') setUiState('rejected')
      else setUiState('none')
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load KYC status')
      setUiState('error')
    }
  }, [])

  useEffect(() => { fetchStatus() }, [fetchStatus])

  useEffect(() => {
    marketplaceApi.getConfig()
      .then((c) => setNonCustodial(!!(c as { nonCustodialP2p?: boolean }).nonCustodialP2p))
      .catch(() => {})
  }, [])

  // Poll every 20s while pending so the approved state appears without a manual refresh
  usePolling(fetchStatus, 20000, uiState === 'pending')

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
    if (!selectedTier) {
      setSubmitError('Please select a KYC tier.')
      return
    }
    if (selectedTier === 'basic') {
      // Level 1 collects CNIC details + document photos.
      if (!frontUrl || !backUrl || !selfieUrl || !cnicNumber) {
        setSubmitError('Please fill all required fields and upload all documents.')
        return
      }
      if (nonCustodial && legalName.trim().length < 3) {
        setSubmitError('Enter your full name exactly as printed on your CNIC.')
        return
      }
      if (!isValidCnic(cnicNumber)) {
        setSubmitError('CNIC format must be XXXXX-XXXXXXX-X (e.g. 42201-1234567-8).')
        return
      }
      if (nonCustodial && socialLinks.filter((l) => l.url.trim()).length < 1) {
        setSubmitError('Add at least one social profile (Facebook or Instagram preferred).')
        return
      }
    } else {
      // Level 2 reuses approved Level 1 identity docs — only video + socials.
      const validLinks = socialLinks.filter((l) => l.url.trim())
      if (validLinks.length < 2) {
        setSubmitError('Enhanced KYC requires at least 2 social media profiles.')
        return
      }
      if (!videoUrl) {
        setSubmitError('Enhanced KYC requires a short verification video.')
        return
      }
    }

    setSubmitting(true)
    setSubmitError(null)
    try {
      const validLinks = socialLinks.filter((l) => l.url.trim())
      await kycApi.submit({
        tier: selectedTier,
        // Level 1 only — Level 2 reuses the already-approved identity documents.
        ...(selectedTier === 'basic'
          ? { cnicNumber, ...(legalName.trim() ? { legalName: legalName.trim() } : {}), frontUrl, backUrl, selfieUrl }
          : {}),
        ...(selectedTier === 'enhanced' && videoUrl ? { videoUrl } : {}),
        ...(validLinks.length > 0 ? { socialLinks: validLinks } : {}),
      })
      analytics.kycSubmitted({ level: selectedTier })
      await fetchStatus()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Submission failed')
    } finally {
      setSubmitting(false)
    }
  }

  const lastDoc = latestSubmission

  if (uiState === 'loading') return <LoadingState message="Loading KYC status..." />
  if (uiState === 'error') return <ErrorState title={loadError ?? 'Error'} onRetry={fetchStatus} />

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
      <h1 className="text-2xl font-bold text-text-primary mb-2">KYC Verification</h1>
      <p className="text-sm text-text-muted mb-6">Complete identity verification to unlock trading, wallet, ads, and all platform features.</p>

      {/* ── Approved ── */}
      {/* ── Approved ── */}
      {uiState === 'approved' && (
        <div className="space-y-4">
          {/* Status banner */}
          <div className="bg-success/10 border border-success/20 rounded-xl p-6 text-center space-y-3">
            <div className="w-14 h-14 bg-success/20 rounded-full flex items-center justify-center mx-auto text-2xl">✓</div>
            <h2 className="text-lg font-bold text-success">
              {kycLevel === 'enhanced' ? 'Level 2 Verified' : 'Level 1 Verified'}
            </h2>
            <Badge variant={kycLevel === 'enhanced' ? 'gold' : 'success'}>
              {kycLevel === 'enhanced' ? 'Enhanced KYC' : 'Basic KYC'}
            </Badge>
            <p className="text-sm text-text-secondary">
              {kycLevel === 'enhanced'
                ? 'Full verification complete. You have access to all platform features and higher limits.'
                : 'Identity verified. You have full access to all platform features.'}
            </p>
          </div>

          {/* Trader progress card */}
          <TraderLevelCard
            badge={user?.tradeStats?.badge ?? 'new'}
            badgeLabel={user?.tradeStats?.badgeLabel}
            trustScore={user?.tradeStats?.trustScore ?? 0}
            completedTrades={user?.tradeStats?.completedTrades ?? 0}
            completionRate={user?.tradeStats?.completionRate ?? 0}
            kycStatus={kycStatus}
          />

          {/* Level 2 upgrade CTA — only shown for basic */}
          {kycLevel === 'basic' && (
            <div className="bg-surface shadow-card border-2 border-primary/30 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-base font-bold text-text-primary">Upgrade to Level 2</p>
                  <p className="text-sm text-text-muted">Enhanced KYC — higher limits + better trust score</p>
                </div>
                <Badge variant="gold" size="sm">Optional</Badge>
              </div>
              <div className="space-y-2">
                {[
                  'Daily limit increases to PKR 200,000',
                  'Higher trust score + faster badge progression',
                  'Priority customer support',
                  'Featured trader eligibility',
                ].map((b) => (
                  <div key={b} className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded-full bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
                      <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                    </div>
                    <p className="text-sm text-text-muted">{b}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-text-muted">Requires: 2+ social media profile links</p>
              <Button fullWidth onClick={() => handleSelectTier('enhanced')}>
                Upgrade Verification →
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ── Pending ── */}
      {uiState === 'pending' && (
        <div className="space-y-4">
          <div className="bg-warning/10 border border-warning/20 rounded-xl p-6 space-y-4">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 bg-warning/20 rounded-full flex items-center justify-center flex-shrink-0">
                <Clock size={26} className="text-warning" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-warning">Under Review</h2>
                <p className="text-sm text-text-secondary mt-0.5">
                  Your documents are being reviewed by our KYC team.
                </p>
              </div>
            </div>

            {/* Status timeline */}
            <div className="grid sm:grid-cols-3 gap-3">
              <div className="bg-surface rounded-lg border border-border p-3 text-center">
                <p className="text-xs text-text-muted mb-1">Submitted</p>
                <p className="text-sm font-semibold text-text-primary">
                  {lastDoc
                    ? new Date(lastDoc.createdAt).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' })
                    : '—'}
                </p>
              </div>
              <div className="bg-surface rounded-lg border border-border p-3 text-center">
                <p className="text-xs text-text-muted mb-1">Avg Review Time</p>
                <p className="text-sm font-semibold text-success">~8 Hours</p>
              </div>
              <div className="bg-surface rounded-lg border border-border p-3 text-center">
                <p className="text-xs text-text-muted mb-1">Status</p>
                <p className="text-sm font-semibold text-warning">In Queue</p>
              </div>
            </div>

            <div className="text-xs text-text-muted space-y-1 bg-surface rounded-lg border border-border px-3 py-2">
              <p>• Make sure the photos you submitted are clear and unobstructed.</p>
              <p>• You will receive an email notification once your KYC is approved or rejected.</p>
              <p>• You can continue browsing the platform while your KYC is reviewed.</p>
            </div>
          </div>

          {/* Contact support */}
          <div className="bg-surface border border-border rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-semibold text-text-primary">Need help?</p>
              <p className="text-xs text-text-muted mt-0.5">Visit the Help Center to email us or start a live chat if your review takes longer than 24 hours.</p>
            </div>
            <Link
              href="/help"
              className="flex-shrink-0 px-4 py-2 bg-primary text-white text-sm font-semibold rounded-lg hover:bg-primary-hover transition-colors"
            >
              Contact Support
            </Link>
          </div>
        </div>
      )}

      {/* ── Rejected ── */}
      {uiState === 'rejected' && (
        <div className="bg-danger/10 border border-danger/20 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-danger/20 rounded-full flex items-center justify-center text-danger text-lg">✗</div>
            <div>
              <h2 className="text-base font-bold text-danger">Verification Rejected</h2>
              {(lastDoc?.rejectionReason || lastDoc?.notes) && <p className="text-sm text-text-secondary mt-0.5">{lastDoc.rejectionReason ?? lastDoc.notes}</p>}
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
          {/* L-9: What you need — shown before user picks a tier */}
          <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 space-y-3">
            <h3 className="text-sm font-semibold text-text-primary">What you will need</h3>
            <div className="grid sm:grid-cols-2 gap-3 text-sm text-text-secondary">
              <div className="space-y-2">
                <p className="font-medium text-text-primary flex items-center gap-2">
                  <ShieldCheck size={14} className="text-blue-500" />
                  Basic KYC (Level 1)
                </p>
                <ul className="space-y-1.5">
                  {['CNIC front photo (clear, unobstructed)', 'CNIC back photo', 'A simple selfie'].map((item, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 text-[10px] font-bold flex items-center justify-center flex-shrink-0">{i + 1}</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="space-y-2">
                <p className="font-medium text-text-primary flex items-center gap-2">
                  <ShieldPlus size={14} className="text-amber-500" />
                  Enhanced KYC (Level 2)
                </p>
                <ul className="space-y-1.5">
                  {['Everything in Basic', '2 or more social media profile links', 'Short video verification upload'].map((item, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[10px] font-bold flex items-center justify-center flex-shrink-0">+</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <p className="text-xs text-text-muted">Review typically takes 1–2 business days. Ensure photos are well-lit and all text is readable.</p>
          </div>

          <h2 className="text-base font-semibold text-text-primary">Start with Level 1</h2>
          {/* Level 2 (Enhanced) is an upgrade that reuses your approved Level 1
              documents, so it only unlocks after Basic KYC is approved. */}
          <div className="grid sm:grid-cols-2 gap-4">
            <TierCard tier="basic" onSelect={() => handleSelectTier('basic')} />
            <div className="bg-surface shadow-card rounded-xl border-2 border-dashed border-border p-6 flex flex-col">
              <div className="flex items-center justify-between mb-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-amber-500/10">
                  <ShieldPlus size={20} className="text-amber-500" aria-hidden />
                </div>
                <Badge variant="default" size="sm">Level 2</Badge>
              </div>
              <h3 className="text-base font-bold text-text-primary mb-3">Enhanced KYC</h3>
              <ul className="text-sm text-text-secondary space-y-2 mb-4 flex-1">
                <li className="flex gap-2"><span className="text-text-muted">+</span> Short video verification</li>
                <li className="flex gap-2"><span className="text-text-muted">+</span> 2+ social media profiles</li>
                <li className="flex gap-2"><span className="text-text-muted">+</span> Daily limit: PKR 200,000</li>
              </ul>
              <p className="text-xs text-text-muted">Unlocks after your Level 1 verification is approved — your CNIC and selfie are reused automatically.</p>
            </div>
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

          {/* Level 1 (Basic) — CNIC details + document photos. Level 2 reuses
              the already-approved Level 1 documents, so these are not shown. */}
          {selectedTier === 'basic' && (
            <>
              {/* Legal name as printed on CNIC (non-custodial mode only) */}
              {nonCustodial && (
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">Full name (as on CNIC)</label>
                  <input
                    type="text"
                    autoComplete="name"
                    value={legalName}
                    onChange={(e) => setLegalName(e.target.value)}
                    placeholder="e.g. Ahmed Raza Khan"
                    maxLength={100}
                    className="w-full px-4 py-3 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                  <p className="text-xs text-text-muted mt-1">
                    Must match your CNIC exactly. After approval this becomes your verified name and can&apos;t be changed.
                  </p>
                </div>
              )}

              {/* CNIC Number */}
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">CNIC Number</label>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={cnicNumber}
                  onChange={(e) => setCnicNumber(formatCnic(e.target.value))}
                  placeholder="XXXXX-XXXXXXX-X"
                  maxLength={15}
                  className={`w-full px-4 py-3 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary ${
                    cnicNumber && !isValidCnic(cnicNumber) ? 'border-danger/60 bg-danger/5' : 'border-border'
                  }`}
                />
                {cnicNumber && !isValidCnic(cnicNumber) ? (
                  <p className="text-xs text-danger mt-1">Format: XXXXX-XXXXXXX-X (e.g. 42201-1234567-8)</p>
                ) : (
                  <p className="text-xs text-text-muted mt-1">Your CNIC number will be securely hashed on our servers.</p>
                )}
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
                label="Selfie"
                hint="A clear, well-lit selfie of your face"
                uploadType="kyc-selfie"
                onUploaded={setSelfieUrl}
              />
            </>
          )}

          {/* Enhanced: reuse-notice + short verification video */}
          {selectedTier === 'enhanced' && (
            <>
              <div className="bg-success/5 border border-success/20 rounded-lg px-4 py-3 flex items-start gap-2">
                <span className="text-success mt-0.5">✓</span>
                <p className="text-xs text-text-secondary">
                  Your CNIC and selfie from Level 1 are already verified and reused automatically. Level 2 only needs a short video and your social profiles.
                </p>
              </div>
              <FileUploadField
                label="Video Verification"
                hint="A short video of yourself (e.g. say your name and today's date)"
                uploadType="kyc-video"
                onUploaded={setVideoUrl}
              />
            </>
          )}

          {/* Social links — Enhanced always; Basic only in non-custodial mode (min 1) */}
          {(selectedTier === 'enhanced' || (selectedTier === 'basic' && nonCustodial)) && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-text-primary">
                  Social Media Profiles ({selectedTier === 'enhanced' ? 'min 2' : 'min 1 — Facebook or Instagram preferred'})
                </label>
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
                      className="w-36 px-2 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
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
              {(selectedTier === 'enhanced' ? [
                { label: 'At least 2 social links', done: socialLinks.filter((l) => l.url.trim()).length >= 2 },
                { label: 'Verification video uploaded', done: !!videoUrl },
              ] : [
                ...(nonCustodial ? [{ label: 'Full name (as on CNIC) entered', done: legalName.trim().length >= 3 }] : []),
                { label: 'CNIC number entered', done: !!cnicNumber },
                { label: 'CNIC front uploaded', done: !!frontUrl },
                { label: 'CNIC back uploaded', done: !!backUrl },
                { label: 'Selfie uploaded', done: !!selfieUrl },
                ...(nonCustodial ? [{ label: 'At least 1 social profile', done: socialLinks.filter((l) => l.url.trim()).length >= 1 }] : []),
              ]).map((item, i) => (
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
