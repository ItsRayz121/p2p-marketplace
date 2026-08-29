'use client'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { TrustpilotPrompt } from '@/components/providers/TrustpilotPrompt'
import { useGasCtx } from './GasContext'
import { explorerUrl } from './GasPrimitives'
import { GasFreeCodeApplied } from './GasFreeCode'

export function GasCompleteView() {
  const { order, selectedToken, selectedChain, explorerBase, isPkrOrder, user, resetFlow } = useGasCtx()
  if (!order) return null
  return (
    <div className="p-5 space-y-4 text-center">
      <div className="py-4">
        <div className="w-20 h-20 rounded-full bg-gradient-to-br from-green-400 to-green-600 flex items-center justify-center mx-auto mb-4 shadow-lg shadow-green-200">
          <svg className="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <p className="text-xl font-bold text-text-primary">Order Completed!</p>
        <p className="text-sm text-text-muted mt-1">Your gas fee order has been processed successfully.</p>
      </div>

      <GasFreeCodeApplied />

      <div className="bg-surface-alt rounded-xl p-4 text-left space-y-2.5 text-xs">
        <div className="flex justify-between"><span className="text-text-muted">Amount Received</span><span className="font-bold text-text-primary">{order.gasAmountNative} {order.nativeSymbol ?? selectedToken?.symbol}</span></div>
        <div className="flex justify-between"><span className="text-text-muted">Destination</span><span className="font-mono text-text-secondary">{order.toAddress.slice(0, 14)}...{order.toAddress.slice(-6)}</span></div>
        <div className="flex justify-between"><span className="text-text-muted">Payment Method</span><span className="font-semibold capitalize">{isPkrOrder ? `PKR · ${order.pkrPaymentMethod?.replace('_', ' ') ?? ''}` : `USDT · ${order.paymentNetwork}`}</span></div>
        <div className="flex justify-between"><span className="text-text-muted">Order ID</span><span className="font-mono text-text-secondary">{order.orderRef}</span></div>
        {order.deliveryTxHash && selectedChain && (
          <div className="flex justify-between items-center pt-2 border-t border-border">
            <span className="text-text-muted">Transaction</span>
            <a
              href={explorerUrl(selectedChain.slug, explorerBase, order.deliveryTxHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary font-semibold hover:underline flex items-center gap-1"
            >
              {order.deliveryTxHash.slice(0, 12)}...
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
            </a>
          </div>
        )}
      </div>

      {/* Happy-path review nudge — only on a clean delivery (no refund/failure),
          capped to once per ~75 days, dark until NEXT_PUBLIC_TRUSTPILOT_URL is
          set. The in-app flow is untouched; this is purely additive. */}
      {order.status === 'delivered' && <TrustpilotPrompt surface="gas" />}

      <div className="space-y-2">
        {user && (
          <Link href="/gas/orders">
            <Button className="w-full">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
              View Order Details
            </Button>
          </Link>
        )}
        <Button variant="secondary" className="w-full" onClick={resetFlow}>Buy More Gas</Button>
      </div>
    </div>
  )
}
