'use client'
import Link from 'next/link'
import { Timer, AlertTriangle } from 'lucide-react'
import { CountdownTimer } from '@/components/ui/CountdownTimer'
import { Button } from '@/components/ui/Button'
import { useCountdown } from '@/hooks/useCountdown'
import { useGasCtx } from './GasContext'

/**
 * True once a manual (PKR / exchange) order has run out of payment time. Expiry is final:
 * the server refuses proofs for an expired order, so the submit buttons use this to stay off.
 */
export function useManualOrderClosed(): boolean {
  const { order } = useGasCtx()
  const { isExpired } = useCountdown(order?.expiresAt ?? new Date().toISOString())
  if (!order) return false
  return order.status === 'expired' || (order.status === 'payment_pending' && isExpired)
}

/**
 * Deadline for manual (PKR / exchange) payments. The user has a short window to pay and
 * upload proof. When it runs out the order is closed for good and they simply start a new
 * one. Once the proof is uploaded the order moves to review and this banner disappears.
 */
export function PaymentDeadline() {
  const { order, resetFlow } = useGasCtx()
  const closed = useManualOrderClosed()
  if (!order || (order.status !== 'payment_pending' && order.status !== 'expired')) return null

  if (closed) {
    return (
      <div role="alert" className="space-y-2 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2.5">
        <p className="flex items-start gap-2 text-xs text-text-secondary">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-danger" aria-hidden />
          <span>
            <span className="font-semibold text-text-primary">Time is up. This order has expired.</span>{' '}
            You can start a new order right away. If you already sent money for this order, please{' '}
            <Link href="/messages/support" className="font-semibold text-primary underline">contact support</Link>{' '}
            with order {order.orderRef}.
          </span>
        </p>
        <Button size="sm" onClick={resetFlow}>Start a new order</Button>
      </div>
    )
  }

  return (
    <div role="timer" className="flex items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5">
      <span className="flex min-w-0 items-start gap-2 text-xs text-text-secondary">
        <Timer className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" aria-hidden />
        <span>Pay and upload your proof before time runs out, or this order closes and you will need to start a new one.</span>
      </span>
      <span className="flex-shrink-0 font-mono text-base font-black tabular-nums text-warning">
        <CountdownTimer expiresAt={order.expiresAt} showLabel={false} />
      </span>
    </div>
  )
}
