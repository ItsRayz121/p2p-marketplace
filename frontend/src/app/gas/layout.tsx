import type { Metadata } from 'next'
import { buildMeta } from '@/lib/metadata'

export const metadata: Metadata = buildMeta(
  'Crypto Gas Fees — Top Up Any Blockchain Instantly',
  'Buy gas fees for TRON, BNB Chain, Ethereum, Solana, and 10+ blockchains. Pay with JazzCash, Easypaisa, or USDT. Instant delivery.',
  '/gas',
)

export default function GasLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
