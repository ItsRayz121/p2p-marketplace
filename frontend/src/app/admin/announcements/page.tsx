'use client'
import { useState, useCallback, useEffect } from 'react'
import { adminApi, type Announcement, type AnnouncementChannel } from '@/lib/api'
import { cn } from '@/lib/utils'

const CHANNELS: { id: AnnouncementChannel; label: string; hint: string }[] = [
  { id: 'web',      label: 'Website banner', hint: 'Dismissible bar at the top of the app' },
  { id: 'bell',     label: 'In-app bell',    hint: 'Appears in each user’s notifications list' },
  { id: 'telegram', label: 'Telegram bot',   hint: 'DMs every user who linked Telegram' },
]

const CHANNEL_BADGE: Record<AnnouncementChannel, string> = {
  web:      'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  bell:     'bg-purple-500/15 text-purple-700 dark:text-purple-300',
  telegram: 'bg-teal-500/15 text-teal-700 dark:text-teal-300',
}

export default function AdminAnnouncementsPage() {
  const [title, setTitle]       = useState('')
  const [body, setBody]         = useState('')
  const [linkUrl, setLinkUrl]   = useState('')
  const [channels, setChannels] = useState<AnnouncementChannel[]>(['web', 'bell'])
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending]   = useState(false)
  const [error, setError]       = useState<string | null>(null)

  const [audience, setAudience] = useState<{ bell: number; telegram: number } | null>(null)
  const [history, setHistory]   = useState<Announcement[]>([])
  const [loading, setLoading]   = useState(true)

  const loadHistory = useCallback(async () => {
    setLoading(true)
    try {
      const [aud, hist] = await Promise.all([
        adminApi.getAnnouncementAudience(),
        adminApi.getAnnouncements({ limit: 20 }),
      ])
      setAudience(aud)
      setHistory(hist.announcements)
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadHistory() }, [loadHistory])

  const toggleChannel = (id: AnnouncementChannel) => {
    setChannels((prev) => prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id])
  }

  const canSend = title.trim().length >= 3 && body.trim().length >= 3 && channels.length > 0

  // Reach estimate for the confirm step, given the chosen channels.
  const reachLines: string[] = []
  if (audience) {
    if (channels.includes('bell')) reachLines.push(`${audience.bell.toLocaleString()} on the in-app bell`)
    if (channels.includes('telegram')) reachLines.push(`${audience.telegram.toLocaleString()} on Telegram`)
    if (channels.includes('web')) reachLines.push('everyone who opens the site (banner)')
  }

  const send = async () => {
    setSending(true)
    setError(null)
    try {
      await adminApi.createAnnouncement({
        title: title.trim(),
        body: body.trim(),
        channels,
        ...(linkUrl.trim() ? { linkUrl: linkUrl.trim() } : {}),
      })
      setTitle(''); setBody(''); setLinkUrl(''); setChannels(['web', 'bell'])
      setConfirming(false)
      void loadHistory()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send announcement')
    } finally {
      setSending(false)
    }
  }

  const deactivate = async (id: string) => {
    try {
      await adminApi.deactivateAnnouncement(id)
      setHistory((prev) => prev.map((a) => a.id === id ? { ...a, isActive: false } : a))
    } catch { /* ignore */ }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Announcements</h1>
        <p className="text-text-muted text-sm mt-0.5">
          Broadcast a product, feature, or gas-fee update across the website and Telegram. Use sparingly — these reach everyone.
        </p>
      </div>

      {/* Composer */}
      <div className="bg-surface shadow-card rounded-xl border border-border p-5 space-y-4 max-w-2xl">
        <div>
          <label className="block text-xs font-semibold text-text-secondary mb-1">Title</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={140}
            placeholder="e.g. New gas-fee chain added: Solana"
            className="w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-text-secondary mb-1">Message</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={2000}
            rows={4}
            placeholder="Write the announcement users will see…"
            className="w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/40 resize-y"
          />
          <p className="text-[11px] text-text-muted mt-1 text-right">{body.length}/2000</p>
        </div>
        <div>
          <label className="block text-xs font-semibold text-text-secondary mb-1">Link (optional)</label>
          <input
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="/gas  or  https://…"
            className="w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <p className="text-[11px] text-text-muted mt-1">Internal path (/gas) or full URL. Becomes an “Open” button.</p>
        </div>

        {/* Channels */}
        <div>
          <label className="block text-xs font-semibold text-text-secondary mb-2">Channels</label>
          <div className="space-y-2">
            {CHANNELS.map((ch) => (
              <label key={ch.id} className="flex items-start gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={channels.includes(ch.id)}
                  onChange={() => toggleChannel(ch.id)}
                  className="mt-0.5 rounded"
                />
                <span>
                  <span className="text-sm font-medium text-text-primary">{ch.label}</span>
                  <span className="block text-[11px] text-text-muted">{ch.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        {!confirming ? (
          <button
            onClick={() => { setError(null); setConfirming(true) }}
            disabled={!canSend}
            className="w-full rounded-lg bg-primary text-white py-2.5 text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            Review & send
          </button>
        ) : (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 space-y-3">
            <p className="text-sm font-semibold text-text-primary">Send this announcement?</p>
            <p className="text-xs text-text-secondary">
              It will reach{reachLines.length ? ' ' : ' all users via the selected channels'}
              {reachLines.length > 0 && (
                <span className="font-medium">{reachLines.join(' · ')}</span>
              )}. This can’t be unsent.
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={send}
                disabled={sending}
                className="flex-1 rounded-lg bg-primary text-white py-2 text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {sending ? 'Sending…' : 'Confirm & send'}
              </button>
              <button
                onClick={() => setConfirming(false)}
                disabled={sending}
                className="rounded-lg border border-border px-4 py-2 text-sm text-text-secondary hover:bg-surface transition-colors"
              >
                Back
              </button>
            </div>
          </div>
        )}
      </div>

      {/* History */}
      <div>
        <h2 className="text-sm font-bold text-text-primary mb-2">History</h2>
        <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-text-muted text-sm gap-2">
              <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              Loading…
            </div>
          ) : history.length === 0 ? (
            <p className="text-center py-12 text-text-muted text-sm">No announcements yet</p>
          ) : (
            <div className="divide-y divide-border">
              {history.map((a) => (
                <div key={a.id} className="px-5 py-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-text-primary">{a.title}</p>
                      <p className="text-xs text-text-muted mt-0.5 line-clamp-2">{a.body}</p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {a.channels.map((c) => (
                        <span key={c} className={cn('px-2 py-0.5 rounded text-[10px] font-bold uppercase', CHANNEL_BADGE[c])}>
                          {c}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3 mt-2 flex-wrap">
                    <p className="text-[11px] text-text-muted">
                      {new Date(a.createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
                      {a.sentByAdmin?.username ? ` · by ${a.sentByAdmin.username}` : ''}
                      {a.channels.includes('bell') ? ` · ${a.bellRecipients.toLocaleString()} bell` : ''}
                      {a.channels.includes('telegram') ? ` · ${a.telegramSent.toLocaleString()} TG${a.telegramFailed ? ` (${a.telegramFailed} failed)` : ''}` : ''}
                    </p>
                    {a.channels.includes('web') && a.isActive && (
                      <button
                        onClick={() => deactivate(a.id)}
                        className="text-[11px] px-2.5 py-1 rounded-lg border border-border text-text-secondary hover:bg-surface transition-colors"
                      >
                        Retire banner
                      </button>
                    )}
                    {a.channels.includes('web') && !a.isActive && (
                      <span className="text-[11px] text-text-muted">Banner retired</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
