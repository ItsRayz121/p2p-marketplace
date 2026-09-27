import { CheckCircle2 } from 'lucide-react'
import type { RecentTrade } from '@/lib/api'
import { tradeTimeAgo } from '@/lib/timeAgo'

/** Renders one CTM/USDT trade entry: "1,000 USDT  buyer ← seller  5m ago". */
export function tradeTickerItem(
  t: RecentTrade,
  opts?: { amountFormat?: 'grouped' | 'fixed2'; collapseAfter24h?: boolean }
) {
  const amount = opts?.amountFormat === 'fixed2'
    ? parseFloat(t.amount).toFixed(2)
    : parseFloat(t.amount).toLocaleString()
  return (
    <>
      <CheckCircle2 size={11} className="text-success flex-shrink-0" />
      <span className="font-semibold text-text-primary">{amount} {t.coin}</span>
      <span className="text-text-muted">{t.buyerFullName || t.buyerUsername} ← {t.sellerFullName || t.sellerUsername}</span>
      <span className="text-text-muted/60">{tradeTimeAgo(t.completedAt, { collapseAfter24h: opts?.collapseAfter24h })}</span>
    </>
  )
}

export interface GasTickerPurchase {
  id: string
  amount: string
  token: string
  chain?: string
  completedAt: string
  buyerUsername?: string
  buyerFullName?: string | null
}

/** Renders one gas-fee purchase entry: "0.0500 BNB  purchased by trader  Recently". */
export function gasTickerItem(p: GasTickerPurchase, opts?: { collapseAfter24h?: boolean }) {
  return (
    <>
      <CheckCircle2 size={11} className="text-success flex-shrink-0" />
      <span className="font-semibold text-text-primary">{parseFloat(p.amount).toFixed(4)} {p.token}</span>
      <span className="text-text-muted">purchased by {p.buyerFullName || p.buyerUsername || 'a trader'}</span>
      <span className="text-text-muted/60">{tradeTimeAgo(p.completedAt, { collapseAfter24h: opts?.collapseAfter24h ?? true })}</span>
    </>
  )
}
