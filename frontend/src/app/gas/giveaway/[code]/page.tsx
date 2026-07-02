'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Image from 'next/image'
import { gasApi } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { toast } from '@/lib/toast'
import { LoadingState } from '@/components/ui/LoadingState'
import { Button } from '@/components/ui/Button'
import { validateAddress } from '../../_components/GasPrimitives'
import { ArrowLeft, Gift, CheckCircle2, Send, Users, Trophy } from 'lucide-react'

type Campaign = Awaited<ReturnType<typeof gasApi.getGiveaway>>

export default function GiveawayEntryPage() {
  const router = useRouter()
  const params = useParams()
  const code = String(params.code ?? '')
  const { user } = useAuth()

  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [entered, setEntered] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const c = await gasApi.getGiveaway(code)
      setCampaign(c)
      setEntered(c.alreadyEntered)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Giveaway not found')
    } finally {
      setLoading(false)
    }
  }, [code])

  useEffect(() => { void load() }, [load])

  async function enter() {
    if (!campaign) return
    if (!validateAddress(address, campaign.addressType)) {
      toast.error(`Enter a valid ${campaign.networkLabel} address`); return
    }
    setSubmitting(true)
    try {
      await gasApi.enterGiveaway({ code: campaign.code, receivingAddress: address.trim() })
      setEntered(true)
      toast.success('You\'re entered! Winners are drawn after the entry period.')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not enter')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-md mx-auto px-4 py-6 space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={() => router.push('/gas')} className="p-2 rounded-lg hover:bg-surface-alt"><ArrowLeft className="w-4 h-4" /></button>
        <div className="flex items-center gap-2">
          <Gift className="w-5 h-5 text-primary" />
          <h1 className="text-lg font-bold text-text-primary">Gas Giveaway</h1>
        </div>
      </div>

      {loading && <LoadingState message="Loading…" />}
      {error && !loading && (
        <div className="rounded-xl border border-border bg-surface p-6 text-center text-sm text-text-muted">{error}</div>
      )}

      {!loading && campaign && (
        <div className="space-y-4">
          {/* Banner */}
          {campaign.thumbnailUrl && (
            <div className="relative w-full aspect-[16/9] rounded-2xl overflow-hidden border border-border bg-canvas">
              <Image src={campaign.thumbnailUrl} alt={campaign.kolLabel} fill sizes="(max-width:768px) 100vw, 28rem" className="object-cover" unoptimized />
            </div>
          )}

          <div className="rounded-2xl border border-border bg-surface p-5 space-y-4">
            {/* Sponsored by — prominent */}
            <div className="flex flex-col items-center gap-2 text-center">
              <span className="flex items-center justify-center w-12 h-12 rounded-full bg-primary/10 text-primary text-lg font-black">
                {campaign.kolLabel.trim().charAt(0).toUpperCase() || 'R'}
              </span>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-text-muted">Gas giveaway sponsored by</p>
                <p className="text-lg font-black text-text-primary">{campaign.kolLabel}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 text-center">
              <div className="rounded-xl bg-primary/5 border border-primary/15 p-3">
                <p className="text-lg font-bold text-primary">{campaign.amountNative} {campaign.tokenSymbol}</p>
                <p className="text-[11px] text-text-muted">per winner{campaign.amountUsd != null ? ` · ≈ $${campaign.amountUsd.toFixed(campaign.amountUsd < 1 ? 4 : 2)}` : ''}</p>
              </div>
              <div className="rounded-xl bg-surface-alt border border-border p-3">
                <p className="text-lg font-bold text-text-primary">{campaign.winnerCount}</p>
                <p className="inline-flex items-center justify-center gap-1 text-[11px] text-text-muted"><Users className="w-3 h-3" />{campaign.winnerCount === 1 ? 'winner' : 'winners'} · {campaign.entryCount} entered</p>
              </div>
            </div>

          {entered ? (
            <div className="rounded-lg border border-green-500/40 bg-green-500/5 p-4 text-center">
              <CheckCircle2 className="w-6 h-6 mx-auto text-green-600 dark:text-green-400" />
              <p className="mt-1 text-sm font-semibold text-green-700 dark:text-green-300">You&apos;re already entered!</p>
              <p className="text-xs text-text-muted mt-0.5">No need to enter again — winners are drawn after the entry period. If you win, gas is sent to your address automatically. Check back here to see the winners.</p>
            </div>
          ) : !campaign.open ? (
            <div className="rounded-lg bg-surface-alt p-4 text-center text-sm text-text-muted">This giveaway is closed.</div>
          ) : !user ? (
            <div className="text-center space-y-2">
              <p className="text-xs text-text-muted">Log in to enter this giveaway.</p>
              <Button size="sm" variant="primary" onClick={() => router.push('/login')}>Log in</Button>
            </div>
          ) : campaign.requireKyc && user.kycLevel === 'none' ? (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-center space-y-2">
              <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">Identity verification required</p>
              <p className="text-xs text-text-muted">Complete a quick identity verification (KYC) to enter this giveaway.</p>
              <Button size="sm" variant="primary" onClick={() => router.push('/kyc')}>Complete KYC</Button>
            </div>
          ) : (
            <div className="space-y-2">
              <label className="text-xs font-semibold text-text-primary block">Your {campaign.networkLabel} receiving address
                <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder={`Your ${campaign.tokenSymbol} address`} className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm font-mono" />
              </label>
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                A platform username{campaign.requireKyc ? ' and identity verification (KYC)' : ''} {campaign.requireKyc ? 'are' : 'is'} required to enter.
              </p>
              <Button size="sm" variant="primary" onClick={enter} disabled={submitting || !address.trim()} className="w-full">
                {submitting ? 'Entering…' : 'Enter Giveaway'}
              </Button>
              <p className="text-[11px] text-text-muted text-center">Free — entering costs nothing. Winners receive gas at no charge.</p>
            </div>
          )}
          </div>

          {/* Share on Telegram */}
          <a
            href={`https://t.me/share/url?url=${encodeURIComponent(typeof window !== 'undefined' ? window.location.href : '')}&text=${encodeURIComponent(`🎁 Free ${campaign.amountNative} ${campaign.tokenSymbol} gas giveaway by ${campaign.kolLabel} on RupChain`)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full rounded-xl border border-[#229ED9]/40 bg-[#229ED9]/5 px-4 py-2.5 text-sm font-medium text-[#229ED9] hover:bg-[#229ED9]/10 transition-colors"
          >
            <Send className="w-4 h-4" /> Share on Telegram
          </a>
        </div>
      )}

      {/* Public winners list — transparency once a draw has happened */}
      {!loading && campaign && campaign.winners.length > 0 && (
        <div className="rounded-xl border border-border bg-surface p-5 space-y-3">
          <h2 className="flex items-center gap-1.5 text-sm font-bold text-text-primary"><Trophy className="w-4 h-4 text-primary" /> Winners ({campaign.winners.length})</h2>
          <div className="space-y-2">
            {campaign.winners.map((w, i) => (
              <div key={i} className="flex items-center gap-2 text-xs border-b border-border last:border-0 pb-2 last:pb-0">
                <span className="font-medium text-text-primary truncate flex-1 min-w-0">{w.username ?? 'Winner'}</span>
                <span className="font-mono text-text-muted truncate hidden sm:inline" style={{ maxWidth: 130 }} title={w.address}>{w.address.slice(0, 8)}…{w.address.slice(-6)}</span>
                {w.txHash ? (
                  w.explorerUrl ? (
                    <a href={w.explorerUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline shrink-0">view tx</a>
                  ) : (
                    <span className="font-mono text-text-muted shrink-0" title={w.txHash}>{w.txHash.slice(0, 6)}…{w.txHash.slice(-4)}</span>
                  )
                ) : (
                  <span className="text-text-muted shrink-0">{w.delivered ? 'delivered' : 'pending'}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
