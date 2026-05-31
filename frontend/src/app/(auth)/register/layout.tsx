import type { Metadata } from 'next'
import { buildMeta } from '@/lib/metadata'

export const metadata: Metadata = buildMeta(
  'Create Account — Join RupChain',
  'Sign up for free and start trading crypto in Pakistan. Buy and sell USDT with JazzCash and Easypaisa.',
  '/register',
)

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
