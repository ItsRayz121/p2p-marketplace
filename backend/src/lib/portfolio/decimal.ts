import Decimal from 'decimal.js'

/**
 * One exact-decimal type for the whole portfolio engine. decimal.js defaults to 20 significant
 * digits, too few for 28-digit amounts with 18 decimals, so this clone carries 60.
 *
 * Imported from `decimal.js` directly (not through Prisma) so the browser build can use the same
 * code for the local-only guest tracker; a parity test keeps the two copies identical.
 */
export const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_EVEN })
export type Dec = InstanceType<typeof D>

/** Rounding used ONLY when splitting amounts or converting currencies. */
export const ALLOC_DP = 8
export const ROUND = Decimal.ROUND_HALF_EVEN
