'use client'
import { useState, useEffect, useCallback } from 'react'
import { gasApi } from '@/lib/api'
import { toast } from '@/lib/toast'
import { buildReferralLinks } from '@/lib/telegram'
import { LoadingState } from '@/components/ui/LoadingState'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Spinner } from '@/components/ui/Spinner'
import { CopyButton } from '@/components/ui/CopyButton'
import { Gift, Trash2, Link2 } from 'lucide-react'

// The single earnings + links hub for the Referral page. Shows live (USDT) gas referral
// earnings, the user's custom referral links (open to everyone — standard friend-discount
// + commission split), and the affiliate upgrade application. The canonical primary code
// is rendered by the parent (/referral), so this component omits the redundant code card.

type AffiliateOverview = Awaited<ReturnType<typeof gasApi.getAffiliateOverview>>
type AffiliateLink = AffiliateOverview['links'][number]

const SOCIAL_FIELDS: { key: string; label: string; placeholder: string }[] = [
  { key: 'twitter',  label: 'X / Twitter', placeholder: '@handle or link' },
  { key: 'telegram', label: 'Telegram',    placeholder: '@handle or channel link' },
  { key: 'youtube',  label: 'YouTube',     placeholder: 'channel link' },
  { key: 'instagram',label: 'Instagram',   placeholder: '@handle or link' },
  { key: 'website',  label: 'Website',     placeholder: 'https://…' },
]

/** Custom links are shared with the SAME web/Telegram links as the primary code. */
function shareUrl(code: string): string {
  return buildReferralLinks(code).web
}

export function ReferralEarnings() {
  const [data, setData] = useState<AffiliateOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [withdrawing, setWithdrawing] = useState(false)
  const [applyCode, setApplyCode] = useState('')
  const [applying, setApplying] = useState(false)
  const [socials, setSocials] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [busyLink, setBusyLink] = useState<string | null>(null)
  const [newLabel, setNewLabel] = useState('')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { setData(await gasApi.getAffiliateOverview()) }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to load earnings') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  const handleWithdraw = async () => {
    setWithdrawing(true)
    try {
      const r = await gasApi.withdrawReferral()
      toast.success(`Withdrew $${r.withdrawnUsdt.toFixed(2)} to your USDT balance`)
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Withdrawal failed') }
    finally { setWithdrawing(false) }
  }

  const handleApply = async () => {
    if (!applyCode.trim()) return
    setApplying(true)
    try {
      const r = await gasApi.applyReferral(applyCode.trim())
      if (r.bound) toast.success('Referral code applied')
      else toast.error('Code could not be applied (already linked, or invalid)')
      setApplyCode('')
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to apply code') }
    finally { setApplying(false) }
  }

  const handleApplyAffiliate = async () => {
    const filled = Object.fromEntries(Object.entries(socials).filter(([, v]) => v.trim()))
    if (Object.keys(filled).length === 0) { toast.error('Add at least one social profile'); return }
    setSubmitting(true)
    try {
      await gasApi.applyAffiliate({ socials: filled, ...(note.trim() ? { note: note.trim() } : {}) })
      toast.success('Application submitted — an admin will review it')
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to submit application') }
    finally { setSubmitting(false) }
  }

  // Standard (self-service) link: name only, fixed split from policy.
  const handleCreateCustom = async () => {
    setCreating(true)
    try {
      await gasApi.createCustomLink(newLabel.trim() || null)
      toast.success('Custom link created')
      setNewLabel('')
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to create link') }
    finally { setCreating(false) }
  }

  // Approved-affiliate link: choose the discount/commission split.
  const handleCreateAffiliate = async () => {
    if (!caps) return
    const discountRaw = window.prompt(`Buyer discount % (min ${caps.minUserDiscountPct}, allowance ${caps.maxMarginPct}% total)`, String(caps.minUserDiscountPct))
    if (discountRaw === null) return
    const userDiscountPct = Number(discountRaw)
    const commissionRaw = window.prompt(`Your commission % (discount + commission must be ≤ ${caps.maxMarginPct}%)`, String(Math.max(0, caps.maxMarginPct - userDiscountPct)))
    if (commissionRaw === null) return
    const commissionPct = Number(commissionRaw)
    if (!(userDiscountPct >= 0) || !(commissionPct >= 0)) { toast.error('Invalid split'); return }
    setCreating(true)
    try {
      await gasApi.createAffiliateLink({ ...(newLabel.trim() ? { label: newLabel.trim() } : {}), userDiscountPct, commissionPct })
      toast.success('Affiliate link created')
      setNewLabel('')
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to create link') }
    finally { setCreating(false) }
  }

  const handleEditLink = async (link: AffiliateLink) => {
    if (!caps) return
    const discountRaw = window.prompt(`Buyer discount % for ${link.code} (min ${caps.minUserDiscountPct})`, String(link.userDiscountPct))
    if (discountRaw === null) return
    const userDiscountPct = Number(discountRaw)
    const commissionRaw = window.prompt(`Your commission % (discount + commission must be ≤ ${caps.maxMarginPct}%)`, String(link.commissionPct))
    if (commissionRaw === null) return
    const commissionPct = Number(commissionRaw)
    if (!(userDiscountPct >= 0) || !(commissionPct >= 0)) { toast.error('Invalid split'); return }
    setBusyLink(link.id)
    try {
      await gasApi.updateAffiliateLink(link.id, { userDiscountPct, commissionPct })
      toast.success(`${link.code} updated`)
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to update link') }
    finally { setBusyLink(null) }
  }

  const handleDeleteLink = async (link: AffiliateLink) => {
    if (!window.confirm(`Delete link ${link.code}? People who already joined through it stay yours and keep earning you commission — you just free up a slot.`)) return
    setBusyLink(link.id)
    try {
      await gasApi.deleteCustomLink(link.id)
      toast.success('Link deleted')
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to delete link') }
    finally { setBusyLink(null) }
  }

  if (loading) return <LoadingState message="Loading earnings..." />
  if (error) return <p className="text-sm text-danger">{error}</p>
  if (!data) return null

  const sum = data.earnings
  const caps = data.caps
  const policy = data.customLinkPolicy
  // Nothing is live if neither the affiliate program nor the underlying referral earnings are on.
  if (!data.enabled && !sum.enabled) return null

  const canWithdraw = sum.kycOk && sum.withdrawableUsdt > 0 && sum.withdrawableUsdt >= sum.minWithdrawUsdt

  return (
    <div className="space-y-6">
      {/* Live referral earnings — single source of truth (USDT) */}
      {sum.enabled && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="People referred" value={String(sum.referredCount)} />
            <Stat label="Total earned" value={`$${sum.totalAccruedUsdt.toFixed(2)}`} />
            <Stat label="Available now" value={`$${sum.withdrawableUsdt.toFixed(2)}`} accent />
            <Stat label="Withdrawn" value={`$${sum.withdrawnUsdt.toFixed(2)}`} />
          </div>

          <div className="bg-surface shadow-card border border-border rounded-xl p-5 space-y-3">
            <h3 className="text-sm font-bold text-text-primary">Withdraw earnings</h3>
            {sum.availableUsdt > sum.withdrawableUsdt && (
              <p className="text-xs text-text-muted">${(sum.availableUsdt - sum.withdrawableUsdt).toFixed(2)} is still in the fraud-hold window and will become withdrawable shortly.</p>
            )}
            {!sum.kycOk && <p className="text-xs text-amber-600 dark:text-amber-400">Complete identity verification (KYC) to withdraw your earnings.</p>}
            {sum.kycOk && sum.withdrawableUsdt < sum.minWithdrawUsdt && (
              <p className="text-xs text-text-muted">Minimum withdrawal is ${sum.minWithdrawUsdt.toFixed(2)}. Keep referring to reach it.</p>
            )}
            <Button onClick={handleWithdraw} disabled={!canWithdraw || withdrawing}>
              {withdrawing ? <Spinner size="sm" /> : `Withdraw $${sum.withdrawableUsdt.toFixed(2)} to USDT balance`}
            </Button>
          </div>
        </>
      )}

      {/* Custom referral links — open to every user */}
      {data.enabled && (
        <div className="bg-surface shadow-card border border-border rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Link2 size={16} className="text-primary" />
            <h3 className="text-sm font-bold text-text-primary">Your custom links</h3>
          </div>
          <p className="text-xs text-text-muted">
            {caps
              ? `Each link splits your ${caps.maxMarginPct}% margin allowance between a buyer discount and your commission.`
              : `Create up to ${policy.maxLinks} named links — each gives your friend ${policy.userDiscountPct}% off their gas fee and earns you ${policy.commissionPct}%, paid in USDT.`}
          </p>

          {data.links.map((link) => (
            <div key={link.id} className="bg-surface-alt rounded-xl p-3 border border-border space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-base font-mono font-bold tracking-wider text-text-primary">{link.code}</span>
                  {link.label && <span className="text-xs text-text-muted ml-2">{link.label}</span>}
                </div>
                <div className="flex items-center gap-1">
                  <CopyButton text={shareUrl(link.code)} />
                  <button
                    onClick={() => handleDeleteLink(link)}
                    disabled={busyLink === link.id}
                    className="p-2 rounded-lg text-text-muted hover:text-danger hover:bg-danger/10 disabled:opacity-50"
                    aria-label={`Delete ${link.code}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div><p className="text-text-muted">Friend discount</p><p className="font-semibold text-success">{link.userDiscountPct}%</p></div>
                <div><p className="text-text-muted">You earn</p><p className="font-semibold text-primary">{link.commissionPct}%</p></div>
                <div><p className="text-text-muted">Referred</p><p className="font-semibold text-text-primary">{link.referredCount}</p></div>
              </div>
              {caps && (
                <Button size="sm" variant="ghost" onClick={() => handleEditLink(link)} disabled={busyLink === link.id}>Edit split</Button>
              )}
            </div>
          ))}

          {policy.canCreate ? (
            <div className="flex gap-2">
              <Input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Name this link (e.g. My Twitter drop)" maxLength={60} />
              <Button variant="secondary" onClick={caps ? handleCreateAffiliate : handleCreateCustom} disabled={creating}>
                {creating ? <Spinner size="sm" /> : `Create (${policy.used}/${policy.maxLinks})`}
              </Button>
            </div>
          ) : policy.cooldownUntil ? (
            <p className="text-xs text-text-muted">You can add a new link after {new Date(policy.cooldownUntil).toLocaleDateString()}.</p>
          ) : (
            <p className="text-xs text-text-muted">You&apos;ve reached your {policy.maxLinks}-link limit. Delete a link to create another.</p>
          )}
        </div>
      )}

      {/* Affiliate program — application / status (for higher commission tiers) */}
      {data.enabled && data.status !== 'approved' && (
        <div className="bg-surface shadow-card border border-border rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Gift size={16} className="text-primary" />
            <h3 className="text-sm font-bold text-text-primary">Become an affiliate</h3>
          </div>
          {data.status === 'pending' ? (
            <p className="text-sm text-amber-600 dark:text-amber-400">Your application is under review. We&apos;ll notify you once it&apos;s approved.</p>
          ) : (
            <>
              {data.status === 'rejected' && data.rejectionReason && (
                <p className="text-xs text-red-500">Previous application rejected: {data.rejectionReason}</p>
              )}
              <p className="text-sm text-text-muted">
                Approved affiliates get a much larger margin allowance (typically 20–30%) to split between a bigger discount for your audience and your own commission — all paid from our platform fee, never extra cost to your users.
              </p>
              <div className="space-y-2">
                {SOCIAL_FIELDS.map((f) => (
                  <div key={f.key}>
                    <label className="text-xs font-semibold text-text-secondary">{f.label}</label>
                    <Input
                      value={socials[f.key] ?? ''}
                      onChange={(e) => setSocials((s) => ({ ...s, [f.key]: e.target.value }))}
                      placeholder={f.placeholder}
                    />
                  </div>
                ))}
                <div>
                  <label className="text-xs font-semibold text-text-secondary">Anything else? (optional)</label>
                  <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Audience size, niche, etc." />
                </div>
              </div>
              <Button onClick={handleApplyAffiliate} disabled={submitting}>
                {submitting ? <Spinner size="sm" /> : data.status === 'rejected' ? 'Re-apply' : 'Apply as affiliate'}
              </Button>
            </>
          )}
        </div>
      )}

      {/* Were you referred? — single instance */}
      {sum.enabled && !sum.boundToReferrer && (
        <div className="bg-surface shadow-card border border-border rounded-xl p-5 space-y-3">
          <h3 className="text-sm font-bold text-text-primary">Were you referred?</h3>
          <p className="text-xs text-text-muted">Enter the code of whoever invited you. This can only be set once.</p>
          <div className="flex gap-2">
            <Input value={applyCode} onChange={(e) => setApplyCode(e.target.value.toUpperCase())} placeholder="REFERRAL CODE" className="uppercase" />
            <Button variant="secondary" onClick={handleApply} disabled={applying || !applyCode.trim()}>
              {applying ? <Spinner size="sm" /> : 'Apply'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-surface shadow-card border border-border rounded-xl p-4">
      <p className="text-xs text-text-muted">{label}</p>
      <p className={`text-lg font-bold ${accent ? 'text-success' : 'text-text-primary'}`}>{value}</p>
    </div>
  )
}
