import type { ReactNode } from 'react'
import { buildMeta } from '@/lib/metadata'

export const metadata = buildMeta(
  'Help & FAQ — RupChain',
  'Answers to common questions about trading, KYC, payments, withdrawals, disputes, and the gas station on RupChain.',
  '/help',
)

export default function HelpLayout({ children }: { children: ReactNode }) {
  return children
}
