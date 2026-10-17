'use client'

import type { Currency, PortfolioAsset, PortfolioPosition, PortfolioPriceView } from '@/lib/portfolio/types'
import { D } from '@/lib/portfolio/engine/decimal'
import { formatDecimal, formatQuantity, formatSigned, isNegative } from '@/lib/portfolio/format'
import { priceAge } from '@/lib/portfolio/priceStatus'
import { TokenMonogram } from './TokenMonogram'

const held = (q: string | undefined) => /[1-9]/.test(q ?? '0')

/** Average cost per unit of what is held now, only when every held unit has a recorded cost. */
export function averageCost(p: PortfolioPosition | undefined): string | null {
  if (!p || !p.basisComplete || !held(p.quantity)) return null
  const avg = new D(p.knownRemainingBasis).div(p.quantity)
  // Money-sized prices read like every other amount (2 decimals); sub-1 prices keep the precision that matters.
  return avg.abs().gte(1) ? formatDecimal(avg.toFixed(), 2) : formatQuantity(avg.toDecimalPlaces(6).toFixed())
}

/**
 * One token as a single clickable row: what is held, what it is worth and how it is doing. Every
 * action (buy, sell, price, history) lives on the token's own page, so the row carries none.
 */
export function TokenCard({
  asset, position, price, shown, fxUnavailable, onOpen, buttonRef, now = new Date(),
}: {
  asset: PortfolioAsset
  position: PortfolioPosition | undefined
  price: PortfolioPriceView | undefined
  shown: Currency
  fxUnavailable: boolean
  onOpen: () => void
  buttonRef?: (el: HTMLButtonElement | null) => void
  now?: Date
}) {
  const archived = Boolean(asset.archivedAt)
  const age = price && price.price !== null ? priceAge(price.observedAt, now) : null
  const hasPrice = price !== undefined && price.price !== null

  return (
    <li className="group">
      <button
        ref={buttonRef} type="button" onClick={onOpen}
        className="w-full text-left px-4 py-3.5 flex items-center gap-3 rounded-2xl border border-border bg-surface shadow-card transition hover:border-primary/40 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <TokenMonogram name={asset.name} size="md" logoUrl={asset.logoUrl} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-text-primary break-words">
            {asset.name}{archived && <span className="ml-2 text-xs font-normal text-text-muted">Archived</span>}
          </span>
          <span className="block text-xs text-text-muted break-words">
            {asset.symbol ? `${asset.symbol} · ` : ''}
            {position && !fxUnavailable
              ? hasPrice && age
                ? <>Price {age.label}{age.stale && <span title="This price may be out of date" className="ml-1 inline-flex items-center gap-1 text-amber-700"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500" />May be out of date</span>}</>
                : 'No current price'
              : null}
          </span>
        </span>
        {!position && fxUnavailable && (
          <span className="text-right text-xs text-amber-800 flex-shrink-0">No {shown} rate</span>
        )}
        {position && (
          <span className="text-right flex-shrink-0 tabular-nums">
            <span className="block text-sm font-semibold text-text-primary">{position.value === null ? 'No price' : `${shown} ${formatDecimal(position.value)}`}</span>
            <span className="block text-xs text-text-muted">{formatQuantity(position.quantity)} held</span>
            {position.unrealized !== null
              ? <span className={`block text-xs ${isNegative(position.unrealized) ? 'text-danger' : 'text-success'}`}>{formatSigned(position.unrealized)}</span>
              : hasPrice && held(position.quantity) ? <span className="block text-xs text-text-muted">P/L not known yet</span> : null}
          </span>
        )}
        <span aria-hidden className="text-text-muted group-hover:text-primary">›</span>
      </button>
    </li>
  )
}
