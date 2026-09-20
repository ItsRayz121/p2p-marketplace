'use client'
import { useState } from 'react'
import { adminApi } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { Search, X, ArrowRight, ShieldAlert, EraserIcon } from 'lucide-react'

interface PickedUser {
  id: string
  username: string
  fullName: string
  email: string
  telegramId: string | null
}

interface SearchHit {
  id: string
  username: string
  fullName: string
  email: string
  telegramId?: string | number | null
  isBanned?: boolean
  isSuspended?: boolean
}

// Debounced username/email/ID lookup, reusing the same /admin/users search the
// Users list uses. Click a result to pick it.
function AccountPicker({
  label,
  hint,
  picked,
  onPick,
  onClear,
}: {
  label: string
  hint: string
  picked: PickedUser | null
  onPick: (u: PickedUser) => void
  onClear: () => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [open, setOpen] = useState(false)

  async function search(q: string) {
    setQuery(q)
    if (q.trim().length < 2) { setResults([]); setOpen(false); return }
    setSearching(true)
    try {
      const { users } = await adminApi.getUsers({ search: q.trim(), limit: 6 })
      setResults(users as unknown as SearchHit[])
      setOpen(true)
    } catch {
      setResults([])
    } finally {
      setSearching(false)
    }
  }

  if (picked) {
    return (
      <div className="border border-border rounded-xl p-3 bg-surface-alt">
        <p className="text-xs text-text-muted mb-1">{label}</p>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="font-medium text-text-primary truncate">{picked.fullName} <span className="text-text-muted font-normal">@{picked.username}</span></p>
            <p className="text-xs text-text-muted truncate">{picked.email}{picked.telegramId ? ` · TG ${picked.telegramId}` : ''}</p>
          </div>
          <button type="button" onClick={onClear} className="text-text-muted hover:text-danger flex-shrink-0" aria-label="Clear">
            <X size={16} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="relative">
      <p className="text-xs text-text-muted mb-1">{label}</p>
      <Input
        placeholder={hint}
        value={query}
        leftIcon={<Search size={14} />}
        onChange={(e) => search(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && (
        <div className="absolute z-10 mt-1 w-full bg-surface border border-border rounded-lg shadow-lg max-h-64 overflow-y-auto">
          {searching && <p className="px-3 py-2 text-xs text-text-muted">Searching…</p>}
          {!searching && results.length === 0 && <p className="px-3 py-2 text-xs text-text-muted">No matches</p>}
          {results.map((u) => (
            <button
              key={u.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick({ id: u.id, username: u.username, fullName: u.fullName, email: u.email, telegramId: u.telegramId != null ? String(u.telegramId) : null })
                setOpen(false)
                setQuery('')
              }}
              className="w-full text-left px-3 py-2 hover:bg-surface-alt transition-colors border-b border-border last:border-0"
            >
              <p className="text-sm font-medium text-text-primary">{u.fullName} <span className="text-text-muted font-normal">@{u.username}</span></p>
              <p className="text-xs text-text-muted flex items-center gap-1.5">
                {u.email}
                {(u.isBanned || u.isSuspended) && <Badge variant="danger" size="sm">{u.isBanned ? 'Banned' : 'Suspended'}</Badge>}
              </p>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

type MergePreview = Awaited<ReturnType<typeof adminApi.previewIdentityMerge>>

export default function IdentityConflictsPage() {
  const [survivor, setSurvivor] = useState<PickedUser | null>(null)
  const [other, setOther] = useState<PickedUser | null>(null)
  const [preview, setPreview] = useState<MergePreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [mergeReason, setMergeReason] = useState('')
  const [acknowledgeFundsRisk, setAcknowledgeFundsRisk] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)
  const [mergeSuccess, setMergeSuccess] = useState<string | null>(null)
  const [confirmMerge, setConfirmMerge] = useState(false)
  const [merging, setMerging] = useState(false)

  const [eraseTarget, setEraseTarget] = useState<PickedUser | null>(null)
  const [eraseReason, setEraseReason] = useState('')
  const [eraseAcknowledgeFundsRisk, setEraseAcknowledgeFundsRisk] = useState(false)
  const [eraseNeedsFundsAck, setEraseNeedsFundsAck] = useState(false)
  const [eraseError, setEraseError] = useState<string | null>(null)
  const [eraseSuccess, setEraseSuccess] = useState<string | null>(null)
  const [confirmErase, setConfirmErase] = useState(false)
  const [erasing, setErasing] = useState(false)

  async function loadPreview(a: PickedUser, b: PickedUser) {
    // A freshly-loaded preview describes a NEW pair — any funds acknowledgment
    // the admin gave for a previously-picked pair must not silently carry over.
    setAcknowledgeFundsRisk(false)
    setPreviewLoading(true)
    setPreview(null)
    setMergeError(null)
    try {
      const data = await adminApi.previewIdentityMerge(a.id, b.id)
      setPreview(data)
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : 'Could not load preview')
    } finally {
      setPreviewLoading(false)
    }
  }

  function pickSurvivor(u: PickedUser) {
    setSurvivor(u)
    setMergeSuccess(null)
    setPreview(null)
    setAcknowledgeFundsRisk(false)
    if (other) loadPreview(u, other)
  }
  function pickOther(u: PickedUser) {
    setOther(u)
    setMergeSuccess(null)
    setPreview(null)
    setAcknowledgeFundsRisk(false)
    if (survivor) loadPreview(survivor, u)
  }
  function clearAll() {
    setSurvivor(null); setOther(null); setPreview(null); setMergeReason(''); setAcknowledgeFundsRisk(false); setMergeError(null)
  }

  async function doMerge() {
    if (!survivor || !other) return
    setMerging(true)
    setMergeError(null)
    try {
      await adminApi.mergeIdentity({
        survivorId: survivor.id,
        otherId: other.id,
        reason: mergeReason.trim(),
        ...(acknowledgeFundsRisk ? { acknowledgeFundsRisk: true } : {}),
      })
      setMergeSuccess(`${other.username} has been retired into ${survivor.username}.`)
      clearAll()
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : 'Merge failed')
    } finally {
      setMerging(false)
      setConfirmMerge(false)
    }
  }

  async function doErase() {
    if (!eraseTarget) return
    setErasing(true)
    setEraseError(null)
    try {
      await adminApi.eraseIdentity({
        userId: eraseTarget.id,
        reason: eraseReason.trim(),
        ...(eraseAcknowledgeFundsRisk ? { acknowledgeFundsRisk: true } : {}),
      })
      setEraseSuccess(`${eraseTarget.username}'s login identity has been erased — the email and Telegram id are now free to reuse.`)
      setEraseTarget(null)
      setEraseReason('')
      setEraseAcknowledgeFundsRisk(false)
      setEraseNeedsFundsAck(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erase failed'
      // The backend blocks on a non-zero wallet balance until the admin
      // explicitly acknowledges it — surface the checkbox so they can retry.
      if (message.includes('non-zero wallet balance')) setEraseNeedsFundsAck(true)
      setEraseError(message)
    } finally {
      setErasing(false)
      setConfirmErase(false)
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Identity Conflicts</h1>
        <p className="text-text-muted text-sm mt-0.5">
          Settings → Connect Telegram/Email never merges two accounts with real history — that&apos;s deliberate. Use these tools only for a
          verified support request where the same person genuinely owns both accounts.
        </p>
      </div>

      {/* ── Merge ── */}
      <div className="bg-surface border border-border rounded-xl p-4 space-y-4">
        <div className="flex items-center gap-2">
          <ShieldAlert size={16} className="text-danger" />
          <h2 className="font-semibold text-text-primary">Resolve a merge conflict</h2>
        </div>
        <p className="text-xs text-text-muted -mt-2">
          Pick the account to keep (it gains whichever identity field it&apos;s missing) and the account to retire (its history stays in the
          database for audit, but it can never log in again).
        </p>

        <div className="grid sm:grid-cols-[1fr_auto_1fr] gap-3 items-start">
          <AccountPicker label="Keep this account" hint="Search username, email or ID…" picked={survivor} onPick={pickSurvivor} onClear={() => { setSurvivor(null); setPreview(null); setAcknowledgeFundsRisk(false) }} />
          <div className="hidden sm:flex items-center justify-center pt-6 text-text-muted"><ArrowRight size={18} /></div>
          <AccountPicker label="Retire this account" hint="Search username, email or ID…" picked={other} onPick={pickOther} onClear={() => { setOther(null); setPreview(null); setAcknowledgeFundsRisk(false) }} />
        </div>

        {previewLoading && <p className="text-sm text-text-muted">Checking eligibility…</p>}

        {preview && (
          <div className="border border-border rounded-lg p-3 space-y-2 text-sm">
            <div className="flex flex-wrap gap-1.5">
              {preview.willTransferEmail && <Badge variant="info" size="sm">Transfers email: {preview.other.email}</Badge>}
              {preview.willTransferTelegram && <Badge variant="info" size="sm">Transfers Telegram: {preview.other.telegramId}</Badge>}
              {!preview.eligible && <Badge variant="danger" size="sm">Blocked</Badge>}
            </div>
            {preview.blockedReason && <p className="text-danger text-xs">{preview.blockedReason}</p>}
            {preview.otherHasWalletBalance && (
              <label className="flex items-start gap-2 text-xs text-warning bg-warning/10 border border-warning/20 rounded-lg p-2">
                <input type="checkbox" className="mt-0.5" checked={acknowledgeFundsRisk} onChange={(e) => setAcknowledgeFundsRisk(e.target.checked)} />
                <span>The retired account has a non-zero wallet balance that becomes inaccessible after masking. I&apos;ve confirmed the user moved their funds first.</span>
              </label>
            )}
          </div>
        )}

        {preview?.eligible && (
          <div className="space-y-2">
            <textarea
              value={mergeReason}
              onChange={(e) => setMergeReason(e.target.value)}
              rows={2}
              placeholder="Reason (min. 10 characters) — e.g. support ticket #, what the user confirmed"
              className="w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary resize-none"
            />
            <Button
              variant="danger"
              size="sm"
              disabled={mergeReason.trim().length < 10 || (preview.otherHasWalletBalance && !acknowledgeFundsRisk)}
              onClick={() => setConfirmMerge(true)}
            >
              Merge accounts
            </Button>
          </div>
        )}

        {mergeError && <div className="px-3 py-2 bg-danger/10 border border-danger/20 rounded-lg text-danger text-sm">{mergeError}</div>}
        {mergeSuccess && <div className="px-3 py-2 bg-success/10 border border-success/20 rounded-lg text-success text-sm">{mergeSuccess}</div>}
      </div>

      {/* ── Erase ── */}
      <div className="bg-surface border border-border rounded-xl p-4 space-y-4">
        <div className="flex items-center gap-2">
          <EraserIcon size={16} className="text-text-secondary" />
          <h2 className="font-semibold text-text-primary">Erase an account&apos;s identity</h2>
        </div>
        <p className="text-xs text-text-muted -mt-2">
          At the account owner&apos;s request: wipes this account&apos;s email and Telegram identity (and disables its password) so those
          identifiers are free to be claimed by a different or brand-new account. Trade/KYC/wallet history is preserved for compliance.
        </p>

        <AccountPicker
          label="Account to erase"
          hint="Search username, email or ID…"
          picked={eraseTarget}
          onPick={(u) => { setEraseTarget(u); setEraseAcknowledgeFundsRisk(false); setEraseNeedsFundsAck(false); setEraseError(null) }}
          onClear={() => { setEraseTarget(null); setEraseAcknowledgeFundsRisk(false); setEraseNeedsFundsAck(false) }}
        />

        {eraseTarget && (
          <div className="space-y-2">
            <textarea
              value={eraseReason}
              onChange={(e) => setEraseReason(e.target.value)}
              rows={2}
              placeholder="Reason (min. 10 characters) — e.g. support ticket #"
              className="w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary resize-none"
            />
            {eraseNeedsFundsAck && (
              <label className="flex items-start gap-2 text-xs text-warning bg-warning/10 border border-warning/20 rounded-lg p-2">
                <input type="checkbox" className="mt-0.5" checked={eraseAcknowledgeFundsRisk} onChange={(e) => setEraseAcknowledgeFundsRisk(e.target.checked)} />
                <span>This account has a non-zero wallet balance that becomes inaccessible once its identity is erased. I&apos;ve confirmed the user moved their funds first.</span>
              </label>
            )}
            <Button
              variant="danger"
              size="sm"
              disabled={eraseReason.trim().length < 10 || (eraseNeedsFundsAck && !eraseAcknowledgeFundsRisk)}
              onClick={() => setConfirmErase(true)}
            >
              Erase identity
            </Button>
          </div>
        )}

        {eraseError && <div className="px-3 py-2 bg-danger/10 border border-danger/20 rounded-lg text-danger text-sm">{eraseError}</div>}
        {eraseSuccess && <div className="px-3 py-2 bg-success/10 border border-success/20 rounded-lg text-success text-sm">{eraseSuccess}</div>}
      </div>

      <ConfirmModal
        isOpen={confirmMerge}
        onClose={() => setConfirmMerge(false)}
        onConfirm={doMerge}
        title="Merge accounts"
        description={survivor && other ? `Retire ${other.username} into ${survivor.username}? ${other.username} will never be able to log in again; its history stays for audit.` : ''}
        confirmLabel={merging ? 'Merging…' : 'Merge'}
        confirmVariant="danger"
      />
      <ConfirmModal
        isOpen={confirmErase}
        onClose={() => setConfirmErase(false)}
        onConfirm={doErase}
        title="Erase identity"
        description={eraseTarget ? `Wipe ${eraseTarget.username}'s email/Telegram login and disable its password? This cannot be undone from the admin panel.` : ''}
        confirmLabel={erasing ? 'Erasing…' : 'Erase'}
        confirmVariant="danger"
      />
    </div>
  )
}
