import type { Metadata } from 'next'
import { buildMeta } from '@/lib/metadata'

export const metadata: Metadata = buildMeta(
  'USDT Marketplace — Buy & Sell USDT P2P',
  'Browse verified buy and sell USDT offers. Pay with local methods such as JazzCash, Easypaisa, or bank transfer. Protected P2P trades.',
  '/marketplace',
)

export default function MarketplaceLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
