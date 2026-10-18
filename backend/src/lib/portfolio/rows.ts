import { cleanRate, type Quote } from './currency'
import { impliedUsdtRate } from './usdtImport'
import type { EventRow as SummaryEvent } from './summaryBuilder'

export type DbEvent = {
  source?: string
  id: string; assetId: string; type: string; occurredAt: Date
  quantity: { toFixed(): string }; consideration: { toFixed(): string } | null
  fee: { toFixed(): string } | null; basis: { toFixed(): string } | null
  zeroCost: boolean; quote: string; fxRate: { toFixed(): string } | null
}

/** DB row -> plain strings for the pure calculation modules (rates validated, never trusted blindly). */
export function toSummaryRow(r: DbEvent, platformRate?: string | null, usdtAssets?: ReadonlySet<string>): SummaryEvent {
  // Imported RupChain trades paid in PKR carry no USDT rate of their own: use the platform rate so the USDT view works.
  const own = cleanRate(r.fxRate?.toFixed())
  return {
    id: r.id,
    assetId: r.assetId,
    type: r.type as SummaryEvent['type'],
    occurredAt: r.occurredAt,
    quantity: r.quantity.toFixed(),
    consideration: r.consideration?.toFixed() ?? null,
    fee: r.fee?.toFixed() ?? null,
    basis: r.basis?.toFixed() ?? null,
    zeroCost: r.zeroCost,
    quote: r.quote as Quote,
    // For the USDT holding the price per USDT is the rate itself, so an entry for USDT bought or sold elsewhere converts at what it traded at.
    fxRate: own ?? (r.source === 'ctm' ? cleanRate(platformRate) : usdtAssets?.has(r.assetId) && r.quote === 'PKR' ? impliedUsdtRate(r.consideration?.toFixed() ?? null, r.quantity.toFixed()) : null),
  }
}
