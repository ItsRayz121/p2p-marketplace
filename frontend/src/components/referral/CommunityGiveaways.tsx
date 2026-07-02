'use client'
import { useState, useEffect, useCallback } from 'react'
import { gasApi } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { useFileUpload } from '@/hooks/useFileUpload'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { CopyButton } from '@/components/ui/CopyButton'
import {
  promoGiveawayApi,
  entriesToCsv,
  downloadCsv,
  type PromoGiveaway,
  type PromoTask,
} from '@/lib/promoGiveaway'
import { Gift, Plus, Trash2, Download, X, ChevronDown } from 'lucide-react'

interface DraftTask { id: string; label: string; url: string; required: boolean }

const STAFF = new Set(['admin', 'super_admin'])

export function CommunityGiveaways() {
  const { user } = useAuth()
  const [mine, setMine] = useState<PromoGiveaway[]>([])
  const [eligible, setEligible] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [open, setOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      const [list, overview] = await Promise.all([
        promoGiveawayApi.listMine().catch(() => [] as PromoGiveaway[]),
        gasApi.getAffiliateOverview().catch(() => null),
      ])
      setMine(list)
      const isAffiliate = !!overview?.customLinkPolicy?.isAffiliate
      setEligible(isAffiliate || STAFF.has(user?.role ?? ''))
    } finally {
      setLoaded(true)
    }
  }, [user?.role])

  useEffect(() => { void load() }, [load])

  // Nothing to show for a plain user with no giveaways — keep the page clean.
  if (loaded && !eligible && mine.length === 0) return null

  return (
    <section className="bg-surface shadow-card border border-border rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-alt transition-colors"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-base font-semibold text-text-primary">
          <Gift size={16} className="text-primary" />
          Community Giveaways
          {mine.length > 0 && <Badge variant="default" size="sm">{mine.length}</Badge>}
        </span>
        <ChevronDown size={18} className={`text-text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="border-t border-border p-4 space-y-4">
          <p className="text-xs text-text-muted">
            Run a giveaway for your audience: set tasks (follow your channel, join Telegram…), collect winners&apos;
            wallet addresses, and export them as CSV to send rewards yourself. No platform funds are used.
          </p>

          {eligible ? (
            !showForm ? (
              <Button size="sm" onClick={() => setShowForm(true)} className="inline-flex items-center gap-1.5">
                <Plus size={14} /> Create giveaway
              </Button>
            ) : (
              <CreateForm
                onCancel={() => setShowForm(false)}
                onCreated={() => { setShowForm(false); void load() }}
              />
            )
          ) : (
            <p className="text-xs text-text-muted">
              Giveaways are available to approved affiliates. Apply to become an affiliate above to unlock them.
            </p>
          )}

          {mine.length > 0 && (
            <div className="space-y-2">
              {mine.map((g) => <GiveawayRow key={g.id} g={g} onChanged={load} />)}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

// ─── One giveaway row (share, export, close) ─────────────────────────────────
function GiveawayRow({ g, onChanged }: { g: PromoGiveaway; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const shareUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/giveaway/${g.code}`

  async function exportCsv() {
    setBusy(true)
    try {
      const entries = await promoGiveawayApi.entries(g.id)
      if (entries.length === 0) { toast.error('No entries yet.'); return }
      downloadCsv(`giveaway-${g.code}-entries.csv`, entriesToCsv(entries))
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Export failed')
    } finally {
      setBusy(false)
    }
  }

  async function close() {
    if (!window.confirm(`Close "${g.title}"? It will stop accepting entries.`)) return
    setBusy(true)
    try {
      await promoGiveawayApi.close(g.id)
      toast.success('Giveaway closed')
      onChanged()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to close')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border border-border rounded-xl p-3 bg-canvas space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-primary truncate">{g.title}</p>
          <p className="text-xs text-text-muted">{g.entryCount} entered · {g.rewardAll ? 'all win' : `${g.winnerCount} winners`}</p>
        </div>
        <Badge variant={g.status === 'open' && g.isActive ? 'success' : 'default'} size="sm">
          {!g.isActive ? 'Disabled' : g.status === 'open' ? 'Open' : 'Closed'}
        </Badge>
      </div>
      <div className="flex items-center gap-1.5">
        <input readOnly value={shareUrl} className="flex-1 min-w-0 px-2 py-1 text-xs bg-surface border border-border rounded-lg text-text-secondary font-mono" />
        <CopyButton text={shareUrl} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={exportCsv} loading={busy} className="inline-flex items-center gap-1"><Download size={13} /> Export CSV</Button>
        {g.status === 'open' && g.isActive && (
          <Button size="sm" variant="ghost" onClick={close} disabled={busy}>Close</Button>
        )}
      </div>
    </div>
  )
}

// ─── Create form ─────────────────────────────────────────────────────────────
function CreateForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const { upload, uploading } = useFileUpload('giveaway-image')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [thumbnailUrl, setThumbnailUrl] = useState('')
  const [addressLabel, setAddressLabel] = useState('')
  const [rewardAll, setRewardAll] = useState(false)
  const [winnerCount, setWinnerCount] = useState('10')
  const [requireKyc, setRequireKyc] = useState(false)
  const [entryDeadline, setEntryDeadline] = useState('')
  const [tasks, setTasks] = useState<DraftTask[]>([])
  const [saving, setSaving] = useState(false)

  function addTask() {
    setTasks((t) => [...t, { id: `t${Date.now()}${t.length}`, label: '', url: '', required: true }])
  }
  function updateTask(id: string, patch: Partial<DraftTask>) {
    setTasks((t) => t.map((x) => (x.id === id ? { ...x, ...patch } : x)))
  }
  function removeTask(id: string) {
    setTasks((t) => t.filter((x) => x.id !== id))
  }

  async function onThumb(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const url = await upload(file)
      setThumbnailUrl(url)
      toast.success('Thumbnail uploaded')
    } catch { /* hook surfaces the error */ }
  }

  async function submit() {
    if (title.trim().length < 2) { toast.error('Enter a title.'); return }
    const cleanTasks: PromoTask[] = tasks
      .filter((t) => t.label.trim())
      .map((t) => ({ id: t.id, label: t.label.trim(), required: t.required, ...(t.url.trim() ? { url: t.url.trim() } : {}) }))
    const winners = parseInt(winnerCount, 10)
    if (!rewardAll && (!Number.isFinite(winners) || winners < 1)) { toast.error('Set a winner count or choose "everyone wins".'); return }
    setSaving(true)
    try {
      await promoGiveawayApi.create({
        title: title.trim(),
        description: description.trim() || undefined,
        thumbnailUrl: thumbnailUrl || undefined,
        addressLabel: addressLabel.trim() || undefined,
        tasks: cleanTasks,
        rewardAll,
        winnerCount: rewardAll ? 0 : winners,
        requireKyc,
        entryDeadline: entryDeadline ? new Date(entryDeadline).toISOString() : undefined,
      })
      toast.success('Giveaway created 🎉')
      onCreated()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not create giveaway')
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'w-full px-3 py-2 border border-border rounded-lg text-sm bg-canvas text-text-primary focus:outline-none focus:ring-2 focus:ring-primary'

  return (
    <div className="border border-border rounded-xl p-4 bg-canvas space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-text-primary">New giveaway</p>
        <button onClick={onCancel} className="p-1 rounded hover:bg-surface" aria-label="Cancel"><X size={16} /></button>
      </div>

      <div>
        <label className="text-xs font-medium text-text-muted">Title</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. 5,000 PKR USDT Giveaway" className={`mt-1 ${inputCls}`} />
      </div>

      <div>
        <label className="text-xs font-medium text-text-muted">Description (optional)</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="What you're giving away and how winners are picked." className={`mt-1 resize-none ${inputCls}`} />
      </div>

      {/* Thumbnail */}
      <div>
        <label className="text-xs font-medium text-text-muted">Thumbnail (optional)</label>
        <div className="mt-1 flex items-center gap-3">
          {thumbnailUrl && <img src={thumbnailUrl} alt="thumbnail" className="w-16 h-16 rounded-lg object-cover border border-border" />}
          <label className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border border-border rounded-lg cursor-pointer hover:bg-surface">
            {uploading ? 'Uploading…' : thumbnailUrl ? 'Change image' : 'Upload image'}
            <input type="file" accept="image/*" onChange={onThumb} className="hidden" disabled={uploading} />
          </label>
        </div>
      </div>

      {/* Tasks */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-text-muted">Entry tasks (self-attested — entrants confirm they did them)</label>
        {tasks.map((t) => (
          <div key={t.id} className="border border-border rounded-lg p-2 space-y-2 bg-surface">
            <div className="flex items-center gap-2">
              <input value={t.label} onChange={(e) => updateTask(t.id, { label: e.target.value })} placeholder="Task (e.g. Follow @channel on YouTube)" className="flex-1 px-2 py-1.5 text-sm border border-border rounded bg-canvas text-text-primary focus:outline-none focus:ring-1 focus:ring-primary" />
              <button onClick={() => removeTask(t.id)} className="p-1.5 rounded hover:bg-canvas text-text-muted" aria-label="Remove task"><Trash2 size={14} /></button>
            </div>
            <input value={t.url} onChange={(e) => updateTask(t.id, { url: e.target.value })} placeholder="Link (optional, e.g. https://youtube.com/@you)" className="w-full px-2 py-1.5 text-xs border border-border rounded bg-canvas text-text-primary focus:outline-none focus:ring-1 focus:ring-primary" />
            <label className="inline-flex items-center gap-1.5 text-xs text-text-muted">
              <input type="checkbox" checked={t.required} onChange={(e) => updateTask(t.id, { required: e.target.checked })} className="accent-primary" />
              Required to enter
            </label>
          </div>
        ))}
        <Button size="sm" variant="secondary" onClick={addTask} className="inline-flex items-center gap-1"><Plus size={13} /> Add task</Button>
      </div>

      <div>
        <label className="text-xs font-medium text-text-muted">Address label (what entrants submit)</label>
        <input value={addressLabel} onChange={(e) => setAddressLabel(e.target.value)} placeholder="e.g. USDT BEP20 wallet address" className={`mt-1 ${inputCls}`} />
      </div>

      {/* Winners */}
      <div className="flex flex-wrap items-center gap-4">
        <label className="inline-flex items-center gap-2 text-sm text-text-primary">
          <input type="checkbox" checked={rewardAll} onChange={(e) => setRewardAll(e.target.checked)} className="accent-primary" />
          Everyone who enters wins
        </label>
        {!rewardAll && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted">Winners</span>
            <select value={winnerCount} onChange={(e) => setWinnerCount(e.target.value)} className="px-2 py-1.5 text-sm border border-border rounded-lg bg-canvas text-text-primary">
              {['5', '10', '20', '50', '100'].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <label className="inline-flex items-center gap-2 text-sm text-text-primary">
          <input type="checkbox" checked={requireKyc} onChange={(e) => setRequireKyc(e.target.checked)} className="accent-primary" />
          Require verified (KYC) accounts
        </label>
      </div>

      <div>
        <label className="text-xs font-medium text-text-muted">Entry deadline (optional)</label>
        <input type="datetime-local" value={entryDeadline} onChange={(e) => setEntryDeadline(e.target.value)} className={`mt-1 ${inputCls}`} />
      </div>

      <div className="flex gap-2 pt-1">
        <Button onClick={submit} loading={saving} disabled={uploading}>Create giveaway</Button>
        <Button variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </div>
  )
}
