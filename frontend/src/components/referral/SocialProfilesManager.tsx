'use client'
import { useEffect, useState } from 'react'
import { Eye, EyeOff, Trash2, Plus, ShieldCheck, ChevronDown } from 'lucide-react'
import { socialLinksApi, type SocialLinkItem } from '@/lib/api'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { Button } from '@/components/ui/Button'
import { toast } from '@/lib/toast'

// Most-used platforms surfaced in the add dropdown (each renders its logo).
const PLATFORMS = ['Facebook', 'Instagram', 'YouTube', 'Twitter/X', 'TikTok', 'LinkedIn', 'WhatsApp', 'Telegram', 'Snapchat', 'Discord']

export function SocialProfilesManager() {
  const [links, setLinks] = useState<SocialLinkItem[]>([])
  const [isPublic, setIsPublic] = useState(false)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  // Add form
  const [platform, setPlatform] = useState(PLATFORMS[0])
  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    socialLinksApi.get()
      .then((d) => { setLinks(d.links); setIsPublic(d.public) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const add = async () => {
    if (!url.trim()) { toast.error('Enter the profile URL'); return }
    setAdding(true)
    try {
      const next = await socialLinksApi.add(platform, url.trim())
      setLinks(next)
      setUrl('')
      toast.success('Social profile added')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to add profile')
    } finally { setAdding(false) }
  }

  const toggleHidden = async (l: SocialLinkItem) => {
    setBusyId(l.id)
    try {
      const next = await socialLinksApi.setHidden(l.id, !l.hidden)
      setLinks(next)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update')
    } finally { setBusyId(null) }
  }

  const remove = async (l: SocialLinkItem) => {
    setBusyId(l.id)
    try {
      const next = await socialLinksApi.remove(l.id)
      setLinks(next)
      toast.success('Removed')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to remove')
    } finally { setBusyId(null) }
  }

  const togglePublic = async () => {
    const nextVal = !isPublic
    setIsPublic(nextVal)
    try {
      await socialLinksApi.setPublic(nextVal)
      toast.success(nextVal ? 'Your profiles are now public' : 'Your profiles are now hidden')
    } catch (e) {
      setIsPublic(!nextVal)
      toast.error(e instanceof Error ? e.message : 'Failed to update')
    }
  }

  if (loading) return null

  return (
    <section className="bg-surface border border-border rounded-xl overflow-hidden">
      {/* Collapsible header — chevron opens the body; the public toggle stays reachable here. */}
      <div className="flex items-center justify-between gap-3 px-5 py-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
        >
          <ChevronDown size={18} className={`text-text-muted shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          <span className="flex items-center gap-2 min-w-0">
            <h2 className="text-base font-semibold text-text-primary">Social Profiles</h2>
            {links.length > 0 && <span className="text-[11px] text-text-muted">· {links.length}</span>}
            {isPublic && (
              <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-success">Public</span>
            )}
          </span>
        </button>
        {/* Public toggle */}
        <button
          type="button"
          role="switch"
          aria-checked={isPublic}
          onClick={togglePublic}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${isPublic ? 'bg-primary' : 'bg-border'}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isPublic ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>

      {expanded && (
      <div className="px-5 pb-5 pt-1 space-y-4 border-t border-border">
      <p className="text-xs text-text-muted">
        Show your socials on your public trader profile. Verified links stay for trust; you can hide dead ones and add more.
      </p>

      {links.length > 0 && (
        <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
          {links.map((l) => (
            <div key={l.id} className={`flex items-center gap-3 px-3 py-2.5 ${l.hidden ? 'opacity-60' : ''}`}>
              <EntityLogo type="social" slug={l.platform} size="sm" className="flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-text-primary">{l.platform}</span>
                  {l.verified && (
                    <span title="Verified via KYC" className="inline-flex items-center gap-0.5 text-[10px] text-success">
                      <ShieldCheck size={12} /> Verified
                    </span>
                  )}
                  {l.hidden && <span className="text-[10px] text-text-muted">· Hidden</span>}
                </div>
                <a href={l.url} target="_blank" rel="noopener noreferrer" className="text-xs text-text-muted truncate block hover:text-primary hover:underline">{l.url}</a>
              </div>
              <div className="flex items-center gap-0.5 flex-shrink-0">
                <button onClick={() => toggleHidden(l)} disabled={busyId === l.id} title={l.hidden ? 'Show' : 'Hide'} aria-label={l.hidden ? 'Show' : 'Hide'} className="p-2 rounded-lg text-text-muted hover:text-primary hover:bg-surface-alt transition-colors disabled:opacity-50">
                  {l.hidden ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
                {/* Verified links can be hidden but not deleted (identity trail). */}
                {!l.verified && (
                  <button onClick={() => remove(l)} disabled={busyId === l.id} title="Remove" aria-label="Remove" className="p-2 rounded-lg text-text-muted hover:text-danger hover:bg-danger/10 transition-colors disabled:opacity-50">
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {open ? (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <EntityLogo type="social" slug={platform} size="xs" />
            </div>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)} className="px-2 py-2 text-sm border border-border rounded-lg bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary">
              {PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className="flex-1 min-w-0 px-3 py-2 text-sm border border-border rounded-lg bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary" />
          </div>
          <div className="flex gap-2">
            <Button size="sm" loading={adding} onClick={add}>Add profile</Button>
            <Button size="sm" variant="secondary" onClick={() => { setOpen(false); setUrl('') }}>Cancel</Button>
          </div>
        </div>
      ) : (
        <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
          <Plus size={16} /> Add social profile
        </button>
      )}
      </div>
      )}
    </section>
  )
}
