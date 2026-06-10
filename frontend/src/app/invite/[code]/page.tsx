'use client'
// Alias for the canonical /r/<code> referral landing (the spec advertises an
// /invite/<code> form too). Persists the code, then forwards to /r/<code> so
// there's a single landing UI. Inside Telegram, the route guard intercepts
// /invite first and sends the user to the /mini-app auth bridge.
import { useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'

export default function InviteAliasPage() {
  const { code } = useParams<{ code: string }>()
  const router = useRouter()

  useEffect(() => {
    if (code && typeof window !== 'undefined') {
      try { localStorage.setItem('referralCode', code) } catch { /* ignore */ }
      router.replace(`/r/${code}`)
    }
  }, [code, router])

  return (
    <div className="min-h-screen flex items-center justify-center bg-canvas">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  )
}
