import { redirect } from 'next/navigation'
import { gasOrderHref } from '@/lib/adminRoutes'

/** Friendly alias: /admin/payment-orders/<ref> opens the order detail page. */
export default async function PaymentOrderAlias({ params }: { params: Promise<{ orderRef: string }> }) {
  const { orderRef } = await params
  redirect(gasOrderHref(orderRef))
}
