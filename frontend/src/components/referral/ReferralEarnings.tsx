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
import { Gift, Trash2, Link2, ChevronDown, Send, Globe } from 'lucide-react'

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
  const [newCode, setNewCode] = useState('')
  const [newDiscount, setNewDiscount] = useState('')   // affiliate-only: audience discount %
  const [newCommission, setNewCommission] = useState('') // affiliate-only: own commission %
  const [creating, setCreating] = useState(false)
  const [showWasReferred, setShowWasReferred] = useState(false)
  const [showAffiliate, setShowAffiliate] = useState(false)
  // Each created link renders collapsed (dropdown) and expands on demand, keeping
  // it visually separate from the create-a-new-link form below.
  const [openLinks, setOpenLinks] = useState<Set<string>>(new Set())
  const toggleLink = (id: string) => setOpenLinks((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  // The whole created-links list collapses under a header chevron, keeping the
  // card tidy once you have links — the create-a-link form stays the focus.
  const [linksListOpen, setLinksListOpen] = useState(true)
  // The entire custom-links card collapses under its header — closed by default so
  // affiliates can tuck the whole section (links + create form) out of the way.
  const [customLinksOpen, setCustomLinksOpen] = useState(false)
  // Inline split editor for an existing affiliate link (replaces window.prompt).
  const [editSplit, setEditSplit] = useState<{ id: string; userDiscountPct: string; commissionPct: string } | null>(null)

  // The link the user just created — pinned to the top of the list and shown
  // expanded so it surfaces right under the "Your custom links" heading.
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null)

  const load = useCallback(async (): Promise<AffiliateOverview | null> => {
    setLoading(true); setError('')
    try {
      const fresh = await gasApi.getAffiliateOverview()
      setData(fresh)
      return fresh
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to load earnings'); return null }
    finally { setLoading(false) }
  }, [])

  // Reload, then pin + expand whichever link is newly present (by id diff).
  const reloadAndHighlightNew = useCallback(async () => {
    const prevIds = new Set((data?.links ?? []).map((l) => l.id))
    const fresh = await load()
    const created = fresh?.links?.find((l) => !prevIds.has(l.id))
    if (created) {
      setJustCreatedId(created.id)
      setLinksListOpen(true)
      setOpenLinks((prev) => new Set(prev).add(created.id))
    }
  }, [data?.links, load])

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

  // Standard (self-service) link: the user picks their own code (their name); fixed split.
  const handleCreateCustom = async () => {
    const code = newCode.trim()
    if (code && (code.length < 3 || code.length > 20)) { toast.error('Code must be 3–20 letters or numbers'); return }
    setCreating(true)
    try {
      await gasApi.createCustomLink(code ? { code } : undefined)
      toast.success('Custom link created')
      setNewCode('')
      await reloadAndHighlightNew()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to create link') }
    finally { setCreating(false) }
  }

  // Validate an affiliate split against the granted caps. Returns an error string or null.
  const splitError = (userDiscountPct: number, commissionPct: number): string | null => {
    if (!caps) return null
    if (!(userDiscountPct >= 0) || !(commissionPct >= 0)) return 'Enter valid percentages'
    if (userDiscountPct < caps.minUserDiscountPct) return `Audience discount must be at least ${caps.minUserDiscountPct}%`
    if (userDiscountPct + commissionPct > caps.maxMarginPct) return `Discount + commission cannot exceed ${caps.maxMarginPct}%`
    return null
  }

  // Approved-affiliate link: pick your own code + the audience-discount / own-commission split (inline).
  const handleCreateAffiliate = async () => {
    if (!caps) return
    const code = newCode.trim()
    if (code && (code.length < 3 || code.length > 20)) { toast.error('Code must be 3–20 letters or numbers'); return }
    const userDiscountPct = Number(newDiscount || caps.minUserDiscountPct)
    const commissionPct = Number(newCommission || Math.max(0, caps.maxMarginPct - userDiscountPct))
    const err = splitError(userDiscountPct, commissionPct)
    if (err) { toast.error(err); return }
    setCreating(true)
    try {
      await gasApi.createAffiliateLink({ ...(code ? { code } : {}), userDiscountPct, commissionPct })
      toast.success('Affiliate link created')
      setNewCode(''); setNewDiscount(''); setNewCommission('')
      await reloadAndHighlightNew()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to create link') }
    finally { setCreating(false) }
  }

  // Save an inline split edit for an existing affiliate link.
  const handleSaveSplit = async (link: AffiliateLink) => {
    if (!editSplit) return
    const userDiscountPct = Number(editSplit.userDiscountPct)
    const commissionPct = Number(editSplit.commissionPct)
    const err = splitError(userDiscountPct, commissionPct)
    if (err) { toast.error(err); return }
    setBusyLink(link.id)
    try {
      await gasApi.updateAffiliateLink(link.id, { userDiscountPct, commissionPct })
      toast.success(`${link.code} updated`)
      setEditSplit(null)
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

      {/* Custom referral links — approved affiliates only. The whole card collapses
          under its header (closed by default) via the card-level chevron. */}
      {data.enabled && caps && (
        <div className="bg-surface shadow-card border border-border rounded-xl overflow-hidden">
          <button
            type="button"
            onClick={() => setCustomLinksOpen((v) => !v)}
            aria-expanded={customLinksOpen}
            aria-label={customLinksOpen ? 'Hide your custom links' : 'Show your custom links'}
            className="w-full flex items-center justify-between gap-2 px-5 py-3 hover:bg-surface-alt transition-colors"
          >
            <span className="flex items-center gap-2 flex-wrap min-w-0">
              <Link2 size={16} className="text-primary shrink-0" />
              <span className="text-sm font-bold text-text-primary">Your custom links</span>
              <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-success">
                Affiliate
              </span>
              {data.links.length > 0 && (
                <span className="text-[11px] text-text-muted">· {data.links.length} {data.links.length === 1 ? 'link' : 'links'}</span>
              )}
            </span>
            <ChevronDown size={18} className={`text-text-muted shrink-0 transition-transform ${customLinksOpen ? 'rotate-180' : ''}`} />
          </button>

        {customLinksOpen && (
        <div className="px-5 pb-5 space-y-3">
          {/* The created-links list has its own inner collapse toggle. */}
          {data.links.length > 0 && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setLinksListOpen((v) => !v)}
                aria-expanded={linksListOpen}
                aria-label={linksListOpen ? 'Hide your links' : 'Show your links'}
                className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-text-muted hover:bg-surface-alt transition-colors shrink-0"
              >
                {data.links.length} {data.links.length === 1 ? 'link' : 'links'}
                <ChevronDown size={16} className={`transition-transform ${linksListOpen ? 'rotate-180' : ''}`} />
              </button>
            </div>
          )}

          {/* Your created links — pinned right under the header, collapsible via the chevron above. */}
          {data.links.length > 0 && linksListOpen && (
            <div className="space-y-3">
              {[...data.links]
                .sort((a, b) => (a.id === justCreatedId ? -1 : b.id === justCreatedId ? 1 : 0))
                .map((link) => {
            const open = openLinks.has(link.id)
            const isNew = link.id === justCreatedId
            return (
              <div key={link.id} className={`bg-surface-alt rounded-xl border overflow-hidden ${isNew ? 'border-primary ring-2 ring-primary/30' : 'border-border'}`}>
                {/* Collapsed header — tap to expand the link's share links + stats */}
                <div className="flex items-center">
                  <button
                    type="button"
                    onClick={() => toggleLink(link.id)}
                    aria-expanded={open}
                    className="flex-1 min-w-0 flex items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-surface/60 transition-colors"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="text-base font-mono font-bold tracking-wider text-text-primary truncate">{link.code}</span>
                      {isNew && <span className="flex-shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-primary">New</span>}
                      {link.label && <span className="text-xs text-text-muted truncate">{link.label}</span>}
                      <span className="text-[11px] text-text-muted flex-shrink-0">· {link.referredCount} referred</span>
                    </span>
                    <ChevronDown size={18} className={`text-text-muted flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
                  </button>
                  <button
                    onClick={() => handleDeleteLink(link)}
                    disabled={busyLink === link.id}
                    className="px-3 py-2.5 text-text-muted hover:text-danger disabled:opacity-50 flex-shrink-0"
                    aria-label={`Delete ${link.code}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>

                {open && (
                  <div className="px-3 pb-3 space-y-2 border-t border-border pt-3">
                    {/* Both share links for this code — Telegram (one-tap auto-auth) + Website.
                        Both carry the SAME code, so either one credits the affiliate. */}
                    <CustomLinkShare code={link.code} />
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div><p className="text-text-muted">Friend discount</p><p className="font-semibold text-success">{link.userDiscountPct}%</p></div>
                      <div><p className="text-text-muted">You earn</p><p className="font-semibold text-primary">{link.commissionPct}%</p></div>
                      <div><p className="text-text-muted">Referred</p><p className="font-semibold text-text-primary">{link.referredCount}</p></div>
                    </div>
                    {caps && editSplit?.id !== link.id && (
                      <Button size="sm" variant="ghost" onClick={() => setEditSplit({ id: link.id, userDiscountPct: String(link.userDiscountPct), commissionPct: String(link.commissionPct) })} disabled={busyLink === link.id}>Edit split</Button>
                    )}
                    {caps && editSplit?.id === link.id && (
                      <div className="rounded-lg border border-border bg-surface p-3 space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                          <SplitField label="Audience discount %" value={editSplit.userDiscountPct} onChange={(v) => setEditSplit({ ...editSplit, userDiscountPct: v })} />
                          <SplitField label="Your commission %" value={editSplit.commissionPct} onChange={(v) => setEditSplit({ ...editSplit, commissionPct: v })} />
                        </div>
                        <p className="text-[11px] text-text-muted">Discount + commission must be ≤ {caps.maxMarginPct}% (your allowance).</p>
                        <div className="flex gap-2">
                          <Button size="sm" variant="primary" onClick={() => handleSaveSplit(link)} disabled={busyLink === link.id}>{busyLink === link.id ? <Spinner size="sm" /> : 'Save'}</Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditSplit(null)} disabled={busyLink === link.id}>Cancel</Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
            </div>
          )}

          <p className="text-xs text-text-muted">
            {caps
              ? `You're an approved affiliate. Each link splits your ${caps.maxMarginPct}% margin allowance between an audience discount (min ${caps.minUserDiscountPct}%) and your own commission.`
              : `Create up to ${policy.maxLinks} named links — each gives your friend ${policy.userDiscountPct}% off their gas fee and earns you ${policy.commissionPct}%, paid in USDT.`}
          </p>

          {policy.canCreate ? (
            <div className="space-y-2">
              <label className="block text-[11px] font-semibold text-text-secondary">Your link name (this becomes the shareable link)</label>
              <Input
                value={newCode}
                onChange={(e) => setNewCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20))}
                placeholder="e.g. CWFTRADER"
                className="uppercase font-mono tracking-wider"
                maxLength={20}
              />
              {newCode.trim().length >= 3 ? (
                <p className="truncate text-[11px] text-text-muted" title={shareUrl(newCode.trim())}>
                  Your link: <span className="text-text-secondary">{shareUrl(newCode.trim())}</span>
                </p>
              ) : (
                <p className="text-[11px] text-text-muted">3–20 letters or numbers — whatever you type here is your link. Leave blank for a random code.</p>
              )}
              {caps && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <SplitField label="Audience discount %" hint={`min ${caps.minUserDiscountPct}%`} value={newDiscount} onChange={setNewDiscount} placeholder={String(caps.minUserDiscountPct)} />
                    <SplitField label="Your commission %" value={newCommission} onChange={setNewCommission} placeholder={String(Math.max(0, caps.maxMarginPct - (Number(newDiscount) || caps.minUserDiscountPct)))} />
                  </div>
                  <p className="text-[11px] text-text-muted">Discount + commission must be ≤ {caps.maxMarginPct}% (your allowance). Both come from the platform margin only.</p>
                </>
              )}
              <Button
                variant="secondary"
                className="w-full"
                onClick={caps ? handleCreateAffiliate : handleCreateCustom}
                disabled={creating || (newCode.trim().length > 0 && newCode.trim().length < 3)}
              >
                {creating ? <Spinner size="sm" /> : `Create link (${policy.used}/${policy.maxLinks})`}
              </Button>
            </div>
          ) : policy.cooldownUntil ? (
            <p className="text-xs text-text-muted">You can add a new link after {new Date(policy.cooldownUntil).toLocaleDateString()}.</p>
          ) : (
            <p className="text-xs text-text-muted">You&apos;ve reached your {policy.maxLinks}-link limit. Delete a link to create another.</p>
          )}
        </div>
        )}
        </div>
      )}

      {/* Affiliate program — application / status (for higher commission tiers), collapsible */}
      {data.enabled && data.status !== 'approved' && (
        <div className="bg-surface shadow-card border border-border rounded-xl overflow-hidden">
          <button
            type="button"
            onClick={() => setShowAffiliate((v) => !v)}
            className="w-full flex items-center justify-between px-5 py-3 hover:bg-surface-alt transition-colors"
            aria-expanded={showAffiliate}
          >
            <span className="flex items-center gap-2 text-sm font-bold text-text-primary">
              <Gift size={16} className="text-primary" />
              Become an affiliate
              {data.status === 'pending' && <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400">Under review</span>}
            </span>
            <ChevronDown size={18} className={`text-text-muted transition-transform ${showAffiliate ? 'rotate-180' : ''}`} />
          </button>
          {showAffiliate && (
            <div className="px-5 pb-5 pt-1 space-y-3 border-t border-border">
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
        </div>
      )}

      {/* Were you referred? — single instance, collapsible */}
      {sum.enabled && !sum.boundToReferrer && (
        <div className="bg-surface shadow-card border border-border rounded-xl overflow-hidden">
          <button
            type="button"
            onClick={() => setShowWasReferred((v) => !v)}
            className="w-full flex items-center justify-between px-5 py-3 hover:bg-surface-alt transition-colors"
            aria-expanded={showWasReferred}
          >
            <span className="text-sm font-bold text-text-primary">Were you referred?</span>
            <ChevronDown size={18} className={`text-text-muted transition-transform ${showWasReferred ? 'rotate-180' : ''}`} />
          </button>
          {showWasReferred && (
            <div className="px-5 pb-5 pt-1 space-y-3 border-t border-border">
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

/** Both share links (Telegram + Website) for a single custom code, each copyable.
 *  Mirrors the primary code's dual links so affiliates can share whichever fits. */
function CustomLinkShare({ code }: { code: string }) {
  const { telegram, web } = buildReferralLinks(code)
  return (
    <div className="space-y-1.5">
      {telegram && (
        <div className="flex items-center gap-2 rounded-lg border border-[#229ED9]/30 bg-surface px-2.5 py-1.5">
          <Send size={14} className="text-[#229ED9] shrink-0" aria-hidden />
          <span className="truncate text-[11px] text-text-muted flex-1" title={telegram}>{telegram}</span>
          <CopyButton text={telegram} />
        </div>
      )}
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5">
        <Globe size={14} className="text-primary shrink-0" aria-hidden />
        <span className="truncate text-[11px] text-text-muted flex-1" title={web}>{web}</span>
        <CopyButton text={web} />
      </div>
    </div>
  )
}

/** Small labelled percent input used by the affiliate split editor (create + edit). */
function SplitField({ label, hint, value, placeholder, onChange }: { label: string; hint?: string; value: string; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold text-text-secondary">{label}{hint ? <span className="text-text-muted font-normal"> ({hint})</span> : null}</label>
      <input
        type="number"
        inputMode="decimal"
        min={0}
        max={100}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
      />
    </div>
  )
}
