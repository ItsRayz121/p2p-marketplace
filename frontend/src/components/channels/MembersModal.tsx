'use client'
import { useState, useEffect, useCallback } from 'react'
import { Modal } from '@/components/ui/Modal'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { LoadingState } from '@/components/ui/LoadingState'
import { channelsApi, type ChannelMember } from '@/lib/channels'
import { toast } from '@/lib/toast'
import { UserX } from 'lucide-react'

/** Owner-only member list with a kick action — see kickMember on the backend
 *  for why kicking from a PRIVATE channel also rotates its invite slug. */
export function MembersModal({ isOpen, onClose, channelId, onKicked }: { isOpen: boolean; onClose: () => void; channelId: string; onKicked?: () => void }) {
  const [members, setMembers] = useState<ChannelMember[] | null>(null)
  const [kicking, setKicking] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setMembers(await channelsApi.listMembers(channelId))
    } catch (e) {
      toast.error('Could not load members', e instanceof Error ? e.message : 'Please try again')
    }
  }, [channelId])

  useEffect(() => { if (isOpen) { setMembers(null); void load() } }, [isOpen, load])

  async function kick(userId: string, name: string) {
    if (!window.confirm(`Remove ${name} from this channel?`)) return
    setKicking(userId)
    try {
      await channelsApi.kick(channelId, userId)
      await load()
      // A kick from a private channel rotates its invite slug server-side (see
      // kickMember) — let the parent page refetch so a stale slug is never
      // handed out via "Copy invite link" after this.
      onKicked?.()
    } catch (e) {
      toast.error('Could not remove member', e instanceof Error ? e.message : 'Please try again')
    } finally {
      setKicking(null)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Members">
      {!members ? (
        <LoadingState />
      ) : (
        <ul className="space-y-1 max-h-96 overflow-y-auto">
          {members.map((m) => {
            const name = m.user.fullName || m.user.username || 'Member'
            return (
              <li key={m.user.id} className="flex items-center gap-3 py-2">
                <UserAvatar name={name} avatarUrl={m.user.avatarUrl} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary truncate">{name}</p>
                  <p className="text-xs text-text-muted">{m.role === 'owner' ? 'Owner' : 'Subscriber'}</p>
                </div>
                {m.role !== 'owner' && (
                  <button
                    onClick={() => void kick(m.user.id, name)}
                    disabled={kicking === m.user.id}
                    aria-label={`Remove ${name}`}
                    className="p-1.5 rounded text-text-muted hover:text-danger hover:bg-surface-alt disabled:opacity-50 flex-shrink-0"
                  >
                    <UserX className="w-4 h-4" />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}
