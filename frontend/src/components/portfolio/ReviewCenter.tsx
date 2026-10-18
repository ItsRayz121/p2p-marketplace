'use client'

import { useState } from 'react'
import type { ImportReport, PortfolioAsset, PortfolioSummaryResponse } from '@/lib/portfolio/types'
import { ATTENTION_TEXT } from '@/lib/portfolio/importText'
import { formatQuantity } from '@/lib/portfolio/format'
import { priceAge } from '@/lib/portfolio/priceStatus'
import { D } from '@/lib/portfolio/engine/decimal'
import { InfoTip } from './InfoTip'

export type TokenAction = 'price' | 'opening' | 'history'

interface ReviewRow { key: string; title: string; detail?: string; actionLabel: string; token?: { assetId: string; action: TokenAction }; excluded?: boolean }
export interface ReviewSection { id: string; title: string; tip: string; rows: ReviewRow[] }

const held = (q: string | undefined) => /[1-9]/.test(q ?? '0')
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * Everything that makes the portfolio numbers less complete or less current, grouped by kind. Nothing
 * here guesses a value or creates an entry: every action opens a form or a list for the user to act on.
 */
export function buildReview(
  summary: PortfolioSummaryResponse, assets: PortfolioAsset[], importReport: ImportReport | null, canReviewTrades: boolean, now = new Date(),
): ReviewSection[] {
  const active = new Map(assets.filter((a) => !a.archivedAt).map((a) => [a.id, a]))
  const s = summary.summary
  const mine = (ids: string[]) => ids.filter((id) => active.has(id))
  const name = (id: string) => active.get(id)!.name
  const sections: ReviewSection[] = []

  const left = importReport ? importReport.attention.filter((a) => a.reason !== 'in_progress').reduce((n, a) => n + a.count, 0) : 0
  if (left > 0 && importReport) {
    sections.push({
      id: 'trades', title: 'Trades to review',
      tip: 'These RupChain trades are left out of your totals because a trade status alone does not prove both sides were settled. If you really did buy or sell, you can record them yourself.',
      rows: [{
        key: 'excluded',
        title: `${plural(left, 'RupChain trade was', 'RupChain trades were')} not added`,
        detail: importReport.attention.filter((a) => a.reason !== 'in_progress').map((a) => `${plural(a.count, 'trade', 'trades')}: ${ATTENTION_TEXT[a.reason]}`).join(' · '),
        actionLabel: 'Review trades', excluded: canReviewTrades,
      }],
    })
  }

  const oversold = mine(s.unresolvedAssets)
  if (oversold.length > 0) {
    sections.push({
      id: 'history', title: 'Sales larger than your records',
      tip: 'You recorded selling more than your records show you had. No profit is counted for the excess. If you held the missing units before your first record, add them as previous holdings.',
      rows: oversold.map((id) => {
        const sales = s.positions.find((p) => p.assetId === id)?.unresolvedSales ?? []
        const total = sales.reduce((sum, u) => sum.plus(u.quantity), new D(0))
        return {
          key: `history-${id}`, title: name(id),
          detail: sales.length > 0 ? `${formatQuantity(total.toFixed())} sold beyond your records (${plural(sales.length, 'sale', 'sales')})` : 'Sales larger than recorded purchases',
          actionLabel: 'Add previous holdings', token: { assetId: id, action: 'opening' as const },
        }
      }),
    })
  }

  // A token whose cost is unknown only for want of an exchange rate is listed once, under the rate issue below.
  const noCost = mine(s.unknownBasisAssets.filter((id) => !s.unresolvedAssets.includes(id) && !summary.fxUnavailableAssets.includes(id)))
  if (noCost.length > 0) {
    sections.push({
      id: 'costs', title: 'Missing acquisition costs',
      tip: 'The cost of some units you hold is not recorded, so their profit is not known yet. Missing costs are never counted as zero.',
      rows: noCost.map((id) => ({ key: `cost-${id}`, title: name(id), detail: 'Cost of some units is not recorded', actionLabel: 'View transactions', token: { assetId: id, action: 'history' as const } })),
    })
  }

  // A price is only a task when the app cannot refresh it by itself: a token with no price at all, or a price the user typed
  // that has aged. A price taken from the latest RupChain trade updates when the token trades again, so it is a note, not a task.
  const unpriced = mine(s.unpricedAssets)
  const staleOwn = mine(s.positions
    .filter((p) => held(p.quantity) && p.value !== null && (() => {
      const v = summary.prices[p.assetId]
      const a = v ? priceAge(v.observedAt, now) : null
      return a?.stale === true && v?.source !== 'platform'
    })())
    .map((p) => p.assetId))
  if (unpriced.length + staleOwn.length > 0) {
    sections.push({
      id: 'prices', title: 'Prices needing attention',
      tip: 'A token without a price is left out of the portfolio value. A price you entered long ago may no longer match the market. Prices from RupChain trades update by themselves.',
      rows: [
        ...unpriced.map((id) => ({
          key: `price-${id}`, title: name(id),
          detail: active.get(id)?.linkedToRupChainToken ? 'No RupChain trade price yet. Enter your own price to include it in the value.' : 'No price entered yet',
          actionLabel: 'Add price', token: { assetId: id, action: 'price' as const },
        })),
        ...staleOwn.map((id) => ({ key: `stale-${id}`, title: name(id), detail: `Your price was entered ${priceAge(summary.prices[id]!.observedAt, now)?.label ?? 'a while ago'}`, actionLabel: 'Update price', token: { assetId: id, action: 'price' as const } })),
      ],
    })
  }

  const noRate = mine(summary.fxUnavailableAssets)
  if (noRate.length > 0) {
    sections.push({
      id: 'other', title: 'Other data quality issues',
      tip: `Some entries were recorded without an exchange rate for their date, so their cost cannot be shown in ${summary.currency}. The token and its current value are still counted; only its profit is partial.`,
      rows: noRate.map((id) => ({ key: `fx-${id}`, title: name(id), detail: `Cost of some entries is unknown in ${summary.currency}`, actionLabel: 'View transactions', token: { assetId: id, action: 'history' as const } })),
    })
  }
  return sections
}

/**
 * Things worth knowing that are NOT tasks: nothing here needs the user to do anything, so they are not counted on the
 * Review badge. Today: a price taken from the latest RupChain trade that was a while ago.
 */
export function reviewNotes(summary: PortfolioSummaryResponse, assets: PortfolioAsset[], now = new Date()): string[] {
  const active = new Map(assets.filter((a) => !a.archivedAt).map((a) => [a.id, a]))
  const old = summary.summary.positions
    .filter((p) => held(p.quantity) && p.value !== null && active.has(p.assetId))
    .filter((p) => { const v = summary.prices[p.assetId]; return v?.source === 'platform' && priceAge(v.observedAt, now)?.stale === true })
    .map((p) => active.get(p.assetId)!.name)
  if (old.length === 0) return []
  return [`${old.join(', ')} ${old.length === 1 ? 'is' : 'are'} valued at the latest RupChain trade price, which was a while ago. ${old.length === 1 ? 'It updates' : 'They update'} automatically when ${old.length === 1 ? 'the token trades' : 'they trade'} again; you can also enter your own price on the token's page.`]
}

/** Number of things to look at, shown as a small badge on the Review button. */
export function reviewCount(sections: ReviewSection[]): number {
  return sections.reduce((n, s) => n + s.rows.length, 0)
}

export function ReviewCenter({
  sections, notes = [], waiting = 0, tokens = [], onOpenToken, onReviewTrades, onBack, backRef,
}: {
  sections: ReviewSection[]
  /** Information only (nothing to do): shown under the sections. */
  notes?: string[]
  /** Tokens that can be given previous holdings from here (the fix for a gap in the history). */
  tokens?: Array<{ id: string; name: string }>
  /** Trades still in progress: informational only. */
  waiting?: number
  onOpenToken: (assetId: string, action: TokenAction) => void
  onReviewTrades?: () => void
  onBack: () => void
  backRef?: React.RefObject<HTMLButtonElement>
}) {
  return (
    <div className="space-y-4">
      <button ref={backRef} type="button" onClick={onBack} className="text-sm font-medium text-primary hover:underline">← Back to portfolio</button>
      <h2 id="tracked-portfolio-heading" className="text-lg font-semibold text-text-primary">Review</h2>

      {sections.length === 0 ? (
        <p role="status" className="rounded-2xl border border-border bg-surface px-4 py-6 text-sm text-text-secondary text-center">Nothing needs your attention. Your portfolio is complete and up to date.</p>
      ) : sections.map((sec) => (
        <details key={sec.id} open className="rounded-2xl border border-border bg-surface shadow-card">
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-text-primary flex items-center justify-between gap-2">
            <span>{sec.title}<InfoTip text={sec.tip} /></span>
            <span className="rounded-full bg-surface-hover px-2 py-0.5 text-xs font-medium text-text-secondary">{sec.rows.length}</span>
          </summary>
          <ul className="divide-y divide-border border-t border-border">
            {sec.rows.map((r) => (
              <li key={r.key} className="px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="block text-sm text-text-primary break-words">{r.title}</span>
                  {r.detail && <span className="block text-xs text-text-muted break-words">{r.detail}</span>}
                </span>
                {(r.token || (r.excluded && onReviewTrades)) && (
                  <button
                    type="button"
                    onClick={() => (r.token ? onOpenToken(r.token.assetId, r.token.action) : onReviewTrades?.())}
                    aria-label={r.token ? `${r.actionLabel}: ${r.title}` : r.actionLabel}
                    className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-primary hover:bg-surface-hover"
                  >
                    {r.actionLabel}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      ))}
      {notes.map((n) => <p key={n} className="rounded-2xl border border-border bg-surface px-4 py-3 text-xs text-text-secondary">{n}</p>)}
      {tokens.length > 0 && <PreviousHoldings tokens={tokens} onPick={(id) => onOpenToken(id, 'opening')} />}
      {waiting > 0 && <p className="text-xs text-text-muted">{plural(waiting, 'RupChain trade is', 'RupChain trades are')} still in progress and will be added once confirmed.</p>}
    </div>
  )
}

/** The tool for a gap in the history: units held before the first record. Not offered anywhere more prominent. */
function PreviousHoldings({ tokens, onPick }: { tokens: Array<{ id: string; name: string }>; onPick: (assetId: string) => void }) {
  const [id, setId] = useState(tokens[0]!.id)
  const chosen = tokens.some((t) => t.id === id) ? id : tokens[0]!.id
  return (
    <details className="rounded-2xl border border-border bg-surface shadow-card">
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-text-primary">
        Add previous holdings
        <InfoTip text="For units you already held before your first record. It adds a holding with the cost you give (or an unknown cost); nothing is invented and your actual transactions are untouched." />
      </summary>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
        <label htmlFor="previous-holdings-token" className="sr-only">Token</label>
        <select id="previous-holdings-token" value={chosen} onChange={(e) => setId(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary">
          {tokens.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button type="button" onClick={() => onPick(chosen)} className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white">Continue</button>
      </div>
    </details>
  )
}
