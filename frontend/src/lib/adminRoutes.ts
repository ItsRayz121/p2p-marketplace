/**
 * Admin route + deep-link builders. Dashboard cards, alerts and redirects all build
 * their URLs here so a route string or status value lives in exactly one place.
 */

export const ADMIN_ROUTES = {
  gas: '/admin/gas',
  transactions: '/admin/transactions',
  deposits: '/admin/deposits',
  withdrawals: '/admin/withdrawals',
  exchangeAccounts: '/admin/gas/exchange-accounts',
} as const

export const gasOrderHref = (orderRef: string) => `${ADMIN_ROUTES.gas}/orders/${encodeURIComponent(orderRef)}`

// ── Gas orders queue ──────────────────────────────────────────────────────────

/** Backend status group = every non-terminal, pre-delivery status ("Gas Orders Active"). */
export const GAS_STATUS_ACTIVE = 'active'
/** The status a manual-review order sits in while its proof awaits an admin decision. */
export const GAS_STATUS_PROOF_SUBMITTED = 'payment_uploaded'

export type GasPaymentType = 'all' | 'PKR' | 'EXCHANGE' | 'CRYPTO' | 'MANUAL'
const GAS_PAYMENT_TYPES: readonly GasPaymentType[] = ['all', 'PKR', 'EXCHANGE', 'CRYPTO', 'MANUAL']

export interface GasOrderFilters {
  status: string
  paymentType: GasPaymentType
}

export function gasOrdersHref(filters: Partial<GasOrderFilters> = {}): string {
  const qs = new URLSearchParams()
  if (filters.status && filters.status !== 'all') qs.set('status', filters.status)
  if (filters.paymentType && filters.paymentType !== 'all') qs.set('paymentType', filters.paymentType)
  const q = qs.toString()
  return q ? `${ADMIN_ROUTES.gas}?${q}` : ADMIN_ROUTES.gas
}

/** Dashboard "Gas Orders Active" card. */
export const gasActiveOrdersHref = () => gasOrdersHref({ status: GAS_STATUS_ACTIVE })
/** Dashboard "Proofs Pending" card + the "pending review" alert's View All. */
export const gasProofQueueHref = () => gasOrdersHref({ status: GAS_STATUS_PROOF_SUBMITTED, paymentType: 'MANUAL' })

export function parseGasOrderFilters(params: { get(name: string): string | null }): GasOrderFilters {
  const status = params.get('status')?.trim() || 'all'
  const pt = params.get('paymentType')?.trim() ?? 'all'
  const paymentType = (GAS_PAYMENT_TYPES as readonly string[]).includes(pt) ? (pt as GasPaymentType) : 'all'
  return { status, paymentType }
}

// ── Unified Deposits & Withdrawals ────────────────────────────────────────────

export type TxDirectionFilter = 'all' | 'in' | 'out'

export function transactionsHref(direction: TxDirectionFilter = 'all'): string {
  return direction === 'all' ? ADMIN_ROUTES.transactions : `${ADMIN_ROUTES.transactions}?direction=${direction}`
}
