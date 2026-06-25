'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { gasApi } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { toast } from '@/lib/toast'
import { LoadingState } from '@/components/ui/LoadingState'
import { Button } from '@/components/ui/Button'
import { validateAddress } from '../../_components/GasPrimitives'
import { ArrowLeft, Gift, CheckCircle2 } from 'lucide-react'

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
        <div className="rounded-xl border border-border bg-surface p-5 space-y-4">
          <div className="text-center">
            <p className="text-xs text-text-muted">Sponsored by</p>
            <p className="text-base font-bold text-text-primary">{campaign.kolLabel}</p>
          </div>

          <div className="grid grid-cols-2 gap-3 text-center">
            <div className="rounded-lg bg-surface-alt p-3">
              <p className="text-lg font-bold text-primary">{campaign.amountNative} {campaign.tokenSymbol}</p>
              <p className="text-[11px] text-text-muted">per winner</p>
            </div>
            <div className="rounded-lg bg-surface-alt p-3">
              <p className="text-lg font-bold text-text-primary">{campaign.winnerCount}</p>
              <p className="text-[11px] text-text-muted">winners · {campaign.entryCount} entered</p>
            </div>
          </div>

          {entered ? (
            <div className="rounded-lg border border-green-500/40 bg-green-500/5 p-4 text-center">
              <CheckCircle2 className="w-6 h-6 mx-auto text-green-600 dark:text-green-400" />
              <p className="mt-1 text-sm font-semibold text-green-700 dark:text-green-300">You&apos;re entered!</p>
              <p className="text-xs text-text-muted mt-0.5">Winners are drawn after the entry period. If you win, gas is sent to your address automatically.</p>
            </div>
          ) : !campaign.open ? (
            <div className="rounded-lg bg-surface-alt p-4 text-center text-sm text-text-muted">This giveaway is closed.</div>
          ) : !user ? (
            <div className="text-center space-y-2">
              <p className="text-xs text-text-muted">Log in to enter this giveaway.</p>
              <Button size="sm" variant="primary" onClick={() => router.push('/login')}>Log in</Button>
            </div>
          ) : (
            <div className="space-y-2">
              <label className="text-xs font-semibold text-text-primary block">Your {campaign.networkLabel} receiving address
                <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder={`Your ${campaign.tokenSymbol} address`} className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm font-mono" />
              </label>
              {campaign.requireKyc && <p className="text-[11px] text-amber-600 dark:text-amber-400">Identity verification (KYC) is required to enter.</p>}
              <Button size="sm" variant="primary" onClick={enter} disabled={submitting || !address.trim()} className="w-full">
                {submitting ? 'Entering…' : 'Enter Giveaway'}
              </Button>
              <p className="text-[11px] text-text-muted text-center">Free — entering costs nothing. Winners receive gas at no charge.</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
