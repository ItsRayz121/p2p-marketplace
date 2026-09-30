import type { Metadata } from 'next'
import { buildMeta } from '@/lib/metadata'

export const metadata: Metadata = buildMeta(
  'Community Token Market — Trade Community Tokens P2P',
  'Buy and sell community tokens P2P with verified merchants. Protected trading on RupChain.',
  '/ctm',
)

export default function CtmLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
