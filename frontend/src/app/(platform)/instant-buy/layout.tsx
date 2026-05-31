import type { Metadata } from 'next'
import { buildMeta } from '@/lib/metadata'

export const metadata: Metadata = buildMeta(
  'Instant Buy Crypto — Get USDT Instantly in Pakistan',
  'Buy USDT instantly without finding a seller. Pay with JazzCash, Easypaisa, or bank transfer. Fast, safe, and simple.',
  '/instant-buy',
)

export default function InstantBuyLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
