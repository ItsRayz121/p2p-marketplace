'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { channelsApi, type MyChannel, type DirectoryChannel } from '@/lib/channels'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { EmptyState } from '@/components/ui/EmptyState'
import { fmtDateTime } from '@/lib/fmt'
import { toast } from '@/lib/toast'
import { CreateChannelModal } from './CreateChannelModal'
import { Radio, Search, Plus, Users, Lock } from 'lucide-react'

function ChannelRow({ channel, badge }: { channel: MyChannel | DirectoryChannel; badge?: React.ReactNode }) {
  return (
    <Link
      href={`/messages/channels/${channel.id}`}
      className="flex items-center gap-3 p-3 rounded-lg bg-surface border border-border hover:border-primary/40 transition-colors"
    >
      <UserAvatar name={channel.name} avatarUrl={channel.avatarUrl} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-semibold text-text-primary">{channel.name}</span>
          {channel.visibility === 'private' && <Lock className="w-3 h-3 text-text-muted flex-shrink-0" aria-label="Private" />}
        </div>
        <p className="text-xs text-text-muted truncate mt-0.5 flex items-center gap-1">
          <Users className="w-3 h-3 flex-shrink-0" /> {channel.memberCount.toLocaleString()} member{channel.memberCount === 1 ? '' : 's'}
          {channel.description ? ` · ${channel.description}` : ''}
        </p>
      </div>
      {badge}
    </Link>
  )
}

/**
 * `mine`/`reloadMine` are owned by the parent messages page (it already fetches
 * listMine() once to decide whether to show the Channels tab at all — see
 * frontend/src/app/(platform)/messages/page.tsx) and passed down here instead
 * of this component re-fetching the exact same endpoint a second time.
 */
export function ChannelsTab({ mine, reloadMine }: { mine: MyChannel[]; reloadMine: () => void }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [directory, setDirectory] = useState<DirectoryChannel[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [joining, setJoining] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  useEffect(() => {
    setSearching(true)
    const id = setTimeout(() => {
      channelsApi.directory(query.trim())
        .then(setDirectory)
        .catch(() => setDirectory([]))
        .finally(() => setSearching(false))
    }, 300)
    return () => clearTimeout(id)
  }, [query])

  async function join(channel: DirectoryChannel) {
    setJoining(channel.id)
    try {
      await channelsApi.join(channel.slug)
      reloadMine()
      router.push(`/messages/channels/${channel.id}`)
    } catch (e) {
      toast.error('Could not join channel', e instanceof Error ? e.message : 'Please try again')
    } finally {
      setJoining(null)
    }
  }

  const myIds = new Set(mine.map((c) => c.id))
  const discoverable = (directory ?? []).filter((c) => !myIds.has(c.id))

  return (
    <div>
      <div>
        <div className="flex items-center gap-2 mb-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted flex-1">Channels</h2>
          <button
            onClick={() => setCreateOpen(true)}
            aria-label="Create a channel"
            className="w-7 h-7 flex items-center justify-center rounded-full border border-dashed border-primary/40 text-primary hover:bg-primary/5 transition-colors flex-shrink-0"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
        <div className="relative mb-3">
          <Search className="w-4 h-4 text-text-muted absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search public channels…"
            className="w-full rounded-lg border border-border bg-surface pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:border-primary"
          />
        </div>
      </div>

      {mine.length > 0 && (
        <div className="mb-5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-2">My channels</h2>
          <ul className="space-y-2">
            {mine.map((c) => (
              <li key={c.id}>
                <ChannelRow
                  channel={c}
                  badge={
                    <span className="text-[10px] text-text-muted flex-shrink-0">{fmtDateTime(c.lastMessageAt)}</span>
                  }
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-2">Discover</h2>
        {searching && !directory ? (
          <p className="text-xs text-text-muted px-1 py-2">Loading…</p>
        ) : discoverable.length === 0 ? (
          <EmptyState
            icon={Radio}
            title={query.trim() ? 'No channels found' : 'No public channels yet'}
            description={query.trim() ? 'Try a different search.' : 'Be the first to create one.'}
          />
        ) : (
          <ul className="space-y-2">
            {discoverable.map((c) => (
              <li key={c.id}>
                <ChannelRow
                  channel={c}
                  badge={
                    <button
                      onClick={(e) => { e.preventDefault(); void join(c) }}
                      disabled={joining === c.id}
                      className="text-xs font-semibold text-primary hover:underline flex-shrink-0 disabled:opacity-50"
                    >
                      {joining === c.id ? 'Joining…' : 'Join'}
                    </button>
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <CreateChannelModal
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => { setCreateOpen(false); reloadMine(); router.push(`/messages/channels/${id}`) }}
      />
    </div>
  )
}
