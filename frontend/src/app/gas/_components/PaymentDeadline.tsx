'use client'
import { useState } from 'react'
import { Timer, AlertTriangle } from 'lucide-react'
import { CountdownTimer } from '@/components/ui/CountdownTimer'
import { Button } from '@/components/ui/Button'
import { useGasCtx } from './GasContext'

/**
 * Deadline for manual (PKR / exchange) payments. The user has a short window to pay and
 * upload proof. If it runs out we do NOT dead-end them: someone who really paid can still
 * upload the proof for a while (the server accepts it within a grace period) and we check it;
 * someone who has not paid is told to start a new order. Once the proof is uploaded the
 * order moves to review and this banner disappears.
 */
export function PaymentDeadline() {
  const { order, resetFlow } = useGasCtx()
  const [timeUp, setTimeUp] = useState(false)
  if (!order || (order.status !== 'payment_pending' && order.status !== 'expired')) return null

  if (timeUp || order.status === 'expired') {
    return (
      <div role="alert" className="space-y-2 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2.5">
        <p className="flex items-start gap-2 text-xs text-text-secondary">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-danger" aria-hidden />
          <span>
            <span className="font-semibold text-text-primary">Time is up.</span>{' '}
            If you already sent the payment, upload your proof below now and we will still check it. If you have not paid, please start a new order.
          </span>
        </p>
        <Button size="sm" variant="secondary" onClick={resetFlow}>Start a new order</Button>
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
        <CountdownTimer expiresAt={order.expiresAt} showLabel={false} onExpire={() => setTimeUp(true)} />
      </span>
    </div>
  )
}
