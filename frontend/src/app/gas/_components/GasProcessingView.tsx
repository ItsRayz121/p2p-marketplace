'use client'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { useGasCtx, PHASE } from './GasContext'
import { ProcessingTimeline, RefundTimeline } from './GasPrimitives'

// Live mm:ss countdown to the moment the refund button unlocks. Returns the
// remaining whole seconds (0 once eligible), re-rendering every second.
function useCountdown(targetIso: string | null | undefined): number {
  const [remaining, setRemaining] = useState(() =>
    targetIso ? Math.max(0, Math.ceil((new Date(targetIso).getTime() - Date.now()) / 1000)) : 0,
  )
  useEffect(() => {
    if (!targetIso) { setRemaining(0); return }
    const tick = () => setRemaining(Math.max(0, Math.ceil((new Date(targetIso).getTime() - Date.now()) / 1000)))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [targetIso])
  return remaining
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Delivery failed but we're still retrying. Shows a countdown, then a "Request
// Refund" button once the window elapses. Auto-refund still fires as a safety net.
function AwaitingRefundView() {
  const { order, requestingRefund, refundReqError, handleRequestRefund } = useGasCtx()
  const remaining = useCountdown(order?.refundEligibleAt)
  const eligible = remaining <= 0

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2.5 flex items-start gap-2.5">
        <Spinner size="sm" />
        <p className="text-xs text-amber-700 font-medium">
          Delivery is taking a little longer than usual — the network may be briefly congested.
          We&apos;re still trying to deliver your gas automatically, so no action is needed yet.
        </p>
      </div>

      {eligible ? (
        <div className="space-y-2">
          <p className="text-xs text-text-muted text-center">
            Still not delivered? You can have your USDT sent back to the wallet you paid from.
          </p>
          <Button className="w-full" variant="secondary" onClick={handleRequestRefund} disabled={requestingRefund}>
            {requestingRefund ? 'Requesting Refund…' : 'Request Refund'}
          </Button>
          {refundReqError && <p className="text-xs text-red-600 text-center">{refundReqError}</p>}
        </div>
      ) : (
        <div className="rounded-lg bg-surface-alt px-3 py-3 text-center">
          <p className="text-xs text-text-muted">If it still hasn&apos;t arrived, you can request a refund in</p>
          <p className="text-2xl font-bold text-text-primary tabular-nums mt-1">{fmt(remaining)}</p>
        </div>
      )}
    </div>
  )
}

export function GasProcessingView() {
  const { order, setPhase, resetFlow, isPkrOrder } = useGasCtx()
  if (!order) return null
  const isAwaiting = order.status === 'awaiting_refund'
  const isRefund = order.status === 'refund_pending' || order.status === 'refunded'
  const title = isAwaiting
    ? 'Delivery Delayed'
    : isRefund
    ? 'Refunding Your Payment'
    : 'Processing Your Order'
  return (
    <div className="p-5 space-y-4">
      <div className="pb-3 border-b border-border">
        <p className="text-sm font-bold text-text-primary">{title}</p>
        <p className="text-xs text-text-muted mt-0.5">Order #{order.orderRef}</p>
      </div>
      {isAwaiting ? (
        <AwaitingRefundView />
      ) : isRefund ? (
        <>
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
            <p className="text-xs text-amber-700 font-medium">
              {order.status === 'refund_pending'
                ? "We couldn't deliver your gas, so your USDT is being sent back to the wallet you paid from. No action needed."
                : 'Your USDT has been sent back to the wallet you paid from.'}
            </p>
          </div>
          <RefundTimeline status={order.status} />
          <Button className="w-full" onClick={resetFlow}>Create New Order</Button>
        </>
      ) : (
        <ProcessingTimeline status={order.status} isPkr={isPkrOrder} />
      )}
      {order.status === 'delivered' && (
        <Button className="w-full" onClick={() => setPhase(PHASE.COMPLETE)}>View Order Completion</Button>
      )}
      {['failed', 'expired'].includes(order.status) && (
        <div className="text-center">
          <p className="text-sm text-red-600 font-semibold mb-3">Order failed. Please try again.</p>
          <Button onClick={resetFlow}>Try Again</Button>
        </div>
      )}
    </div>
  )
}
