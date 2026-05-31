'use client'
import { Button } from '@/components/ui/Button'
import { useGasCtx, PHASE } from './GasContext'
import { ProcessingTimeline } from './GasPrimitives'

export function GasProcessingView() {
  const { order, setPhase, resetFlow, isPkrOrder } = useGasCtx()
  if (!order) return null
  return (
    <div className="p-5 space-y-4">
      <div className="pb-3 border-b border-border">
        <p className="text-sm font-bold text-text-primary">Processing Your Order</p>
        <p className="text-xs text-text-muted mt-0.5">Order #{order.orderRef}</p>
      </div>
      <ProcessingTimeline status={order.status} isPkr={isPkrOrder} />
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
