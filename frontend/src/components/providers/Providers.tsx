'use client'
import { useEffect } from 'react'
import * as ToastPrimitive from '@radix-ui/react-toast'
import { authApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { initPostHog, identifyUser } from '@/lib/analytics'

interface ProvidersProps {
  children: React.ReactNode
}

export default function Providers({ children }: ProvidersProps) {
  const setAccessToken = useAuthStore((s) => s.setAccessToken)
  const setUser = useAuthStore((s) => s.setUser)
  const setCsrfToken = useAuthStore((s) => s.setCsrfToken)
  const setLoading = useAuthStore((s) => s.setLoading)
  const clearAuth = useAuthStore((s) => s.clearAuth)

  useEffect(() => {
    initPostHog()

    async function init() {
      setLoading(true)
      try {
        const refreshData = await authApi.refresh()
        setAccessToken(refreshData.accessToken)
        const user = await authApi.me()
        setUser(user)
        identifyUser(user.id, { email: user.email, role: user.role, kycLevel: user.kycLevel })
      } catch {
        // Not logged in — drop any stale hint cookie so the middleware
        // doesn't keep us on /dashboard with an expired backend session.
        clearAuth()
      }

      try {
        const csrfData = await authApi.getCsrf()
        setCsrfToken(csrfData.token)
      } catch {
        // Non-fatal
      } finally {
        setLoading(false)
      }
    }

    init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <ToastPrimitive.Provider swipeDirection="right">
      {children}
    </ToastPrimitive.Provider>
  )
}
