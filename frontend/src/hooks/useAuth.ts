'use client'
import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '@/store/auth.store'
import { authApi } from '@/lib/api'
import type { AuthUser } from '@/store/auth.store'

interface UseAuthReturn {
  user: AuthUser | null
  isAuthenticated: boolean
  isLoading: boolean
  logout: () => Promise<void>
}

export function useAuth(): UseAuthReturn {
  const router = useRouter()
  const user = useAuthStore((s) => s.user)
  const isLoading = useAuthStore((s) => s.isLoading)
  const clearAuth = useAuthStore((s) => s.clearAuth)

  const logout = useCallback(async () => {
    try {
      await authApi.logout()
    } catch {
      // Swallow errors — always clear local state
    } finally {
      clearAuth()
      router.push('/login')
    }
  }, [clearAuth, router])

  return {
    user,
    isAuthenticated: user !== null,
    isLoading,
    logout,
  }
}
