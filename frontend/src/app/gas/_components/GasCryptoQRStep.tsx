'use client'
import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/CopyButton'
import { CountdownTimer } from '@/components/ui/CountdownTimer'
import { Badge } from '@/components/ui/Badge'
import { useGasCtx, PHASE } from './GasContext'
import { ProcessingTimeline, RefundTimeline, STATUS_LABELS, statusVariant } from './GasPrimitives'
import { GasPromoApplied, GasAffiliateApplied } from './GasPromo'

// How long we show the "detecting your payment" window before offering manual
// tx-hash entry. On-chain deposits are usually detected by the poller within ~1 min.
const DETECT_WINDOW_MS = 60_000

// How long a PAID order may sit in payment_detected/sending (delivery delayed)
// before we let the user request a refund themselves. Matches the backend gate.
const STUCK_REFUND_THRESHOLD_MS = 7 * 60_000

export function GasCryptoQRStep() {
  const {
    order, setOrder, setPhase, resetFlow,
    cryptoMethods, qrFailed, setQrFailed,
    paymentSent, setPaymentSent,
    verifyOpen, setVerifyOpen,
    verifyTxHash, setVerifyTxHash,
    verifying, verifyError, verifySuccess,
    handleVerifyPayment,
    pollErrCount, setPollErrCount, pollOrder,
    cancelling, cancelError, cancelPreview, cancelResult, loadCancelPreview, handleCancelOrder,
    requestingRefund, refundReqError, handleRequestRefund,
  } = useGasCtx()

  // Inline cancel-confirmation panel. Opening it loads the penalty preview so the
  // user sees the cooldown consequence before committing.
  const [confirmCancel, setConfirmCancel] = useState(false)
  function openCancelConfirm() { setConfirmCancel(true); void loadCancelPreview() }

  // 60s auto-detection window after the user reports they've paid. While it runs
  // the order keeps polling; if it auto-completes the whole block re-renders away.
  // Once the window elapses we fall back to manual tx-hash entry.
  //
  // The deadline is persisted in localStorage keyed by orderRef so a page refresh
  // resumes the same real-time countdown (no restart from 60) rather than losing it.
  const orderRef = order?.orderRef ?? null
  const detectKey = orderRef ? `gas_detect_${orderRef}` : null

  const [detectDeadline, setDetectDeadline] = useState<string | null>(null)
  const [detectElapsed, setDetectElapsed] = useState(false)

  // Ticking clock so the "delivery delayed" notice can unlock the self-refund
  // button once the order has been stuck past the grace window.
  const [nowTs, setNowTs] = useState(() => Date.now())
  const isProcessingStuck = order?.status === 'payment_detected' || order?.status === 'sending'
  useEffect(() => {
    if (!isProcessingStuck) return
    const t = setInterval(() => setNowTs(Date.now()), 5_000)
    return () => clearInterval(t)
  }, [isProcessingStuck])

  // Restore a persisted deadline after refresh.
  useEffect(() => {
    if (!detectKey) return
    let stored: string | null = null
    try { stored = localStorage.getItem(detectKey) } catch { /* storage unavailable */ }
    if (stored) {
      setDetectDeadline(stored)
      setDetectElapsed(new Date(stored).getTime() <= Date.now())
      if (!paymentSent) setPaymentSent(true)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectKey])

  // Start (and persist) the window on first "I've sent"; clear it on go-back.
  // Reuse any already-stored deadline so a refresh mid-window never restarts the
  // countdown — the timer reflects real elapsed wall-clock time.
  useEffect(() => {
    if (!detectKey) return
    if (paymentSent && !detectDeadline) {
      let existing: string | null = null
      try { existing = localStorage.getItem(detectKey) } catch { /* storage unavailable */ }
      const dl = existing ?? new Date(Date.now() + DETECT_WINDOW_MS).toISOString()
      setDetectDeadline(dl)
      setDetectElapsed(new Date(dl).getTime() <= Date.now())
      try { localStorage.setItem(detectKey, dl) } catch { /* storage unavailable */ }
    } else if (!paymentSent && detectDeadline) {
      setDetectDeadline(null)
      setDetectElapsed(false)
      try { localStorage.removeItem(detectKey) } catch { /* storage unavailable */ }
    }
  }, [paymentSent, detectDeadline, detectKey])

  // Once the order advances past payment_pending, the persisted deadline is moot.
  useEffect(() => {
    if (detectKey && order?.status && order.status !== 'payment_pending') {
      try { localStorage.removeItem(detectKey) } catch { /* storage unavailable */ }
    }
  }, [order?.status, detectKey])

  if (!order) return null

  return (
    <div className="p-5 space-y-4">
      <div className="flex items-center justify-between pb-3 border-b border-border">
        <p className="text-sm font-bold text-text-primary">Make Payment</p>
        <Badge variant={statusVariant(order.status)} size="sm">{STATUS_LABELS[order.status] ?? order.status}</Badge>
      </div>

      {order.status === 'payment_pending' && (
        <>
          {/* Countdown */}
          <div className="flex items-center justify-between bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
            <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300 text-xs font-semibold">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              Payment window
            </div>
            <CountdownTimer expiresAt={order.expiresAt} showLabel={false} onExpire={() => setOrder(o => o ? { ...o, status: 'expired' } : o)} />
          </div>

          {/* QR */}
          <div className="flex flex-col items-center gap-2 py-2">
            {qrFailed ? (
              <div className="w-48 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-center">
                <p className="text-xs text-amber-700 dark:text-amber-300 font-semibold mb-1">QR code unavailable</p>
                <p className="text-xs text-amber-600 dark:text-amber-400">Copy the address below to pay.</p>
              </div>
            ) : (
              <div className="w-48 h-48 rounded-xl overflow-hidden border-4 border-surface shadow-lg">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=192x192&data=${encodeURIComponent(order.paymentAddress)}`}
                  alt="Payment QR Code"
                  className="w-full h-full"
                  onError={() => setQrFailed(true)}
                />
              </div>
            )}
            <p className="text-xs text-text-muted">{qrFailed ? 'Use the address and amount below' : 'Scan to get the address'}</p>
          </div>

          {/* Address */}
          <div>
            <p className="text-xs text-text-muted font-semibold mb-1.5">Send to Address</p>
            <div className="bg-surface-alt rounded-xl p-3 flex items-start gap-2 border border-border">
              <p className="text-xs font-mono text-text-primary break-all flex-1">{order.paymentAddress}</p>
              <CopyButton text={order.paymentAddress} />
            </div>
          </div>

          {/* Amount */}
          <div className="space-y-2">
            <GasAffiliateApplied />
            <GasPromoApplied />
            <p className="text-xs text-text-muted font-semibold mb-1.5 mt-2">Exact Amount — Send to Platform</p>
            <div className="bg-surface-alt rounded-xl p-3 flex items-center justify-between border border-border">
              <span className="text-lg font-bold text-text-primary">{order.paymentAmount} USDT</span>
              <CopyButton text={order.paymentAmount} />
            </div>
            <p className="text-xs text-text-muted mt-1.5">
              Send exactly this amount. Your wallet will also deduct a separate {order.paymentNetwork} transfer fee ({
                (() => {
                  const m = order.paymentNetwork === 'TRC20' ? cryptoMethods?.trc20
                    : order.paymentNetwork === 'BEP20' ? cryptoMethods?.bep20
                    : order.paymentNetwork === 'ERC20' ? cryptoMethods?.erc20
                    : cryptoMethods?.aptos
                  const fallback = order.paymentNetwork === 'TRC20' ? '~$1' : order.paymentNetwork === 'BEP20' ? '~$0.29' : order.paymentNetwork === 'ERC20' ? '~$2' : '~$0.01'
                  return (m as { feeNativeDisplay?: string; fee?: string } | undefined)?.feeNativeDisplay ?? (m as { fee?: string } | undefined)?.fee ?? fallback
                })()
              }) when sending.
            </p>
          </div>

          {/* Details row */}
          <div className="bg-surface-alt rounded-xl p-3 text-xs space-y-1.5 border border-border">
            <div className="flex justify-between"><span className="text-text-muted">Network</span><span className="font-bold text-text-primary">{order.paymentNetwork}</span></div>
            <div className="flex justify-between"><span className="text-text-muted">Order ID</span><span className="font-mono text-text-secondary">{order.orderRef}</span></div>
            <div className="flex justify-between gap-3 pt-1.5 border-t border-border">
              <span className="text-text-muted shrink-0">Gas delivered to</span>
              <span className="font-mono text-text-secondary break-all text-right">{order.toAddress}</span>
            </div>
          </div>

          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 flex items-start gap-2">
            <svg className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
            <p className="text-xs text-red-700 dark:text-red-300 font-medium">
              Send ONLY USDT on <strong>{order.paymentNetwork}</strong> network. Wrong network = permanent loss.
            </p>
          </div>

          {pollErrCount >= 3 && (
            <p className="text-xs text-amber-600 dark:text-amber-400 text-center">
              Connection issue. <button className="underline font-semibold" onClick={() => { setPollErrCount(0); void pollOrder() }}>Refresh</button>
            </p>
          )}

          {/* Payment sent / verify flow */}
          {verifySuccess ? (
            <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-3 text-center">
              <p className="text-sm font-bold text-green-700 dark:text-green-300 mb-0.5">Payment Submitted!</p>
              <p className="text-xs text-green-600 dark:text-green-400">{verifySuccess}</p>
            </div>
          ) : !paymentSent ? (
            <div className="space-y-2">
              <button onClick={() => setPaymentSent(true)} className="w-full py-3 rounded-xl bg-primary hover:bg-primary-hover text-white text-sm font-semibold transition-colors shadow-card">
                I&apos;ve Sent the Payment
              </button>

              {!confirmCancel ? (
                <button
                  onClick={openCancelConfirm}
                  className="w-full text-xs text-text-muted hover:text-red-600 dark:hover:text-red-400 text-center py-1 transition-colors"
                >
                  Cancel this order
                </button>
              ) : (
                <div className="bg-surface-alt border border-border rounded-xl p-4 space-y-3">
                  <p className="text-sm font-semibold text-text-primary">Cancel this order?</p>
                  <p className="text-xs text-text-muted">
                    Only cancel if you haven&apos;t sent the payment. If you already paid, keep this open so we can detect it.
                  </p>
                  {cancelPreview && (
                    cancelPreview.cooldownLabel ? (
                      <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
                        <p className="text-xs text-amber-700 dark:text-amber-300">
                          You&apos;ve cancelled {cancelPreview.priorCancels} recent gas order{cancelPreview.priorCancels === 1 ? '' : 's'}. Cancelling again will
                          {' '}<strong>block new gas orders for {cancelPreview.cooldownLabel}</strong>.
                        </p>
                      </div>
                    ) : (
                      <div className="bg-surface border border-border rounded-lg px-3 py-2">
                        <p className="text-xs text-text-muted">No penalty for this cancellation.</p>
                      </div>
                    )
                  )}
                  {cancelError && <p className="text-xs text-red-600 dark:text-red-400">{cancelError}</p>}
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setConfirmCancel(false) }}
                      disabled={cancelling}
                      className="flex-1 py-2 rounded-lg border border-border text-xs font-semibold text-text-secondary hover:bg-surface transition-colors disabled:opacity-50"
                    >
                      Keep order
                    </button>
                    <button
                      onClick={handleCancelOrder}
                      disabled={cancelling}
                      className="flex-1 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold transition-colors disabled:opacity-50"
                    >
                      {cancelling ? 'Cancelling…' : 'Yes, cancel'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : !detectElapsed && !verifyOpen ? (
            /* 60s auto-detection window */
            <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 space-y-3 text-center">
              <div className="flex items-center justify-center gap-2">
                <svg className="w-4 h-4 text-primary shrink-0 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                <p className="text-sm font-semibold text-primary">Detecting your on-chain payment…</p>
              </div>
              <p className="text-xs text-primary/80">
                We&apos;re scanning the blockchain for your USDT transfer. This usually completes within a minute — please keep this page open.
              </p>
              {detectDeadline && (
                <div className="text-2xl font-mono font-bold text-primary">
                  <CountdownTimer expiresAt={detectDeadline} showLabel={false} onExpire={() => setDetectElapsed(true)} />
                </div>
              )}
              <button onClick={() => setPaymentSent(false)} className="w-full text-xs text-primary/50 hover:text-primary text-center">
                I haven&apos;t sent yet — go back
              </button>
            </div>
          ) : !verifyOpen ? (
            /* Detection window elapsed — offer manual tx-hash verification */
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">Still detecting your payment</p>
              </div>
              <p className="text-xs text-amber-700 dark:text-amber-300">
                We haven&apos;t confirmed your payment automatically yet. If you&apos;ve already sent it, paste your transaction hash below and our team will verify it manually and release your gas.
              </p>
              <button onClick={() => setVerifyOpen(true)} className="w-full py-2.5 rounded-xl bg-primary hover:bg-primary-hover text-white text-sm font-semibold transition-colors">
                Enter Transaction Hash
              </button>
              <button onClick={() => setPaymentSent(false)} className="w-full text-xs text-amber-600 dark:text-amber-400/70 hover:text-amber-700 dark:hover:text-amber-300 text-center">
                I haven&apos;t sent yet — go back
              </button>
            </div>
          ) : (
            <VerifyHashForm
              verifyTxHash={verifyTxHash}
              setVerifyTxHash={setVerifyTxHash}
              verifyError={verifyError}
              verifying={verifying}
              handleVerifyPayment={handleVerifyPayment}
              onClose={() => { setVerifyOpen(false); }}
            />
          )}
        </>
      )}

      {order.status === 'payment_verified' && (
        <div className="text-center py-4">
          <p className="text-sm font-bold text-green-700 dark:text-green-300 mb-1">Payment Verified</p>
          <p className="text-xs text-text-muted">Your payment has been confirmed on-chain. Gas will be released shortly.</p>
        </div>
      )}

      {(order.status === 'payment_detected' || order.status === 'sending') && (() => {
        const startTs = order.createdAt ? new Date(order.createdAt).getTime() : nowTs
        const stuckMs = nowTs - startTs
        // Self-refund only while paused in payment_detected — never during an
        // in-flight 'sending' (matches the backend, which rejects 'sending').
        const refundEligible = order.status === 'payment_detected' &&
          (!!order.failureReason || stuckMs >= STUCK_REFUND_THRESHOLD_MS)
        return (
          <div className="space-y-4">
            <div>
              <p className="text-xs font-bold text-text-muted uppercase tracking-wide mb-4">Processing</p>
              <ProcessingTimeline status={order.status} isPkr={false} />
            </div>

            {/* Delivery-delay notice — payment is safe; offer a self-serve refund once stuck. */}
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 space-y-2">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">Your payment is confirmed</p>
              </div>
              <p className="text-xs text-amber-700 dark:text-amber-300">
                We&apos;re delivering your gas now. This occasionally takes a few minutes. Your USDT is safe — if we can&apos;t
                deliver, it&apos;s refunded automatically to the wallet you paid from.
              </p>
              {refundEligible ? (
                <div className="pt-1 space-y-2">
                  <p className="text-xs text-amber-700 dark:text-amber-300">Taking longer than expected? You can request your refund now.</p>
                  {refundReqError && <p className="text-xs text-red-600 dark:text-red-400">{refundReqError}</p>}
                  <button
                    onClick={handleRequestRefund}
                    disabled={requestingRefund}
                    className="w-full py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold transition-colors disabled:opacity-50"
                  >
                    {requestingRefund ? 'Requesting refund…' : 'Request refund now'}
                  </button>
                </div>
              ) : (
                <p className="text-xs text-amber-600 dark:text-amber-400/80 pt-1">
                  If it isn&apos;t delivered shortly, a refund option will appear here.
                </p>
              )}
            </div>
          </div>
        )
      })()}

      {(order.status === 'expired' || order.status === 'failed') && (
        <div className="text-center py-4">
          <p className="text-base font-bold text-red-600 dark:text-red-400 mb-2">{order.status === 'expired' ? 'Order Expired' : 'Order Failed'}</p>
          {order.status === 'expired' ? (
            <>
              <p className="text-sm text-text-muted mb-3">Payment not received in time.</p>
              {!verifyOpen && !verifySuccess ? (
                <div className="mb-4 space-y-2">
                  <p className="text-xs text-text-muted">Already sent the payment? We can still verify it.</p>
                  <button onClick={() => setVerifyOpen(true)} className="text-xs text-blue-600 dark:text-blue-400 underline underline-offset-2 hover:text-blue-800 dark:hover:text-blue-300 font-semibold">
                    Enter transaction hash to verify
                  </button>
                </div>
              ) : verifySuccess ? (
                <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-3 text-center mb-4">
                  <p className="text-sm font-bold text-green-700 dark:text-green-300 mb-0.5">Payment Verified!</p>
                  <p className="text-xs text-green-600 dark:text-green-400">{verifySuccess}</p>
                </div>
              ) : (
                <div className="mb-4">
                  <VerifyHashForm
                    verifyTxHash={verifyTxHash}
                    setVerifyTxHash={setVerifyTxHash}
                    verifyError={verifyError}
                    verifying={verifying}
                    handleVerifyPayment={handleVerifyPayment}
                    onClose={() => setVerifyOpen(false)}
                    label="Verify Your Payment"
                    hint="Enter the transaction hash from your wallet. If you paid before the timer expired, we'll process your order."
                    buttonLabel="Verify Payment"
                  />
                </div>
              )}
              <Button onClick={resetFlow}>Create New Order</Button>
            </>
          ) : (
            <>
              <p className="text-sm text-text-muted mb-4">Something went wrong.</p>
              <Button onClick={resetFlow}>Try Again</Button>
            </>
          )}
        </div>
      )}

      {order.status === 'cancelled' && (
        <div className="text-center py-4">
          <p className="text-base font-bold text-text-primary mb-2">Order Cancelled</p>
          <p className="text-sm text-text-muted mb-3">This gas order was cancelled. No payment was taken.</p>
          {cancelResult?.cooldownLabel && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2 mb-4 text-left">
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Because of repeated cancellations, new gas orders are paused for <strong>{cancelResult.cooldownLabel}</strong>. Thanks for understanding.
              </p>
            </div>
          )}
          <Button onClick={resetFlow}>Create New Order</Button>
        </div>
      )}

      {(order.status === 'refund_pending' || order.status === 'refunded') && (
        <div className="space-y-4">
          <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2">
            <p className="text-sm font-bold text-amber-700 dark:text-amber-300 mb-0.5">{order.status === 'refund_pending' ? 'Refunding Your Payment' : 'USDT Refunded'}</p>
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {order.status === 'refund_pending'
                ? "We couldn't deliver your gas, so your USDT is being sent back to the wallet you paid from. No action needed."
                : 'Your USDT has been sent back to the wallet you paid from.'}
            </p>
          </div>
          <RefundTimeline status={order.status} />
        </div>
      )}

      {order.status === 'delivered' && (
        <Button className="w-full" onClick={() => setPhase(PHASE.COMPLETE)}>View Completion</Button>
      )}
    </div>
  )
}

function VerifyHashForm({
  verifyTxHash, setVerifyTxHash,
  verifyError, verifying, handleVerifyPayment,
  onClose,
  label = 'Enter Transaction Hash',
  hint = "Paste your transaction hash from your wallet or blockchain explorer. We'll verify it (manually if needed) and release your gas shortly.",
  buttonLabel = 'Confirm Payment',
}: {
  verifyTxHash: string
  setVerifyTxHash: (v: string) => void
  verifyError: string
  verifying: boolean
  handleVerifyPayment: () => Promise<void>
  onClose: () => void
  label?: string
  hint?: string
  buttonLabel?: string
}) {
  return (
    <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold text-blue-800 dark:text-blue-300">{label}</p>
        <button onClick={onClose} className="text-blue-400 hover:text-blue-600 dark:hover:text-blue-400 text-lg leading-none" aria-label="Close">&times;</button>
      </div>
      <p className="text-xs text-blue-700 dark:text-blue-300">{hint}</p>
      <input
        type="text"
        value={verifyTxHash}
        onChange={e => setVerifyTxHash(e.target.value)}
        placeholder="0x... transaction hash"
        className="w-full text-xs font-mono bg-surface border border-blue-500/30 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 placeholder:text-text-disabled"
      />
      {verifyError && <p className="text-xs text-red-600 dark:text-red-400">{verifyError}</p>}
      <Button onClick={handleVerifyPayment} disabled={verifying || !verifyTxHash.trim()} className="w-full text-sm">
        {verifying ? 'Verifying…' : buttonLabel}
      </Button>
    </div>
  )
}
