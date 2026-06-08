import type { ReactNode } from 'react'
import { buildMeta } from '@/lib/metadata'

export const metadata = buildMeta(
  'Fees — RupChain',
  'Transparent trading, withdrawal, and gas-station fees on RupChain — Pakistan’s peer-to-peer crypto marketplace.',
  '/fees',
)

export default function FeesLayout({ children }: { children: ReactNode }) {
  return children
}
