import { redirect } from 'next/navigation'
import { transactionsHref } from '@/lib/adminRoutes'

// Legacy route — Withdrawals now live in the unified Deposits & Withdrawals view.
export default function WithdrawalsRedirect() {
  redirect(`${transactionsHref('out')}&view=queue`)
}
