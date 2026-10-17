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

/** Small clock: the price behind this value is old. Understated on purpose; the text is in the tooltip. */
export function StaleClock({ label }: { label: string }) {
  return (
    <span role="img" aria-label={`Price ${label}; it may be out of date`} title={`Price ${label}; it may be out of date`} className="inline-flex flex-shrink-0 text-amber-600 dark:text-amber-400">
      <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <circle cx="8" cy="8" r="6.25" /><path d="M8 4.5V8l2.25 1.5" />
      </svg>
    </span>
  )
}

/**
 * One token as a compact clickable card: what is held, what it is worth and how it is doing. Every
 * action (record, price, history) lives on the token's own page, so the card carries none.
 */
export function TokenCard({
  asset, position, price, shown, onOpen, buttonRef, now = new Date(),
}: {
  asset: PortfolioAsset
  position: PortfolioPosition | undefined
  price: PortfolioPriceView | undefined
  shown: Currency
  /** Kept for callers that still pass it; the card never hides a held token any more. */
  fxUnavailable?: boolean
  onOpen: () => void
  buttonRef?: (el: HTMLButtonElement | null) => void
  now?: Date
}) {
  const archived = Boolean(asset.archivedAt)
  const age = price && price.price !== null ? priceAge(price.observedAt, now) : null
  const hasPrice = price !== undefined && price.price !== null
  const isHeld = position ? held(position.quantity) : false

  return (
    <li className="group min-w-0">
      <button
        ref={buttonRef} type="button" onClick={onOpen}
        aria-label={`${asset.name}${asset.symbol ? ` (${asset.symbol})` : ''}${archived ? ', Archived' : ''}`}
        className="flex h-full w-full flex-col gap-2.5 rounded-2xl border border-border bg-surface p-3 text-left shadow-card transition hover:border-primary/40 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <span className="flex items-center gap-2.5">
          <TokenMonogram name={asset.name} size="md" logoUrl={asset.logoUrl} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold leading-tight text-text-primary">{asset.name}</span>
            <span className="block truncate text-[11px] leading-tight text-text-muted">
              {asset.symbol ?? ' '}{archived && <span>{asset.symbol ? ' · ' : ''}Archived</span>}
            </span>
          </span>
          {age?.stale && <StaleClock label={age.label} />}
        </span>

        {position ? (
          <span className="block tabular-nums">
            <span className="block truncate text-sm font-semibold text-text-primary">
              {position.value === null ? <span className="font-medium text-text-muted">No price</span> : `${shown} ${formatDecimal(position.value)}`}
            </span>
            <span className="mt-0.5 flex items-baseline justify-between gap-2 text-[11px]">
              <span className="truncate text-text-muted">{formatQuantity(position.quantity)} held</span>
              {position.unrealized !== null ? (
                <span className={`flex-shrink-0 font-medium ${isNegative(position.unrealized) ? 'text-danger' : 'text-success'}`}>{formatSigned(position.unrealized)}</span>
              ) : isHeld && hasPrice ? (
                <span title="Profit/loss is not known yet" className="flex-shrink-0 text-text-muted">P/L —</span>
              ) : null}
            </span>
          </span>
        ) : (
          <span className="block text-[11px] text-text-muted">No entries yet</span>
        )}
      </button>
    </li>
  )
}
