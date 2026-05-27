'use client'
import { Suspense, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { authApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'

const Spinner = () => (
  <div className="flex flex-col items-center justify-center py-12 gap-3">
    <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
    <p className="text-sm text-text-muted">Signing you in with Google…</p>
  </div>
)

function GoogleSuccessInner() {
  const router = useRouter()
  const params = useSearchParams()
  const setAccessToken = useAuthStore((s) => s.setAccessToken)
  const setUser = useAuthStore((s) => s.setUser)

  useEffect(() => {
    const token = params.get('token')
    const error = params.get('error')

    if (error || !token) {
      const msg =
        error === 'account_suspended' ? 'Your account has been suspended.'
        : error === 'google_cancelled' ? 'Google sign-in was cancelled.'
        : 'Google sign-in failed. Please try again.'
      router.replace(`/login?googleError=${encodeURIComponent(msg)}`)
      return
    }

    setAccessToken(token)
    authApi.me().then((user) => {
      setUser(user)
      window.history.replaceState({}, '', '/auth/google/success')
      const role = user.role
      if (role === 'admin' || role === 'super_admin' || role === 'kyc_reviewer' || role === 'dispute_agent') {
        router.replace('/admin')
      } else {
        router.replace('/dashboard')
      }
    }).catch(() => {
      router.replace('/login?googleError=' + encodeURIComponent('Failed to load your account. Please try again.'))
    })
  }, [params, router, setAccessToken, setUser])

  return <Spinner />
}

export default function GoogleSuccessPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <GoogleSuccessInner />
    </Suspense>
  )
}
