import { redirect } from 'next/navigation'
import { transactionsHref } from '@/lib/adminRoutes'

// Legacy route — Deposits now live in the unified Deposits & Withdrawals view.
export default function DepositsRedirect() {
  redirect(`${transactionsHref('in')}&view=queue`)
}
