import { redirect } from 'next/navigation'
import { PAYMENT_ORDERS_ROUTE } from '@/lib/adminRoutes'

// Gas Trades was folded into Payment Orders + Analytics; keep old links working.
export default function GasTradesRedirect() {
  redirect(PAYMENT_ORDERS_ROUTE)
}
