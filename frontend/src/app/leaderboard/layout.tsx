import type { ReactNode } from 'react'
import { buildMeta } from '@/lib/metadata'

export const metadata = buildMeta(
  'Trader Leaderboard — RupChain',
  'Top-rated traders on RupChain ranked by completed trades, volume, and trust score — Pakistan’s peer-to-peer crypto marketplace.',
  '/leaderboard',
)

export default function LeaderboardLayout({ children }: { children: ReactNode }) {
  return children
}
