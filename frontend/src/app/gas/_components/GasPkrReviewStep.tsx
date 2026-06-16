'use client'
import { Button } from '@/components/ui/Button'
import { useGasCtx, PHASE } from './GasContext'
import { CardHeader, ProcessingTimeline } from './GasPrimitives'

export function GasPkrReviewStep() {
  const {
    order, selectedToken, computedPkr,
    setPhase, resetFlow, pollErrCount, setPollErrCount, pollOrder,
  } = useGasCtx()

  if (!order) return null

  return (
    <div className="p-5 space-y-4">
      <CardHeader title="Payment Under Review" sub={`Order #${order.orderRef}`} />

      <div className="text-center py-4">
        <div className="w-16 h-16 rounded-full bg-amber-500/15 flex items-center justify-center mx-auto mb-3">
          <svg className="w-8 h-8 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <p className="text-base font-bold text-text-primary mb-1">Proof Submitted!</p>
        <p className="text-sm text-text-muted">Our team is reviewing your payment. Gas will be released after verification (usually within 30–60 minutes during business hours).</p>
      </div>

      <div className="bg-surface-alt rounded-xl p-4">
        <p className="text-xs font-bold text-text-muted uppercase tracking-wide mb-3">Order Status</p>
        <ProcessingTimeline status={order.status} isPkr />
      </div>

      <div className="bg-surface-alt rounded-xl p-3 space-y-2 text-xs">
        <div className="flex justify-between"><span className="text-text-muted">Order ID</span><span className="font-mono text-text-secondary">{order.orderRef}</span></div>
        <div className="flex justify-between"><span className="text-text-muted">Amount Ordered</span><span className="font-semibold">{order.gasAmountNative} {order.nativeSymbol ?? selectedToken?.symbol}</span></div>
        <div className="flex justify-between"><span className="text-text-muted">PKR Paid</span><span className="font-semibold text-green-700 dark:text-green-300">PKR {order.pkrAmount ?? computedPkr.toFixed(0)}</span></div>
      </div>

      {order.status === 'delivered' && (
        <Button className="w-full" onClick={() => setPhase(PHASE.COMPLETE)}>View Completion Screen</Button>
      )}
      {['failed', 'expired'].includes(order.status) && (
        <div className="text-center">
          <p className="text-sm text-red-600 dark:text-red-400 font-semibold mb-3">Order failed. Please try again.</p>
          <Button onClick={resetFlow}>Try Again</Button>
        </div>
      )}
      {pollErrCount >= 3 && (
        <p className="text-xs text-amber-600 dark:text-amber-400 text-center">
          Connection issue.{' '}
          <button className="underline font-semibold" onClick={() => { setPollErrCount(0); void pollOrder() }}>Refresh</button>
        </p>
      )}
    </div>
  )
}
