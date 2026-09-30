import type { Metadata } from 'next'
import { buildMeta } from '@/lib/metadata'

export const metadata: Metadata = buildMeta(
  'Create Account — Join RupChain',
  'Sign up for free and start trading crypto peer to peer. Buy and sell USDT, trade community tokens and buy gas fees.',
  '/register',
)

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
