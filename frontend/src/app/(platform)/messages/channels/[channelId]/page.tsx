'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useAuth } from '@/hooks/useAuth'
import { channelsApi, type ChannelDetail, type ChannelMessage } from '@/lib/channels'
import { renderChannelText } from '@/lib/richText'
import { useFileUpload } from '@/hooks/useFileUpload'
import { compressImage } from '@/lib/imageCompress'
import { isTrustedImageUrl } from '@/lib/utils'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { AnchoredMenu } from '@/components/ui/AnchoredMenu'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { UploadProgress } from '@/components/ui/UploadProgress'
import { ShareAdPicker } from '@/components/chat/ShareAdPicker'
import { SharedGasCard } from '@/components/chat/SharedGasCard'
import { GasSharePicker } from '@/components/channels/GasSharePicker'
import type { GasChain } from '@/lib/api'
import { MembersModal } from '@/components/channels/MembersModal'
import { toast } from '@/lib/toast'
import { fmtTime } from '@/lib/fmt'
import {
  ArrowLeft, Send, Trash2, MoreVertical, Users, Lock, Link2, LogOut, Pencil,
  ExternalLink, Tag, Radio, X, Camera, ImagePlus,
} from 'lucide-react'

function SharedAdCard({ ad }: { ad: NonNullable<ChannelMessage['sharedAd']> }) {
  if (ad.deleted) {
    return <div className="rounded-lg border border-border px-3 py-2 text-xs italic text-text-muted">This listing is no longer available.</div>
  }
  const href = ad.market === 'usdt' ? `/marketplace/listings/${ad.id}` : `/ctm/listings/${ad.id}`
  return (
    <Link href={href} className="flex items-center gap-2 rounded-lg border border-border p-2 hover:bg-surface-alt transition-colors">
      <EntityLogo type="token" slug={ad.symbol ?? '?'} size="sm" logoUrl={ad.logoUrl} />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold truncate text-text-primary">{ad.name} ({ad.symbol})</p>
        <p className="text-[11px] text-text-muted">
          {ad.side === 'sell' ? 'Selling' : 'Buying'} · PKR {ad.price ? Number(ad.price).toLocaleString() : '—'}
        </p>
      </div>
      <ExternalLink className="w-3.5 h-3.5 flex-shrink-0 text-text-muted" />
    </Link>
  )
}

export default function ChannelPage() {
  const { user } = useAuth()
  const { channelId: idOrSlug } = useParams<{ channelId: string }>()
  const router = useRouter()
  const [channel, setChannel] = useState<ChannelDetail | null>(null)
  const [messages, setMessages] = useState<ChannelMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [joining, setJoining] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const draftRef = useRef<HTMLTextAreaElement>(null)

  // Pending image attachment — compressed client-side, then uploaded to
  // Cloudinary the moment it's picked; the URL waits here until the user hits
  // send (so they can add a caption first), mirroring the DM thread's flow.
  const [pendingImage, setPendingImage] = useState<string | null>(null)
  const [compressing, setCompressing] = useState(false)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const { upload: uploadImage, uploading: uploadingImage, progress: imageProgress } = useFileUpload('channel-image')

  const menuAnchorRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [membersOpen, setMembersOpen] = useState(false)
  const [shareAdOpen, setShareAdOpen] = useState(false)
  const [sharingAd, setSharingAd] = useState(false)
  const shareMenuAnchorRef = useRef<HTMLButtonElement>(null)
  const [shareMenuOpen, setShareMenuOpen] = useState(false)
  const [gasShareOpen, setGasShareOpen] = useState(false)
  const [sharingGas, setSharingGas] = useState(false)

  const load = useCallback(async () => {
    try {
      const c = await channelsApi.get(idOrSlug)
      setChannel(c)
      if (c.isMember) setMessages(await channelsApi.messages(c.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load channel')
    }
  }, [idOrSlug])

  useEffect(() => { if (user) void load() }, [user, load])

  // Poll for new broadcasts while the channel is open — members only (mirrors
  // the DM thread's 15s poll).
  useEffect(() => {
    if (!channel?.isMember) return
    const id = setInterval(() => { void load() }, 15_000)
    return () => clearInterval(id)
  }, [channel?.isMember, load])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  async function join() {
    if (!channel || joining) return
    setJoining(true)
    try {
      // Private channels require the CURRENT slug, not the id (see joinChannel) —
      // always join by slug so this keeps working after an invite-link rotation.
      await channelsApi.join(channel.slug)
      await load()
    } catch (e) {
      toast.error('Could not join channel', e instanceof Error ? e.message : 'Please try again')
    } finally {
      setJoining(false)
    }
  }

  async function leave() {
    if (!channel) return
    if (!window.confirm(`Leave ${channel.name}? You can rejoin later if it's still public.`)) return
    setMenuOpen(false)
    try {
      await channelsApi.leave(channel.id)
      router.push('/messages?tab=channels')
    } catch (e) {
      toast.error('Could not leave channel', e instanceof Error ? e.message : 'Please try again')
    }
  }

  async function deleteChannel() {
    if (!channel) return
    if (!window.confirm(`Delete ${channel.name}? This permanently removes it and all its messages for every member.`)) return
    setMenuOpen(false)
    try {
      await channelsApi.delete(channel.id)
      router.push('/messages?tab=channels')
    } catch (e) {
      toast.error('Could not delete channel', e instanceof Error ? e.message : 'Please try again')
    }
  }

  async function copyInvite() {
    if (!channel) return
    setMenuOpen(false)
    const link = `${window.location.origin}/messages/channels/${channel.slug}`
    try {
      await navigator.clipboard.writeText(link)
      toast.success('Invite link copied', link)
    } catch {
      toast.info('Invite link', link)
    }
  }

  async function regenerateInvite() {
    if (!channel) return
    if (!window.confirm('Rotate the invite link? Every link shared so far will stop working.')) return
    setMenuOpen(false)
    try {
      const { slug } = await channelsApi.regenerateInvite(channel.id)
      setChannel((prev) => prev && { ...prev, slug })
      const link = `${window.location.origin}/messages/channels/${slug}`
      await navigator.clipboard.writeText(link).catch(() => {})
      toast.success('New invite link copied', link)
    } catch (e) {
      toast.error('Could not rotate invite link', e instanceof Error ? e.message : 'Please try again')
    }
  }

  async function send() {
    if (!channel || sending) return
    const body = draft.trim()
    if (!body && !pendingImage) return
    setSending(true)
    try {
      if (editingId) {
        await channelsApi.editMessage(channel.id, editingId, body)
        setEditingId(null)
      } else {
        const clientId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`
        await channelsApi.post(channel.id, body, clientId, undefined, pendingImage ?? undefined)
      }
      setDraft('')
      setPendingImage(null)
      await load()
    } catch (e) {
      toast.error(editingId ? 'Could not save edit' : 'Could not post', e instanceof Error ? e.message : 'Please try again')
    } finally {
      setSending(false)
    }
  }

  function startEdit(m: ChannelMessage) {
    // Editing only ever changes text (see editChannelMessage) — drop any
    // not-yet-sent image pick rather than silently losing it on save.
    setPendingImage(null)
    setEditingId(m.id)
    setDraft(m.body)
    requestAnimationFrame(() => draftRef.current?.focus())
  }

  function cancelEdit() {
    setEditingId(null)
    setDraft('')
  }

  async function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    setCompressing(true)
    try {
      const url = await uploadImage(await compressImage(file))
      setPendingImage(url)
    } catch (err) {
      toast.error('Image upload failed', err instanceof Error ? err.message : 'Please try again')
    } finally {
      setCompressing(false)
    }
  }

  async function sendSharedAd(item: { market: 'usdt' | 'ctm'; id: string }) {
    if (!channel || sharingAd) return
    setSharingAd(true)
    try {
      await channelsApi.post(channel.id, '', undefined, item)
      setShareAdOpen(false)
      await load()
    } catch (e) {
      toast.error('Could not share listing', e instanceof Error ? e.message : 'Please try again')
    } finally {
      setSharingAd(false)
    }
  }

  async function sendGasShare(chain: GasChain) {
    if (!channel || sharingGas) return
    setSharingGas(true)
    try {
      const clientId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`
      await channelsApi.post(channel.id, '', clientId, undefined, undefined, chain.slug)
      setGasShareOpen(false)
      await load()
    } catch (e) {
      toast.error('Could not share gas fees', e instanceof Error ? e.message : 'Please try again')
    } finally {
      setSharingGas(false)
    }
  }

  async function deleteMessage(id: string) {
    if (!channel) return
    if (!window.confirm('Delete this broadcast? Every member will see it was removed.')) return
    try {
      await channelsApi.deleteMessage(channel.id, id)
      if (editingId === id) cancelEdit()
      await load()
    } catch (e) {
      toast.error('Could not delete message', e instanceof Error ? e.message : 'Please try again')
    }
  }

  if (error) return <ErrorState description={error} onRetry={load} />
  if (!channel) return <LoadingState />

  const isOwner = channel.myRole === 'owner'

  return (
    <div className="max-w-2xl mx-auto flex flex-col h-[calc(100dvh-4rem)] pb-[calc(4rem+max(1rem,env(safe-area-inset-bottom)))] -mb-[calc(6rem+env(safe-area-inset-bottom))] lg:h-[calc(100dvh-4rem)] lg:pb-0 lg:mb-0">
      <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-3 border-b border-border bg-surface">
        <Link href="/messages?tab=channels" className="p-1 -ml-1 rounded hover:bg-muted" aria-label="Back">
          <ArrowLeft className="w-5 h-5 text-text-muted" />
        </Link>
        <UserAvatar name={channel.name} avatarUrl={channel.avatarUrl} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="font-semibold text-text-primary truncate">{channel.name}</p>
            {channel.visibility === 'private' && <Lock className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />}
          </div>
          <p className="text-xs text-text-muted flex items-center gap-1">
            <Users className="w-3 h-3" /> {channel.memberCount.toLocaleString()} member{channel.memberCount === 1 ? '' : 's'}
          </p>
        </div>
        <button
          ref={menuAnchorRef}
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Channel options"
          className="p-1.5 -mr-1 rounded hover:bg-muted flex-shrink-0"
        >
          <MoreVertical className="w-5 h-5 text-text-muted" />
        </button>
        <AnchoredMenu anchorRef={menuAnchorRef} open={menuOpen} onClose={() => setMenuOpen(false)} align="end" width={232}>
          <div className="bg-surface border border-border rounded-lg shadow-card py-1">
            {channel.isMember && (
              <button onClick={() => void copyInvite()} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-surface-alt">
                <Link2 className="w-4 h-4" /> Copy invite link
              </button>
            )}
            {isOwner && (
              <>
                <button onClick={() => { setMenuOpen(false); setEditOpen(true) }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-surface-alt">
                  <Pencil className="w-4 h-4" /> Edit channel
                </button>
                <button onClick={() => { setMenuOpen(false); setMembersOpen(true) }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-surface-alt">
                  <Users className="w-4 h-4" /> Members
                </button>
                <button onClick={() => void regenerateInvite()} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-surface-alt">
                  <Link2 className="w-4 h-4" /> Rotate invite link
                </button>
                <button onClick={() => void deleteChannel()} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-danger hover:bg-surface-alt">
                  <Trash2 className="w-4 h-4" /> Delete channel
                </button>
              </>
            )}
            {channel.isMember && !isOwner && (
              <button onClick={() => void leave()} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-danger hover:bg-surface-alt">
                <LogOut className="w-4 h-4" /> Leave channel
              </button>
            )}
          </div>
        </AnchoredMenu>
      </div>

      {channel.description && (
        <p className="px-4 pt-3 text-sm text-text-muted">{channel.description}</p>
      )}

      {!channel.isMember ? (
        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-3">
          <Radio className="w-10 h-10 text-primary/50" />
          <div>
            <p className="font-semibold text-text-primary">{channel.name}</p>
            <p className="text-sm text-text-muted mt-1">
              Broadcast channel by {channel.owner.fullName || channel.owner.username || 'a trader'} · {channel.memberCount.toLocaleString()} member{channel.memberCount === 1 ? '' : 's'}
            </p>
          </div>
          <button
            onClick={() => void join()}
            disabled={joining}
            className="px-6 py-2.5 rounded-xl bg-primary text-white text-sm font-semibold disabled:opacity-50"
          >
            {joining ? 'Joining…' : 'Join channel'}
          </button>
        </div>
      ) : (
        <>
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {!messages ? (
              <LoadingState />
            ) : messages.length === 0 ? (
              <p className="text-center text-sm text-text-muted py-8">No broadcasts yet.</p>
            ) : (
              messages.map((m) => {
                const mine = m.senderId === user?.id
                if (m.deletedAt) {
                  return (
                    <div key={m.id} className="rounded-2xl px-3 py-2 text-xs italic text-text-muted bg-muted/60 border border-dashed border-border max-w-[85%]">
                      🚫 This update was deleted
                    </div>
                  )
                }
                const withinMutateWindow = mine && Date.now() - new Date(m.createdAt).getTime() < 15 * 60 * 1000
                return (
                  <div key={m.id} className="group flex items-start gap-2">
                    {channel.owner.username ? (
                      <Link href={`/profile/${encodeURIComponent(channel.owner.username)}`} aria-label={`View ${channel.owner.fullName || channel.owner.username}'s profile`}>
                        <UserAvatar name={channel.owner.fullName || channel.owner.username || 'Owner'} avatarUrl={channel.owner.avatarUrl} size="sm" />
                      </Link>
                    ) : (
                      <UserAvatar name={channel.owner.fullName || 'Owner'} avatarUrl={channel.owner.avatarUrl} size="sm" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className={`rounded-2xl rounded-tl-sm px-3 py-2 text-sm bg-muted text-text-primary max-w-[85%] ${editingId === m.id ? 'ring-2 ring-primary' : ''}`}>
                        {m.sharedAd && <div className="mb-1"><SharedAdCard ad={m.sharedAd} /></div>}
                        {m.sharedGas && <div className="mb-1"><SharedGasCard gas={m.sharedGas} /></div>}
                        {isTrustedImageUrl(m.attachmentUrl) && (
                          <a href={m.attachmentUrl!} target="_blank" rel="noopener noreferrer" className="block mb-1">
                            <img src={m.attachmentUrl!} alt="Broadcast attachment" className="rounded-lg max-h-64 w-auto max-w-full object-cover" />
                          </a>
                        )}
                        {m.body && <div className="whitespace-pre-wrap break-words">{renderChannelText(m.body)}</div>}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <p className="text-[10px] text-text-muted">
                          {fmtTime(m.createdAt)}{m.editedAt && ' · edited'}
                        </p>
                        {withinMutateWindow && (
                          <div className="sm:opacity-0 sm:group-hover:opacity-100 transition-opacity flex items-center gap-2">
                            <button
                              onClick={() => startEdit(m)}
                              aria-label="Edit broadcast"
                              className="text-text-muted hover:text-primary"
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                            <button
                              onClick={() => void deleteMessage(m.id)}
                              aria-label="Delete broadcast"
                              className="text-text-muted hover:text-danger"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>

          {isOwner ? (
            <div className="border-t border-border bg-surface">
              {editingId && (
                <div className="flex items-center justify-between px-3 pt-2 text-xs text-primary">
                  <span>Editing broadcast</span>
                  <button onClick={cancelEdit} className="flex items-center gap-1 text-text-muted hover:text-text-primary">
                    <X className="w-3 h-3" /> Cancel
                  </button>
                </div>
              )}
              {(pendingImage || uploadingImage || compressing) && (
                <div className="px-3 pt-2">
                  {pendingImage ? (
                    <div className="relative inline-block">
                      <img src={pendingImage} alt="Attachment preview" className="h-20 w-20 rounded-lg border border-border object-cover" />
                      <button
                        onClick={() => setPendingImage(null)}
                        aria-label="Remove image"
                        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-danger text-white flex items-center justify-center"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-text-muted">
                      <Spinner size="sm" /> {compressing ? 'Preparing image…' : 'Uploading…'}
                      {uploadingImage && imageProgress && <UploadProgress progress={imageProgress} className="max-w-[8rem]" />}
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-end gap-2 px-3 py-3">
                <button
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                  disabled={sending || !!editingId || uploadingImage || compressing || !!pendingImage}
                  aria-label="Attach an image"
                  className="p-2 rounded-full text-text-muted hover:text-primary hover:bg-muted transition-colors disabled:opacity-50"
                >
                  <ImagePlus className="w-5 h-5" />
                </button>
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(e) => void onPickImage(e)}
                />
                <button
                  ref={shareMenuAnchorRef}
                  type="button"
                  onClick={() => setShareMenuOpen((v) => !v)}
                  disabled={sending || !!editingId}
                  aria-label="Share"
                  className="p-2 rounded-full text-text-muted hover:text-primary hover:bg-muted transition-colors disabled:opacity-50"
                >
                  <Tag className="w-5 h-5" />
                </button>
                <AnchoredMenu anchorRef={shareMenuAnchorRef} open={shareMenuOpen} onClose={() => setShareMenuOpen(false)} align="start" width={200}>
                  <div className="bg-surface border border-border rounded-lg shadow-card py-1">
                    <button
                      onClick={() => { setShareMenuOpen(false); setShareAdOpen(true) }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-surface-alt"
                    >
                      <Tag className="w-4 h-4" /> Share a listing
                    </button>
                    <button
                      onClick={() => { setShareMenuOpen(false); setGasShareOpen(true) }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-surface-alt"
                    >
                      ⛽ Share gas fees
                    </button>
                  </div>
                </AnchoredMenu>
                <textarea
                  ref={draftRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
                  placeholder="Type a message…"
                  maxLength={4000}
                  rows={1}
                  disabled={sending}
                  className="flex-1 rounded-2xl border border-border bg-background px-4 py-2 text-sm resize-none focus:outline-none focus:border-primary disabled:opacity-50"
                />
                <button
                  onClick={() => void send()}
                  disabled={sending || (editingId ? !draft.trim() : !draft.trim() && !pendingImage)}
                  aria-label={editingId ? 'Save edit' : 'Post'}
                  className="p-2.5 rounded-full bg-primary text-white disabled:opacity-50 flex-shrink-0"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>
          ) : (
            <div className="border-t border-border bg-surface px-4 py-3 text-center text-xs text-text-muted">
              Only {channel.owner.fullName || channel.owner.username || 'the channel owner'} can post here — you're reading as a subscriber.
            </div>
          )}
        </>
      )}

      {isOwner && (
        <ShareAdPicker isOpen={shareAdOpen} onClose={() => setShareAdOpen(false)} onSelect={(item) => void sendSharedAd(item)} sharing={sharingAd} />
      )}

      {isOwner && (
        <GasSharePicker isOpen={gasShareOpen} onClose={() => setGasShareOpen(false)} onSelect={(chain) => void sendGasShare(chain)} sharing={sharingGas} />
      )}

      {isOwner && (
        <MembersModal isOpen={membersOpen} onClose={() => setMembersOpen(false)} channelId={channel.id} onKicked={() => void load()} />
      )}

      {isOwner && (
        <EditChannelModal
          isOpen={editOpen}
          onClose={() => setEditOpen(false)}
          channel={channel}
          onSaved={(updated) => { setChannel((prev) => prev && { ...prev, ...updated }); setEditOpen(false) }}
        />
      )}
    </div>
  )
}

function AutoShareToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-primary' : 'bg-border'}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  )
}

function EditChannelModal({ isOpen, onClose, channel, onSaved }: {
  isOpen: boolean
  onClose: () => void
  channel: ChannelDetail
  onSaved: (updated: { name: string; description: string | null; visibility: 'public' | 'private'; avatarUrl: string | null; autoShareListings: boolean }) => void
}) {
  const [name, setName] = useState(channel.name)
  const [description, setDescription] = useState(channel.description ?? '')
  const [visibility, setVisibility] = useState<'public' | 'private'>(channel.visibility)
  const [avatarUrl, setAvatarUrl] = useState(channel.avatarUrl)
  const [autoShareListings, setAutoShareListings] = useState(channel.autoShareListings)
  const [busy, setBusy] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const { upload: uploadAvatar, uploading: uploadingAvatar, error: uploadAvatarError, progress: avatarProgress } = useFileUpload('avatar')

  useEffect(() => {
    if (isOpen) { setName(channel.name); setDescription(channel.description ?? ''); setVisibility(channel.visibility); setAvatarUrl(channel.avatarUrl); setAutoShareListings(channel.autoShareListings) }
  }, [isOpen, channel])

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      setAvatarUrl(await uploadAvatar(file))
    } catch { /* upload hook sets error state */ }
    if (avatarInputRef.current) avatarInputRef.current.value = ''
  }

  async function submit() {
    if (name.trim().length < 3 || busy) return
    setBusy(true)
    try {
      const updated = await channelsApi.update(channel.id, {
        name: name.trim(), description: description.trim(), visibility, autoShareListings,
        ...(avatarUrl && avatarUrl !== channel.avatarUrl ? { avatarUrl } : {}),
      })
      onSaved({ name: updated.name, description: updated.description, visibility: updated.visibility, avatarUrl: updated.avatarUrl, autoShareListings: updated.autoShareListings })
    } catch (e) {
      toast.error('Could not save changes', e instanceof Error ? e.message : 'Please try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Edit channel">
      <div className="space-y-3">
        <div className="flex items-center gap-4">
          <div className="relative">
            {avatarUrl ? (
              <img src={avatarUrl} alt="Channel avatar" className="w-16 h-16 rounded-full object-cover border-2 border-border" />
            ) : (
              <UserAvatar name={name || channel.name} avatarUrl={null} size="lg" />
            )}
            <button
              type="button"
              onClick={() => avatarInputRef.current?.click()}
              disabled={uploadingAvatar}
              className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-primary text-white flex items-center justify-center shadow hover:bg-primary-hover transition-colors disabled:opacity-50"
            >
              {uploadingAvatar ? <Spinner size="sm" /> : <Camera size={12} />}
            </button>
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={handleAvatarChange}
            />
          </div>
          <div>
            <p className="text-sm font-medium text-text-primary">Channel picture</p>
            <p className="text-xs text-text-muted">JPEG, PNG or WebP, max 10MB</p>
            {uploadingAvatar && avatarProgress && <UploadProgress progress={avatarProgress} className="mt-1 max-w-[12rem]" />}
            {uploadAvatarError && <p className="text-xs text-danger mt-0.5">{uploadAvatarError}</p>}
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-text-muted mb-1">Channel name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary" />
        </div>
        <div>
          <label className="block text-xs font-medium text-text-muted mb-1">Description</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={300} className="w-full px-3 py-2 text-sm border border-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary" />
        </div>
        <div>
          <label className="block text-xs font-medium text-text-muted mb-1">Visibility</label>
          <div className="flex gap-2">
            {(['public', 'private'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setVisibility(v)}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  visibility === v ? 'border-primary bg-primary/10 text-primary' : 'border-border text-text-muted hover:text-text-primary'
                }`}
              >
                {v === 'public' ? 'Public' : 'Private'}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary">Auto-share my listings</p>
            <p className="text-xs text-text-muted mt-0.5">Every new USDT ad or CTM listing you create — and any price update — auto-posts here.</p>
          </div>
          <AutoShareToggle checked={autoShareListings} onChange={setAutoShareListings} />
        </div>
        <div className="flex gap-3 pt-1">
          <button onClick={onClose} className="flex-1 border border-border py-2.5 rounded-xl text-sm font-medium text-text-primary hover:bg-surface-alt">Cancel</button>
          <button onClick={() => void submit()} disabled={name.trim().length < 3 || busy} className="flex-1 bg-primary text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
