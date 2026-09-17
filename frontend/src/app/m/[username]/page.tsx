'use client'
// Shared-username deep link (see buildProfileShareLink). Not a UI surface on its
// own — signed-in visitors are dropped straight into a (started-or-resumed)
// conversation with that user; signed-out visitors are sent to log in first and
// land back here afterwards.
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/hooks/useAuth'
import { messagingApi } from '@/lib/messaging'
import { LoadingState } from '@/components/ui/LoadingState'

export default function StartChatByUsernamePage() {
  const { username } = useParams<{ username: string }>()
  const { user, isLoading } = useAuth()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isLoading || !username) return
    if (!user) {
      router.replace(`/login?next=${encodeURIComponent(`/m/${username}`)}`)
      return
    }
    // Your own share link — drop into My Notes instead of a dead-end error,
    // since testing your own share button used to be the one way to hit this.
    const isSelf = user.username.toLowerCase() === username.toLowerCase()
    const request = isSelf ? messagingApi.self() : messagingApi.start(username)
    request
      .then(({ threadId }) => router.replace(`/messages/${threadId}`))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not start that conversation'))
  }, [isLoading, user, username, router])

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] w-full gap-3 px-4 text-center">
        <div className="w-12 h-12 rounded-full bg-danger/10 flex items-center justify-center">
          <svg className="w-6 h-6 text-danger" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <p className="text-sm text-text-muted max-w-xs">{error}</p>
        <Link href="/messages" className="text-sm font-medium text-primary hover:underline">Back to Messages</Link>
      </div>
    )
  }
  return <LoadingState />
}
