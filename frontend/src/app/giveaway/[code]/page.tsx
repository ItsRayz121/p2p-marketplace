'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Image from 'next/image'
import { useAuth } from '@/hooks/useAuth'
import { toast } from '@/lib/toast'
import { LoadingState } from '@/components/ui/LoadingState'
import { Button } from '@/components/ui/Button'
import { promoGiveawayApi, type PromoGiveawayPublic, type PromoParticipant } from '@/lib/promoGiveaway'
import { ArrowLeft, Gift, CheckCircle2, ExternalLink, Users, Clock, Trophy, ChevronDown } from 'lucide-react'

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
  const [entrantName, setEntrantName] = useState('')
  const [whatsapp, setWhatsapp] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [entered, setEntered] = useState(false)
  const [participants, setParticipants] = useState<PromoParticipant[]>([])
  const [participantsOpen, setParticipantsOpen] = useState(false)

  const loadParticipants = useCallback(async () => {
    try {
      setParticipants(await promoGiveawayApi.participants(code))
    } catch { /* non-fatal — list just stays empty */ }
  }, [code])

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const data = await promoGiveawayApi.publicInfo(code)
      setG(data)
      setEntered(data.alreadyEntered)
      // If already entered, the tasks were done — pre-check so the address can be updated,
      // and pre-fill the address they previously submitted.
      if (data.alreadyEntered) {
        setChecked(Object.fromEntries(data.tasks.map((t) => [t.id, true])))
        if (data.myAddress) setAddress(data.myAddress)
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Giveaway not found')
    } finally {
      setLoading(false)
    }
  }, [code])

  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadParticipants() }, [loadParticipants])

  const requiredIds = (g?.tasks ?? []).filter((t) => t.required).map((t) => t.id)
  const allRequiredDone = requiredIds.every((id) => checked[id])
  const collectOk = (!g?.collectName || entrantName.trim().length > 0) && (!g?.collectWhatsapp || whatsapp.trim().length > 0)
  const canSubmit = allRequiredDone && collectOk && address.trim().length >= 4 && !submitting

  async function enter() {
    if (!g) return
    if (!canSubmit) {
      if (!allRequiredDone) toast.error('Please complete all required tasks first.')
      else if (g.collectName && !entrantName.trim()) toast.error('Please enter your name.')
      else if (g.collectWhatsapp && !whatsapp.trim()) toast.error('Please enter your WhatsApp number.')
      else if (address.trim().length < 4) toast.error('Enter a valid wallet address.')
      return
    }
    setSubmitting(true)
    try {
      const ackTasks = Object.entries(checked).filter(([, v]) => v).map(([k]) => k)
      await promoGiveawayApi.enter(g.code, {
        receivingAddress: address.trim(),
        ackTasks,
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(entrantName.trim() ? { entrantName: entrantName.trim() } : {}),
        ...(whatsapp.trim() ? { whatsapp: whatsapp.trim() } : {}),
      })
      const wasEntered = entered
      setEntered(true)
      toast.success(wasEntered ? 'Address updated ✅' : "You're entered! 🎉 The organizer will contact winners.")
      void loadParticipants()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not enter')
    } finally {
      setSubmitting(false)
    }
  }

  const deadlinePassed = g?.entryDeadline ? new Date(g.entryDeadline).getTime() < Date.now() : false
  const closed = !!g && (!g.open || g.status !== 'open' || deadlinePassed)
  const rewardText = g ? [g.rewardAmount, g.rewardToken].filter(Boolean).join(' ').trim() : ''

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

            {/* Reward pill (display-only) */}
            {rewardText && (
              <div className="inline-flex items-center gap-2 rounded-xl bg-primary/10 border border-primary/20 px-3 py-2">
                <Gift className="w-4 h-4 text-primary" />
                <span className="text-sm font-bold text-primary">{rewardText}</span>
                {g.rewardChain && <span className="text-[11px] text-text-muted">on {g.rewardChain}</span>}
                <span className="text-[11px] text-text-muted">per winner</span>
              </div>
            )}

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
                <div className="space-y-2.5">
                  <p className="text-sm font-semibold text-text-primary">Complete these to enter</p>
                  {g.tasks.map((t, i) => (
                    <TaskRow
                      key={t.id}
                      index={i + 1}
                      label={t.label}
                      url={t.url}
                      required={t.required}
                      checked={!!checked[t.id]}
                      onToggle={(v) => setChecked((prev) => ({ ...prev, [t.id]: v }))}
                    />
                  ))}
                </div>
              )}

              {/* Entrant details */}
              <div className="space-y-3">
                {g.collectName && (
                  <Field label="Your name">
                    <input
                      value={entrantName}
                      onChange={(e) => setEntrantName(e.target.value)}
                      placeholder="Your full name"
                      className={inputCls}
                    />
                  </Field>
                )}
                {g.collectWhatsapp && (
                  <Field label="WhatsApp number">
                    <input
                      value={whatsapp}
                      onChange={(e) => setWhatsapp(e.target.value)}
                      placeholder="e.g. +92 300 1234567"
                      inputMode="tel"
                      className={inputCls}
                    />
                  </Field>
                )}
                <AddressField label={g.addressLabel} value={address} onChange={setAddress} />
                <Field label="Email (optional — for winner contact)">
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className={inputCls}
                  />
                </Field>
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

          {/* Participants (live) — everyone who has entered */}
          {participants.length > 0 && (
            <div className="bg-surface border border-border rounded-2xl overflow-hidden">
              <button
                onClick={() => setParticipantsOpen((v) => !v)}
                className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-surface-alt transition-colors"
                aria-expanded={participantsOpen}
              >
                <span className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
                  <Users className="w-4 h-4 text-primary" /> Participants ({participants.length})
                </span>
                <ChevronDown className={`w-4 h-4 text-text-muted transition-transform ${participantsOpen ? 'rotate-180' : ''}`} />
              </button>
              {participantsOpen && (
                <div className="border-t border-border max-h-72 overflow-y-auto divide-y divide-border">
                  {participants.map((p, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 px-5 py-2.5 text-sm">
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="text-text-primary truncate">{p.username}</span>
                        {p.status === 'sent' && <span className="text-[10px] font-bold uppercase text-success shrink-0">Won</span>}
                      </span>
                      <span className="font-mono text-xs text-text-muted shrink-0">{p.address}</span>
                    </div>
                  ))}
                </div>
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

const inputCls = 'mt-1 w-full px-3 py-2 border border-border rounded-lg text-sm bg-canvas text-text-primary focus:outline-none focus:ring-2 focus:ring-primary'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium text-text-muted">{label}</label>
      {children}
    </div>
  )
}

/** One professional task row: numbered badge, label, and a right-aligned Open button. */
function TaskRow({
  index, label, url, required, checked, onToggle,
}: {
  index: number
  label: string
  url?: string
  required: boolean
  checked: boolean
  onToggle: (v: boolean) => void
}) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-xl border border-border bg-canvas">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onToggle(e.target.checked)}
        className="w-4 h-4 accent-primary flex-shrink-0"
        aria-label={label}
      />
      <span className="flex items-center justify-center w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex-shrink-0">{index}</span>
      <span className="flex-1 min-w-0 text-sm text-text-primary break-words">
        {label}
        {!required && <span className="text-text-muted"> (optional)</span>}
      </span>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/10 transition-colors flex-shrink-0"
        >
          Open <ExternalLink className="w-3 h-3" />
        </a>
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
