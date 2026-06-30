import type { Metadata } from 'next'
import { buildMeta } from '@/lib/metadata'

export const metadata: Metadata = buildMeta(
  'USDT Marketplace — Buy & Sell USDT in Pakistan',
  'Browse verified buy and sell USDT offers. Pay with JazzCash, Easypaisa, or bank transfer. Protected P2P trades in Pakistan.',
  '/marketplace',
)

export default function MarketplaceLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
