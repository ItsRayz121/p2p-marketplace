'use client'

import type { ImportReport, PortfolioAsset, PortfolioSummaryResponse } from '@/lib/portfolio/types'
import { priceAge } from '@/lib/portfolio/priceStatus'

export type TokenAction = 'price' | 'opening' | 'history'

interface Action { label: string; run: () => void }
interface Item { key: string; text: string; actions: Action[]; more?: number }

const MAX_BUTTONS = 4
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const held = (q: string | undefined) => /[1-9]/.test(q ?? '0')

/**
 * Everything that makes the numbers above less complete or less current, each with the shortest way
 * to fix it. Nothing here guesses a value or creates an entry: every action opens a form for the
 * user to fill in.
 */
export function NeedsAttention({
  summary, assets, importReport, onOpenToken, onReviewExcluded, now = new Date(),
}: {
  summary: PortfolioSummaryResponse
  assets: PortfolioAsset[]
  importReport: ImportReport | null
  onOpenToken: (assetId: string, action: TokenAction) => void
  /** Present only when the account can list trades that were left out. */
  onReviewExcluded?: () => void
  now?: Date
}) {
  const active = new Map(assets.filter((a) => !a.archivedAt).map((a) => [a.id, a]))
  const s = summary.summary
  const mine = (ids: string[]) => ids.filter((id) => active.has(id))
  const buttons = (ids: string[], label: string, action: TokenAction): Pick<Item, 'actions' | 'more'> => ({
    actions: ids.slice(0, MAX_BUTTONS).map((id) => ({ label: `${label}: ${active.get(id)!.name}`, run: () => onOpenToken(id, action) })),
    more: Math.max(0, ids.length - MAX_BUTTONS),
  })

  const items: Item[] = []

  const unpriced = mine(s.unpricedAssets)
  if (unpriced.length > 0) {
    items.push({ key: 'price', text: `${plural(unpriced.length, 'token needs', 'tokens need')} a current price.`, ...buttons(unpriced, 'Add price', 'price') })
  }

  const stale = mine(s.positions
    .filter((p) => held(p.quantity) && p.value !== null && (() => { const o = summary.prices[p.assetId]?.observedAt; const a = o ? priceAge(o, now) : null; return a?.stale === true })())
    .map((p) => p.assetId))
  if (stale.length > 0) {
    items.push({ key: 'stale', text: `${plural(stale.length, 'price may', 'prices may')} be out of date.`, ...buttons(stale, 'Update price', 'price') })
  }

  const oversold = mine(s.unresolvedAssets)
  if (oversold.length > 0) {
    items.push({
      key: 'oversold',
      text: `${plural(oversold.length, 'token has', 'tokens have')} sales larger than your recorded purchases. No profit is counted for the excess.`,
      ...buttons(oversold, 'Add opening holdings', 'opening'),
    })
  }

  const noCost = mine(s.unknownBasisAssets.filter((id) => !s.unresolvedAssets.includes(id)))
  if (noCost.length > 0) {
    items.push({
      key: 'cost',
      text: `${plural(noCost.length, 'token has', 'tokens have')} units whose cost is not recorded, so their profit is not known yet.`,
      ...buttons(noCost, 'Review history', 'history'),
    })
  }

  const noRate = mine(summary.fxUnavailableAssets)
  if (noRate.length > 0) {
    items.push({
      key: 'fx',
      text: `${plural(noRate.length, 'token has', 'tokens have')} entries without a USDT/PKR rate, so they cannot be shown in ${summary.currency}.`,
      ...buttons(noRate, 'Review history', 'history'),
    })
  }

  if (importReport) {
    const left = importReport.attention.filter((a) => a.reason !== 'in_progress').reduce((n, a) => n + a.count, 0)
    const waiting = importReport.attention.find((a) => a.reason === 'in_progress')?.count ?? 0
    if (left > 0) {
      items.push({
        key: 'excluded',
        text: `${plural(left, 'RupChain trade was', 'RupChain trades were')} left out of automatic tracking.`,
        actions: onReviewExcluded ? [{ label: 'Review excluded trades', run: onReviewExcluded }] : [],
      })
    }
    if (waiting > 0) {
      items.push({ key: 'waiting', text: `${plural(waiting, 'RupChain trade is', 'RupChain trades are')} still in progress and will be added once confirmed.`, actions: [] })
    }
  }

  if (items.length === 0) return null

  return (
    <section aria-labelledby="needs-attention-heading" className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 space-y-2">
      <h3 id="needs-attention-heading" className="text-sm font-semibold text-amber-900">Portfolio Needs Attention</h3>
      <p className="text-xs text-amber-900/80">The totals above leave out whatever is missing here. Missing values are never counted as zero.</p>
      <ul className="space-y-2">
        {items.map((it) => (
          <li key={it.key} className="text-xs text-amber-900">
            <p>{it.text}</p>
            {(it.actions.length > 0 || (it.more ?? 0) > 0) && (
              <p className="mt-1 flex flex-wrap items-center gap-2">
                {it.actions.map((a) => (
                  <button key={a.label} type="button" onClick={a.run} className="rounded-lg border border-amber-600/40 bg-surface px-2.5 py-1 text-xs font-semibold text-primary hover:bg-surface-hover">
                    {a.label}
                  </button>
                ))}
                {(it.more ?? 0) > 0 && <span className="text-amber-900/80">and {it.more} more in the list below</span>}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
