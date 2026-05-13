'use client'
import { create } from 'zustand'

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
  setUser: (user) => set({ user }),
  setLoading: (loading) => set({ isLoading: loading }),
  clearAuth: () => set({ accessToken: null, user: null }),
}))
