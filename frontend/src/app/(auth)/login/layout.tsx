import type { Metadata } from 'next'
import { buildMeta } from '@/lib/metadata'

export const metadata: Metadata = buildMeta(
  'Sign In — RupChain',
  'Sign in to your RupChain account and manage your trades, wallet, and settings.',
  '/login',
)

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
