import { GAS_ACTIVE_STATUSES, MANUAL_PROOF_WHERE } from './gas.orderStates'

const VALID_STATUSES = new Set([
  'created', 'payment_pending', 'payment_uploaded', 'payment_verified', 'payment_detected', 'sending',
  'delivered', 'expired', 'failed', 'awaiting_refund', 'refund_pending', 'refunded', 'cancelled',
])

/**
 * Builds the Prisma `where` for admin gas-order queries. Shared by the paginated
 * list and the summary endpoints so records, totals, cards and charts always
 * describe the same filtered set.
 *
 * `category` (crypto | pkr | free | unknown) is the mutually-exclusive order
 * category used by Gas Trades — see classifyCategory() in gas.insights.ts.
 */
export function buildGasOrderWhere(query: Record<string, string | undefined>, opts: { omitDates?: boolean } = {}): Record<string, unknown> {
  const where: Record<string, unknown> = {}
  // 'active' is a dashboard convenience group matching the Active Orders KPI
  // (everything still in flight, pre-delivery). All other values are exact.
  if (query.status === 'active') {
    where.status = { in: [...GAS_ACTIVE_STATUSES] }
  } else if (query.status && query.status.includes(',')) {
    const list = query.status.split(',').map((s) => s.trim()).filter((s) => VALID_STATUSES.has(s))
    if (list.length) where.status = { in: list }
  } else if (query.status && VALID_STATUSES.has(query.status)) {
    where.status = query.status
  }

  if (query.category === 'free') {
    where.isFreeGrant = true
  } else if (query.category === 'pkr') {
    where.isFreeGrant = false
    where.paymentCoin = 'PKR'
  } else if (query.category === 'crypto') {
    where.isFreeGrant = false
    where.paymentCoin = { notIn: ['PKR', ''] }
  } else if (query.category === 'unknown') {
    where.isFreeGrant = false
    where.paymentCoin = ''
  } else if (query.paymentType === 'PKR' || query.paymentCoin === 'PKR') {
    // Strict PKR vs crypto separation. PKR orders carry paymentCoin='PKR'.
    where.paymentCoin = 'PKR'
  } else if (query.paymentType === 'EXCHANGE') {
    where.paymentNetwork = 'EXCHANGE'
  } else if (query.paymentType === 'MANUAL') {
    // Every manual-review rail (PKR bank transfer + exchange internal transfer).
    Object.assign(where, MANUAL_PROOF_WHERE)
  } else if (query.paymentType === 'CRYPTO') {
    // Auto-verified on-chain payments only — PKR and exchange transfers are manual.
    where.paymentCoin = { not: 'PKR' }
    where.paymentNetwork = { not: 'EXCHANGE' }
  } else if (query.paymentCoin) {
    where.paymentCoin = query.paymentCoin
  }
  // Free-grant history: platform-funded ($0) deliveries from the Free Gas tool.
  if (query.freeGrant === 'true') where.isFreeGrant = true
  if (query.merchantOnly === 'true') where.merchantApiKeyId = { not: null }

  if (query.chain) where.chain = query.chain
  if (!opts.omitDates) {
    const createdAt: Record<string, Date> = {}
    if (query.from && !Number.isNaN(Date.parse(query.from))) createdAt.gte = new Date(query.from)
    if (query.to && !Number.isNaN(Date.parse(query.to))) {
      const end = new Date(query.to)
      // A bare date (YYYY-MM-DD) means "through the end of that day".
      if (/^\d{4}-\d{2}-\d{2}$/.test(query.to)) end.setUTCHours(23, 59, 59, 999)
      createdAt.lte = end
    }
    if (createdAt.gte || createdAt.lte) where.createdAt = createdAt
  }
  const search = query.search?.trim().slice(0, 100)
  if (search) {
    // AND-wrapped so it can't clobber the OR already set by paymentType=MANUAL.
    where.AND = [{ OR: [
      { orderRef:       { contains: search, mode: 'insensitive' } },
      { toAddress:      { contains: search, mode: 'insensitive' } },
      { paymentTxHash:  { contains: search, mode: 'insensitive' } },
      { user: { username: { contains: search, mode: 'insensitive' } } },
      { user: { email:    { contains: search, mode: 'insensitive' } } },
    ] }]
  }
  return where
}
