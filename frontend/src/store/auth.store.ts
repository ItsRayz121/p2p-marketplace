'use client'
import { create } from 'zustand'
import { setAuthHint, clearAuthHint } from '../lib/authCookie'

export interface AuthUser {
  id: string
  email: string
  fullName: string
  username: string
  role: 'user' | 'merchant' | 'kyc_reviewer' | 'dispute_agent' | 'admin' | 'super_admin'
  kycStatus: 'none' | 'pending' | 'approved' | 'rejected'
  kycLevel: 'none' | 'basic' | 'enhanced'
  referralCode: string
  isEmailVerified: boolean
  twoFaEnabled: boolean
  dailyBuyUsed: number
  dailyBuyLimit: number
  createdAt: string
}

interface AuthStore {
  accessToken: string | null
  csrfToken: string | null
  user: AuthUser | null
  isLoading: boolean
  setAccessToken: (token: string) => void
  setCsrfToken: (token: string) => void
  setUser: (user: AuthUser) => void
  setLoading: (loading: boolean) => void
  clearAuth: () => void
}

export const useAuthStore = create<AuthStore>((set) => ({
  accessToken: null,
  csrfToken: null,
  user: null,
  isLoading: true,
  setAccessToken: (token) => set({ accessToken: token }),
  setCsrfToken: (token) => set({ csrfToken: token }),
  setUser: (user) => {
    // Mirror authenticated state into a non-HttpOnly cookie on the frontend
    // domain so the Next.js middleware (running on Vercel) can gate routes.
    // The real refresh_token cookie lives on the Railway backend domain and
    // is not visible to Vercel.
    setAuthHint()
    set({ user })
  },
  setLoading: (loading) => set({ isLoading: loading }),
  clearAuth: () => {
    clearAuthHint()
    set({ accessToken: null, user: null })
  },
}))
