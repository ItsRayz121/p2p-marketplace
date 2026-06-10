'use client'
import { Button } from '@/components/ui/Button'
import { useGasCtx, PHASE } from './GasContext'
import { ProcessingTimeline, RefundTimeline } from './GasPrimitives'

export function GasProcessingView() {
  const { order, setPhase, resetFlow, isPkrOrder } = useGasCtx()
  if (!order) return null
  const isRefund = order.status === 'refund_pending' || order.status === 'refunded'
  return (
    <div className="p-5 space-y-4">
      <div className="pb-3 border-b border-border">
        <p className="text-sm font-bold text-text-primary">{isRefund ? 'Refunding Your Payment' : 'Processing Your Order'}</p>
        <p className="text-xs text-text-muted mt-0.5">Order #{order.orderRef}</p>
      </div>
      {isRefund ? (
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
