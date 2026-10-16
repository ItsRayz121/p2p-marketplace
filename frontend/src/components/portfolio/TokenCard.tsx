'use client'

import type { Currency, PortfolioAsset, PortfolioPosition, PortfolioPriceView } from '@/lib/portfolio/types'
import { D } from '@/lib/portfolio/engine/decimal'
import { formatDecimal, formatQuantity, formatSigned, isNegative } from '@/lib/portfolio/format'
import { priceAge } from '@/lib/portfolio/priceStatus'
import { TokenMonogram } from './TokenMonogram'

export type CardAction = 'details' | 'price' | 'buy' | 'sell' | 'opening' | 'history'

const held = (q: string | undefined) => /[1-9]/.test(q ?? '0')

/** Average cost per unit of what is held now, only when every held unit has a recorded cost. */
export function averageCost(p: PortfolioPosition | undefined): string | null {
  if (!p || !p.basisComplete || !held(p.quantity)) return null
  const avg = new D(p.knownRemainingBasis).div(p.quantity)
  // Money-sized prices read like every other amount (2 decimals); sub-1 prices keep the precision that matters.
  return avg.abs().gte(1) ? formatDecimal(avg.toFixed(), 2) : formatQuantity(avg.toDecimalPlaces(6).toFixed())
}

/**
 * One token: what is held, what it is worth, how it is doing and how current its price is, with
 * only the actions that make sense for it right now. The whole header opens the details.
 */
export function TokenCard({
  asset, position, price, shown, fxUnavailable, onAction, buttonRef, now = new Date(),
}: {
  asset: PortfolioAsset
  position: PortfolioPosition | undefined
  price: PortfolioPriceView | undefined
  shown: Currency
  fxUnavailable: boolean
  onAction: (a: CardAction) => void
  buttonRef?: (el: HTMLButtonElement | null) => void
  now?: Date
}) {
  const archived = Boolean(asset.archivedAt)
  const age = price && price.price !== null ? priceAge(price.observedAt, now) : null
  const hasPrice = price !== undefined && price.price !== null
  const avg = averageCost(position)
  const oversold = (position?.unresolvedSales.length ?? 0) > 0

  const btn = 'px-2.5 py-1 text-xs font-semibold rounded-lg border border-border text-text-primary hover:bg-surface-hover'
  const act = (a: CardAction, label: string) => (
    <button key={a} type="button" className={btn} onClick={() => onAction(a)}>{label}</button>
  )

  return (
    <li className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
      <button ref={buttonRef} type="button" onClick={() => onAction('details')} className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-surface-hover">
        <TokenMonogram name={asset.name} size="md" logoUrl={asset.logoUrl} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-text-primary break-words">
            {asset.name}{archived && <span className="ml-2 text-xs font-normal text-text-muted">Archived</span>}
          </span>
          {asset.symbol && <span className="block text-xs text-text-muted break-words">{asset.symbol}</span>}
          {position && !fxUnavailable && (
            <span className="mt-1 block text-xs text-text-muted">
              {hasPrice && age
                ? <>Price {age.label}{price?.source === 'platform' ? ', RupChain trade' : ', entered by you'}{age.stale && <span className="ml-1 rounded-full bg-amber-500/10 border border-amber-500/40 px-1.5 text-[11px] font-medium text-amber-800">May be out of date</span>}</>
                : hasPrice ? null : 'No current price'}
            </span>
          )}
        </span>
        {!position && fxUnavailable && (
          <span className="text-right text-xs text-amber-800 flex-shrink-0">No {shown} rate</span>
        )}
        {position && (
          <span className="text-right text-xs text-text-muted flex-shrink-0">
            <span className="block text-text-primary">{formatQuantity(position.quantity)} held</span>
            <span className="block">{position.value === null ? 'No price' : `${shown} ${formatDecimal(position.value)}`}</span>
            {position.unrealized !== null
              ? <span className={`block ${isNegative(position.unrealized) ? 'text-danger' : ''}`}>P/L {formatSigned(position.unrealized)}</span>
              : hasPrice && held(position.quantity) ? <span className="block">P/L not known yet</span> : null}
            {avg !== null && <span className="block">Avg cost {shown} {avg}</span>}
          </span>
        )}
      </button>
      {!archived && (
        <div role="group" aria-label={`Actions for ${asset.name}`} className="flex flex-wrap gap-2 px-4 pb-3">
          {(!hasPrice || age?.stale) && act('price', hasPrice ? 'Update price' : 'Add price')}
          {act('buy', 'Record buy')}
          {held(position?.quantity) && act('sell', 'Record sell')}
          {oversold && act('opening', 'Add opening holdings')}
          {position && act('history', 'History')}
        </div>
      )}
    </li>
  )
}
