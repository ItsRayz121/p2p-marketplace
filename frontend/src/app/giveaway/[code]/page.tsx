'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Image from 'next/image'
import { useAuth } from '@/hooks/useAuth'
import { toast } from '@/lib/toast'
import { LoadingState } from '@/components/ui/LoadingState'
import { Button } from '@/components/ui/Button'
import { promoGiveawayApi, type PromoGiveawayPublic } from '@/lib/promoGiveaway'
import { ArrowLeft, Gift, CheckCircle2, ExternalLink, Users, Clock, Trophy } from 'lucide-react'

export default function PromoGiveawayEntryPage() {
  const router = useRouter()
  const params = useParams()
  const code = String(params.code ?? '')
  const { isAuthenticated } = useAuth()

  const [g, setG] = useState<PromoGiveawayPublic | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [address, setAddress] = useState('')
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [entered, setEntered] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const data = await promoGiveawayApi.publicInfo(code)
      setG(data)
      setEntered(data.alreadyEntered)
      // If already entered, the tasks were done — pre-check so the address can be updated.
      if (data.alreadyEntered) {
        setChecked(Object.fromEntries(data.tasks.map((t) => [t.id, true])))
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Giveaway not found')
    } finally {
      setLoading(false)
    }
  }, [code])

  useEffect(() => { void load() }, [load])

  const requiredIds = (g?.tasks ?? []).filter((t) => t.required).map((t) => t.id)
  const allRequiredDone = requiredIds.every((id) => checked[id])
  const canSubmit = allRequiredDone && address.trim().length >= 4 && !submitting

  async function enter() {
    if (!g) return
    if (!canSubmit) {
      if (!allRequiredDone) toast.error('Please complete all required tasks first.')
      else if (address.trim().length < 4) toast.error('Enter a valid wallet address.')
      return
    }
    setSubmitting(true)
    try {
      const ackTasks = Object.entries(checked).filter(([, v]) => v).map(([k]) => k)
      await promoGiveawayApi.enter(g.code, { receivingAddress: address.trim(), ackTasks, ...(email.trim() ? { email: email.trim() } : {}) })
      setEntered(true)
      toast.success("You're entered! 🎉 The organizer will contact winners.")
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not enter')
    } finally {
      setSubmitting(false)
    }
  }

  const deadlinePassed = g?.entryDeadline ? new Date(g.entryDeadline).getTime() < Date.now() : false
  const closed = !!g && (!g.open || g.status !== 'open' || deadlinePassed)

  return (
    <div className="max-w-md mx-auto px-4 py-6 space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={() => router.push('/')} className="p-2 rounded-lg hover:bg-surface-alt" aria-label="Back">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-2">
          <Gift className="w-5 h-5 text-primary" />
          <h1 className="text-lg font-bold text-text-primary">Giveaway</h1>
        </div>
      </div>

      {loading && <LoadingState message="Loading…" />}

      {error && !loading && (
        <div className="bg-surface border border-border rounded-xl p-6 text-center">
          <p className="text-sm text-text-muted">{error}</p>
        </div>
      )}

      {g && !loading && (
        <div className="space-y-5">
          {/* Thumbnail banner */}
          {g.thumbnailUrl && (
            <div className="relative w-full aspect-[16/9] rounded-2xl overflow-hidden border border-border bg-canvas">
              <Image src={g.thumbnailUrl} alt={g.title} fill sizes="(max-width:768px) 100vw, 28rem" className="object-cover" unoptimized />
            </div>
          )}

          {/* Header card */}
          <div className="bg-surface border border-border rounded-2xl p-5 space-y-3">
            <div>
              <h2 className="text-xl font-black text-text-primary break-words">{g.title}</h2>
              {g.createdByName && <p className="text-xs text-text-muted mt-0.5">by {g.createdByName}</p>}
            </div>
            {g.description && <p className="text-sm text-text-primary whitespace-pre-wrap break-words">{g.description}</p>}
            <div className="flex flex-wrap gap-3 text-xs text-text-muted">
              <span className="inline-flex items-center gap-1"><Users className="w-3.5 h-3.5" />{g.entryCount} entered</span>
              <span className="inline-flex items-center gap-1">
                <Gift className="w-3.5 h-3.5" />{g.rewardAll ? 'Everyone who enters wins' : `${g.winnerCount} winner${g.winnerCount === 1 ? '' : 's'}`}
              </span>
              {g.entryDeadline && (
                <span className="inline-flex items-center gap-1"><Clock className="w-3.5 h-3.5" />Ends {new Date(g.entryDeadline).toLocaleString()}</span>
              )}
            </div>
          </div>

          {closed ? (
            <div className="bg-surface border border-border rounded-2xl p-6 text-center">
              <p className="font-semibold text-text-primary">This giveaway has closed</p>
              <p className="text-sm text-text-muted mt-1">Entries are no longer being accepted.</p>
            </div>
          ) : entered ? (
            <MyStatusCard
              status={g.myStatus}
              note={g.myNote}
              addressLabel={g.addressLabel}
              address={address}
              setAddress={setAddress}
              onUpdate={enter}
              updating={submitting}
            />
          ) : (
            <div className="bg-surface border border-border rounded-2xl p-5 space-y-4">
              {/* Tasks */}
              {g.tasks.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-text-primary">Complete these to enter</p>
                  {g.tasks.map((t) => (
                    <label key={t.id} className="flex items-start gap-3 p-3 rounded-xl border border-border bg-canvas cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!checked[t.id]}
                        onChange={(e) => setChecked((prev) => ({ ...prev, [t.id]: e.target.checked }))}
                        className="mt-0.5 w-4 h-4 accent-primary flex-shrink-0"
                      />
                      <span className="flex-1 min-w-0">
                        <span className="text-sm text-text-primary break-words">
                          {t.label}
                          {!t.required && <span className="text-text-muted"> (optional)</span>}
                        </span>
                        {t.url && (
                          <a
                            href={t.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                          >
                            Open <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              )}

              {/* Address + email */}
              <div className="space-y-3">
                <AddressField label={g.addressLabel} value={address} onChange={setAddress} />
                <div>
                  <label className="text-xs font-medium text-text-muted">Email (optional — for winner contact)</label>
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="mt-1 w-full px-3 py-2 border border-border rounded-lg text-sm bg-canvas text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
              </div>

              {g.requireKyc && (
                <p className="text-xs text-amber-600 dark:text-amber-400">This giveaway requires a verified (KYC) account to enter.</p>
              )}

              {isAuthenticated ? (
                <Button onClick={enter} loading={submitting} disabled={!canSubmit} className="w-full">
                  {allRequiredDone ? 'Submit entry' : 'Complete required tasks'}
                </Button>
              ) : (
                <Button onClick={() => router.push(`/login?next=/giveaway/${g.code}`)} className="w-full">
                  Log in to enter
                </Button>
              )}
            </div>
          )}

          {/* Winners (transparency) — entries the organizer marked as sent */}
          {g.winners.length > 0 && (
            <div className="bg-surface border border-border rounded-2xl p-5">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-text-primary mb-3">
                <Trophy className="w-4 h-4 text-primary" /> Winners ({g.winners.length})
              </p>
              <div className="divide-y divide-border">
                {g.winners.map((w, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 py-2 text-sm">
                    <span className="text-text-primary truncate">{w.username || 'Anonymous'}</span>
                    <span className="font-mono text-xs text-text-muted">{w.address}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Proof sheet uploaded by the organizer */}
          {g.resultsSheetUrl && (
            <div className="bg-surface border border-border rounded-2xl p-5 space-y-2">
              <p className="text-sm font-semibold text-text-primary">Distribution proof</p>
              <a href={g.resultsSheetUrl} target="_blank" rel="noopener noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={g.resultsSheetUrl} alt="Distribution proof" className="w-full rounded-lg border border-border" />
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function MyStatusCard({
  status, note, addressLabel, address, setAddress, onUpdate, updating,
}: {
  status: string | null
  note: string | null
  addressLabel: string | null
  address: string
  setAddress: (v: string) => void
  onUpdate: () => void
  updating: boolean
}) {
  const map: Record<string, { cls: string; title: string; sub: string }> = {
    sent: { cls: 'bg-success/5 border-success/30', title: '🎉 Reward sent!', sub: 'The organizer marked your reward as sent.' },
    rejected: { cls: 'bg-danger/5 border-danger/30', title: 'Not selected', sub: note || 'Your entry was not selected.' },
    pending: { cls: 'bg-amber-500/5 border-amber-500/30', title: 'Pending review', sub: 'The organizer is reviewing entries.' },
    entered: { cls: 'bg-success/5 border-success/30', title: "You're entered! 🎉", sub: 'The organizer will reach out to winners.' },
  }
  const s = map[status ?? 'entered'] ?? map.entered!
  const canUpdate = status !== 'sent' && status !== 'rejected'
  return (
    <div className={`border rounded-2xl p-6 text-center space-y-2 ${s.cls}`}>
      <CheckCircle2 className="w-10 h-10 text-success mx-auto" />
      <p className="font-semibold text-text-primary">{s.title}</p>
      <p className="text-sm text-text-muted">{s.sub}</p>
      {canUpdate && (
        <div className="text-left space-y-2 pt-2">
          <AddressField label={addressLabel} value={address} onChange={setAddress} />
          <Button onClick={onUpdate} loading={updating} disabled={address.trim().length < 4} className="w-full">Update address</Button>
        </div>
      )}
    </div>
  )
}

function AddressField({ label, value, onChange }: { label: string | null; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="text-xs font-medium text-text-muted">{label?.trim() || 'Your wallet address'}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={label?.trim() || 'Paste your wallet address'}
        className="mt-1 w-full px-3 py-2 border border-border rounded-lg text-sm bg-canvas text-text-primary font-mono focus:outline-none focus:ring-2 focus:ring-primary"
      />
    </div>
  )
}
