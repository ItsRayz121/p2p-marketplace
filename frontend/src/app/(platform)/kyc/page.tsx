'use client'
import { useState, useEffect, useCallback } from 'react'
import { kycApi, marketplaceApi, socialLinksApi } from '@/lib/api'
import type { KycDocument } from '@/lib/api'
import { analytics } from '@/lib/analytics'
import { useFileUpload } from '@/hooks/useFileUpload'
import { UploadProgress } from '@/components/ui/UploadProgress'
import { usePolling } from '@/hooks/usePolling'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Clock, ShieldCheck, ShieldPlus } from 'lucide-react'
import { TraderLevelCard } from '@/components/ui/TraderLevelCard'
import { EntityLogo } from '@/components/ui/EntityLogo'
import Link from 'next/link'

// ─── Helpers ─────────────────────────────────────────────────────────────────

type IdType = 'national_id' | 'passport'

// ID numbers differ by country, so validate loosely (the backend applies the same
// rule): 5-30 letters, digits, spaces or dashes, as printed on the document.
function isValidIdNumber(v: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 -]{4,29}$/.test(v.trim())
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
            <li className="flex gap-2"><span className="text-success">✓</span> National ID (front &amp; back) or passport photo page</li>
            <li className="flex gap-2"><span className="text-success">✓</span> Simple selfie</li>
            <li className="flex gap-2"><span className="text-success">✓</span> Unlocks posting ads (not needed to trade or buy gas)</li>
            <li className="flex gap-2"><span className="text-success">✓</span> Daily limit: PKR 50,000</li>
          </>
        ) : (
          <>
            <li className="flex gap-2"><span className="text-success">✓</span> Everything in Basic</li>
            <li className="flex gap-2"><span className="text-success">✓</span> WhatsApp number + your trading community link</li>
            <li className="flex gap-2"><span className="text-success">✓</span> Optional: video, social profiles, trusted reference</li>
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
  const { upload, uploading, error, progress } = useFileUpload(uploadType)
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
          <div className="flex flex-col items-center gap-2 py-4 px-2">
            {progress ? (
              <UploadProgress progress={progress} className="max-w-xs" />
            ) : (
              <>
                <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                <span className="text-xs text-text-muted">Uploading...</span>
              </>
            )}
          </div>
        ) : preview ? (
          <div className="space-y-2">
            {isVideo ? (
              <video src={preview} className="h-24 rounded-lg mx-auto" controls />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img loading="lazy" decoding="async" src={preview} alt="Preview" className="h-24 object-cover rounded-lg mx-auto" />
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
  const [idType, setIdType] = useState<IdType>('national_id')
  const [cnicNumber, setCnicNumber] = useState('')
  const [legalName, setLegalName] = useState('')
  const [frontUrl, setFrontUrl] = useState('')
  const [backUrl, setBackUrl] = useState('')
  const [selfieUrl, setSelfieUrl] = useState('')
  const [videoUrl, setVideoUrl] = useState('')
  // Level 2 (ad posting) answers. `wantsAds` is the "I also want to post ads" switch on
  // the Level 1 form: when ON the single submission also carries these answers.
  const [wantsAds, setWantsAds] = useState(false)
  const [whatsapp, setWhatsapp] = useState('')
  const [communityUrl, setCommunityUrl] = useState('')
  const [referenceUrl, setReferenceUrl] = useState('')
  const [makerContact, setMakerContact] = useState('')
  // Show three social-profile fields by default for Enhanced KYC (min 2 required).
  const [socialLinks, setSocialLinks] = useState<SocialLink[]>([
    { platform: 'Facebook', url: '' },
    { platform: 'Instagram', url: '' },
    { platform: 'Twitter/X', url: '' },
  ])
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  // Social profiles the user already verified in a prior KYC — reused automatically
  // so we never ask for the same social twice.
  const [verifiedSocials, setVerifiedSocials] = useState<Array<{ platform: string; url: string }>>([])

  const fetchStatus = useCallback(async () => {
    try {
      const res = await kycApi.getStatus()
      setKycStatus(res.status ?? 'none')
      setKycLevel(res.level ?? 'none')
      setLatestSubmission(res.latestSubmission)
      setMakerContact(res.makerContactTelegram ?? '')

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

  // Load already-verified social profiles so we don't ask for them again.
  useEffect(() => {
    socialLinksApi.get()
      .then((d) => setVerifiedSocials(d.links.filter((l) => l.verified).map((l) => ({ platform: l.platform, url: l.url }))))
      .catch(() => {})
  }, [])

  // Platform key for de-duplication against already-verified socials.
  const socialKey = (p: string) => p.toLowerCase().replace(/twitter\/x|^x$/, 'twitter').replace(/[^a-z0-9]/g, '')
  const verifiedKeys = new Set(verifiedSocials.map((v) => socialKey(v.platform)))

  // Poll every 20s while pending so the approved state appears without a manual refresh
  usePolling(fetchStatus, 20000, uiState === 'pending')

  const handleSelectTier = (tier: KycTier) => {
    setSelectedTier(tier)
    setWantsAds(false)
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
    // Ad-posting answers are collected for Level 2, or on the Level 1 form when the
    // user switched on "I also want to post ads" (then it is one combined submission).
    const adsFields = selectedTier === 'enhanced' || wantsAds
    if (selectedTier === 'basic') {
      // Level 1 collects CNIC details + document photos.
      if (!frontUrl || (idType === 'national_id' && !backUrl) || !selfieUrl || !cnicNumber) {
        setSubmitError('Please fill all required fields and upload all documents.')
        return
      }
      if (nonCustodial && legalName.trim().length < 3) {
        setSubmitError('Enter your full name exactly as printed on your ID or passport.')
        return
      }
      if (!isValidIdNumber(cnicNumber)) {
        setSubmitError(idType === 'passport'
          ? 'Enter your passport number exactly as printed (5-30 letters or digits).'
          : 'Enter your ID number exactly as printed (5-30 letters, digits, spaces or dashes).')
        return
      }
      if (nonCustodial && (socialLinks.filter((l) => l.url.trim()).length + verifiedSocials.length) < 1) {
        setSubmitError('Add at least one social profile (Facebook or Instagram preferred).')
        return
      }
    }
    if (adsFields) {
      if (!user?.telegramLinked) {
        setSubmitError('Link your Telegram account in Settings first, then come back to submit.')
        return
      }
      if (whatsapp.replace(/\D/g, '').length < 7) {
        setSubmitError('Enter your WhatsApp number with country code, e.g. +923001234567.')
        return
      }
      if (!/^https:\/\/(chat\.whatsapp\.com|whatsapp\.com|www\.whatsapp\.com|t\.me|telegram\.me|telegram\.dog)\/\S+/i.test(communityUrl.trim())) {
        setSubmitError('Add the link to your WhatsApp or Telegram group or channel, e.g. https://chat.whatsapp.com/... or https://t.me/...')
        return
      }
      if (referenceUrl.trim() && !/^https:\/\/\S+/i.test(referenceUrl.trim())) {
        setSubmitError('The trusted reference must be a link starting with https://')
        return
      }
    }

    setSubmitting(true)
    setSubmitError(null)
    try {
      // Include newly-entered links PLUS the already-verified ones (reused so the
      // minimum is met without re-typing; backend merge is idempotent).
      const newLinks = socialLinks.filter((l) => l.url.trim() && !verifiedKeys.has(socialKey(l.platform)))
      const validLinks = [...verifiedSocials, ...newLinks]
      await kycApi.submit({
        tier: adsFields ? 'enhanced' : selectedTier,
        // Level 1 only — Level 2 reuses the already-approved identity documents.
        ...(selectedTier === 'basic'
          ? { idType, idNumber: cnicNumber.trim(), ...(legalName.trim() ? { legalName: legalName.trim() } : {}), frontUrl, ...(idType === 'national_id' ? { backUrl } : {}), selfieUrl }
          : {}),
        ...(adsFields && videoUrl ? { videoUrl } : {}),
        ...(adsFields
          ? {
              whatsappNumber: whatsapp.trim(),
              communityLinks: [{ url: communityUrl.trim() }],
              ...(referenceUrl.trim() ? { referenceUrl: referenceUrl.trim() } : {}),
            }
          : {}),
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
      <p className="text-sm text-text-muted mb-6">KYC is not required to buy, sell, trade or buy gas. You only need it to post an ad.</p>

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
                  <p className="text-base font-bold text-text-primary">Want to post ads? Upgrade to Level 2</p>
                  <p className="text-sm text-text-muted">Required to become a maker. Higher limits + better trust score too.</p>
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
              <p className="text-xs text-text-muted">Requires: your WhatsApp number and your trading community link. Video, social profiles and a trusted reference are optional.</p>
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
                  {['National ID: front and back photos, or passport: the photo page only', 'A simple selfie'].map((item, i) => (
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
                  {['Everything in Basic', 'WhatsApp number + link to your WhatsApp / Telegram group or channel', 'Optional: short video, social profiles, trusted reference'].map((item, i) => (
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
                <li className="flex gap-2"><span className="text-text-muted">+</span> WhatsApp number + your community link</li>
                <li className="flex gap-2"><span className="text-text-muted">+</span> Optional: video, socials, trusted reference</li>
                <li className="flex gap-2"><span className="text-text-muted">+</span> Daily limit: PKR 200,000</li>
              </ul>
              <p className="text-xs text-text-muted">Needed only to post ads. Tick &ldquo;I also want to post ads&rdquo; while doing Level 1, or come back and do it later: your ID and selfie are reused.</p>
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
              {/* Document type: a national ID needs both sides, a passport just its photo page */}
              <div>
                <p className="block text-sm font-medium text-text-primary mb-2">Identity document</p>
                <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Identity document type">
                  {([['national_id', 'National ID', 'Front and back'], ['passport', 'Passport', 'Photo page only']] as const).map(([val, title, sub]) => (
                    <button
                      key={val}
                      type="button"
                      role="radio"
                      aria-checked={idType === val}
                      onClick={() => {
                        if (idType === val) return
                        setIdType(val); setFrontUrl(''); setBackUrl('')
                      }}
                      className={`text-left rounded-lg border-2 px-3 py-2.5 transition-colors ${idType === val ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/30'}`}
                    >
                      <span className="block text-sm font-semibold text-text-primary">{title}</span>
                      <span className="block text-xs text-text-muted">{sub}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Legal name as printed on the ID (non-custodial mode only) */}
              {nonCustodial && (
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">Full name (as on your {idType === 'passport' ? 'passport' : 'ID'})</label>
                  <input
                    type="text"
                    autoComplete="name"
                    value={legalName}
                    onChange={(e) => setLegalName(e.target.value)}
                    placeholder="Your full legal name"
                    maxLength={100}
                    className="w-full px-4 py-3 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                  <p className="text-xs text-text-muted mt-1">
                    Must match your {idType === 'passport' ? 'passport' : 'ID'} exactly. After approval this becomes your verified name and can&apos;t be changed.
                  </p>
                </div>
              )}

              {/* ID / passport number */}
              <div>
                <label htmlFor="kyc-id-number" className="block text-sm font-medium text-text-primary mb-1">{idType === 'passport' ? 'Passport number' : 'National ID number'}</label>
                <input
                  id="kyc-id-number"
                  type="text"
                  autoComplete="off"
                  value={cnicNumber}
                  onChange={(e) => setCnicNumber(e.target.value.toUpperCase().slice(0, 30))}
                  placeholder={idType === 'passport' ? 'As printed on the photo page' : 'As printed on your ID'}
                  maxLength={30}
                  className={`w-full px-4 py-3 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary ${
                    cnicNumber && !isValidIdNumber(cnicNumber) ? 'border-danger/60 bg-danger/5' : 'border-border'
                  }`}
                />
                {cnicNumber && !isValidIdNumber(cnicNumber) ? (
                  <p className="text-xs text-danger mt-1">Enter it exactly as printed: 5-30 letters, digits, spaces or dashes.</p>
                ) : (
                  <p className="text-xs text-text-muted mt-1">Your number will be securely hashed on our servers.</p>
                )}
              </div>

              {/* Document uploads */}
              <FileUploadField
                key={`front-${idType}`}
                label={idType === 'passport' ? 'Passport photo page' : 'ID Front'}
                hint={idType === 'passport'
                  ? 'The page with your photo and personal details. Only this one page is needed.'
                  : 'Clear photo of the front side of your ID'}
                uploadType="kyc-front"
                onUploaded={setFrontUrl}
              />

              {idType === 'national_id' && (
                <FileUploadField
                  key="back-national_id"
                  label="ID Back"
                  hint="Clear photo of the back side of your ID"
                  uploadType="kyc-back"
                  onUploaded={setBackUrl}
                />
              )}

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
                  Your ID and selfie from Level 1 are already verified and reused automatically. Level 2 only needs the details below.
                </p>
              </div>
            </>
          )}

          {/* Basic form: switch to also apply for ad posting in the same submission */}
          {selectedTier === 'basic' && (
            <label className="flex items-start gap-3 rounded-xl border-2 border-primary/30 bg-primary/5 p-4 cursor-pointer">
              <input type="checkbox" checked={wantsAds} onChange={(e) => setWantsAds(e.target.checked)} className="mt-1 w-4 h-4 accent-primary" />
              <span>
                <span className="block text-sm font-semibold text-text-primary">I also want to post ads on the platform</span>
                <span className="block text-xs text-text-muted mt-0.5">A few extra questions, reviewed together with your ID. You can skip this now and do it later.</span>
              </span>
            </label>
          )}

          {/* Ad posting (Level 2) answers */}
          {(selectedTier === 'enhanced' || wantsAds) && (
            <div className="space-y-4 rounded-xl border border-border p-4">
              <p className="text-sm font-semibold text-text-primary">To post ads</p>
              {!user?.telegramLinked && (
                <p className="text-xs text-warning bg-warning/10 border border-warning/20 rounded-lg px-3 py-2">
                  Link your Telegram account in <Link href="/settings" className="underline font-medium">Settings</Link> first. You need it to submit.
                </p>
              )}
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Your WhatsApp number</label>
                <input type="tel" inputMode="tel" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} placeholder="+92 300 1234567" maxLength={32}
                  className="w-full px-4 py-3 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Your WhatsApp or Telegram group / channel</label>
                <input type="url" inputMode="url" autoCapitalize="none" value={communityUrl} onChange={(e) => setCommunityUrl(e.target.value)} placeholder="https://chat.whatsapp.com/... or https://t.me/..." maxLength={300}
                  className="w-full px-4 py-3 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
                <p className="text-xs text-text-muted mt-1">Real traders have their own community. We open this link to check it is real and active.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Trusted reference <span className="font-normal text-text-muted">(optional)</span></label>
                <input type="url" inputMode="url" autoCapitalize="none" value={referenceUrl} onChange={(e) => setReferenceUrl(e.target.value)} placeholder="https://... profile of a known admin, YouTuber or influencer who can vouch for you" maxLength={500}
                  className="w-full px-4 py-3 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
              </div>
              <FileUploadField
                label="Verification video (optional)"
                hint="A short video of yourself (e.g. say your name and today's date). It helps your review go smoothly."
                uploadType="kyc-video"
                onUploaded={setVideoUrl}
              />
              {makerContact && (
                <div className="rounded-lg bg-surface-alt px-3 py-2.5 text-xs text-text-secondary">
                  After you submit, message us on Telegram at <span className="font-semibold text-text-primary">{makerContact}</span> so we can confirm you quickly.
                </div>
              )}
            </div>
          )}

          {/* Social links — Enhanced always; Basic only in non-custodial mode (min 1) */}
          {((selectedTier === 'enhanced' || wantsAds) || (selectedTier === 'basic' && nonCustodial)) && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-text-primary">
                  Social Media Profiles ({selectedTier === 'basic' && nonCustodial ? 'min 1 — Facebook or Instagram preferred' : 'optional'})
                </label>
                {socialLinks.length < 3 && (
                  <Button size="sm" variant="ghost" onClick={addSocialLink}>+ Add</Button>
                )}
              </div>

              {/* Already-verified socials — reused automatically, never re-asked */}
              {verifiedSocials.length > 0 && (
                <div className="mb-3 rounded-lg border border-success/30 bg-success/5 p-3">
                  <p className="text-xs font-medium text-success mb-2">✓ Already verified — reused automatically</p>
                  <div className="flex flex-wrap gap-2">
                    {verifiedSocials.map((v, i) => (
                      <span key={`${v.platform}-${i}`} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-border bg-surface text-xs text-text-primary">
                        <EntityLogo type="social" slug={v.platform} size="xs" className="flex-shrink-0" />
                        {v.platform}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-3">
                {socialLinks.map((link, i) => (
                  <div key={i} className="flex gap-2">
                    <select
                      value={link.platform}
                      onChange={(e) => updateSocialLink(i, 'platform', e.target.value)}
                      className="w-36 px-2 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
                    >
                      {SOCIAL_PLATFORMS.filter((p) => !verifiedKeys.has(socialKey(p)) || socialKey(p) === socialKey(link.platform)).map((p) => <option key={p}>{p}</option>)}
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
                ...(selectedTier === 'enhanced' || wantsAds ? [
                  { label: 'Telegram account linked', done: !!user?.telegramLinked },
                  { label: 'WhatsApp number entered', done: whatsapp.replace(/\D/g, '').length >= 7 },
                  { label: 'Community link added', done: communityUrl.trim().length > 8 },
                ] : []),
                ...(selectedTier === 'enhanced' ? [] : [
                ...(nonCustodial ? [{ label: 'Full name (as on your ID or passport) entered', done: legalName.trim().length >= 3 }] : []),
                { label: idType === 'passport' ? 'Passport number entered' : 'ID number entered', done: !!cnicNumber },
                { label: idType === 'passport' ? 'Passport photo page uploaded' : 'ID front uploaded', done: !!frontUrl },
                ...(idType === 'national_id' ? [{ label: 'ID back uploaded', done: !!backUrl }] : []),
                { label: 'Selfie uploaded', done: !!selfieUrl },
                ...(nonCustodial ? [{ label: 'At least 1 social profile', done: socialLinks.filter((l) => l.url.trim()).length >= 1 }] : []),
              ]),
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
