'use client'
import { Spinner } from '@/components/ui/Spinner'
import { UploadProgress } from '@/components/ui/UploadProgress'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/CopyButton'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { useGasCtx, PHASE } from './GasContext'
import { CardHeader } from './GasPrimitives'
import { GasPromoField, GasPromoApplied, GasAffiliateApplied } from './GasPromo'

/**
 * Exchange transfer. Two stages on one screen:
 *   A. no order yet  → pick which exchange you will send from, then "Show transfer
 *      details" creates the order (locking the price) — same moment the PKR flow
 *      creates its order.
 *   B. order exists  → show OUR UID + exact amount, and collect the customer's own
 *      exchange UID + transfer order id (+ optional screenshot) for manual review.
 */
export function GasExchangeStep() {
  const {
    order, setPhase, exchangeAccounts, exchangeAccountsLoading,
    selectedExchangeId, setSelectedExchangeId,
    creatingExchange, exchangeError, handleCreateExchangeOrder,
    exchangeUserUid, setExchangeUserUid, exchangeOrderId, setExchangeOrderId,
    submittingExchange, handleSubmitExchangeProof,
    proofUrl, uploading, uploadProgress, uploadError, handleUploadFile,
    effectiveUsd,
  } = useGasCtx()

  const isExchangeOrder = !!order && order.paymentNetwork === 'EXCHANGE'

  // ── Stage A: pick the exchange ──────────────────────────────────────────────
  if (!isExchangeOrder) {
    return (
      <div className="p-5 space-y-4">
        <CardHeader onBack={() => setPhase(PHASE.USDT_METHOD)} title="Exchange transfer" sub="Which exchange will you send from?" />

        {exchangeAccountsLoading && !exchangeAccounts && (
          <div className="flex justify-center py-6"><Spinner size="md" /></div>
        )}

        {exchangeAccounts && exchangeAccounts.length === 0 && (
          <p className="text-sm text-text-muted bg-surface-alt rounded-xl px-3 py-3">
            Exchange transfer is not available right now. Please pay with a blockchain transfer instead.
          </p>
        )}

        {exchangeAccounts && exchangeAccounts.length > 0 && (
          <div className="grid grid-cols-3 gap-2">
            {exchangeAccounts.map((a) => {
              const sel = selectedExchangeId === a.id
              return (
                <button
                  key={a.id}
                  onClick={() => setSelectedExchangeId(a.id)}
                  aria-pressed={sel}
                  className={`flex flex-col items-center gap-2 p-3 rounded-xl border-2 transition-all ${
                    sel ? 'border-primary bg-primary/5' : 'border-border bg-surface hover:border-primary/30'
                  }`}
                >
                  <EntityLogo type="exchange" slug={a.exchange} size="xl" className="w-10 h-10 rounded-xl" />
                  <span className="text-xs font-bold text-text-primary truncate max-w-full">{a.displayName}</span>
                </button>
              )
            })}
          </div>
        )}

        <GasAffiliateApplied />
        <GasPromoField />

        {exchangeError && <p className="text-sm text-red-500 bg-red-500/10 rounded-xl px-3 py-2">{exchangeError}</p>}

        <Button
          className="w-full"
          disabled={!selectedExchangeId || creatingExchange}
          loading={creatingExchange}
          onClick={handleCreateExchangeOrder}
        >
          {creatingExchange ? 'Creating order…' : 'Show transfer details'}
        </Button>
      </div>
    )
  }

  // ── Stage B: send, then submit UID + order id ───────────────────────────────
  const amountLabel = Number(order.paymentAmount ?? effectiveUsd).toFixed(2)
  const exchangeSlug = exchangeAccounts?.find((a) => a.displayName === order.exchangeName)?.exchange
    ?? (order.exchangeName ?? '').toLowerCase()
  const canSubmit = exchangeUserUid.trim().length >= 3 && exchangeOrderId.trim().length >= 4

  return (
    <div className="p-5 space-y-4">
      <CardHeader title="Exchange transfer" sub={`Order #${order.orderRef}`} />

      <GasAffiliateApplied />
      <GasPromoApplied />

      <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <EntityLogo type="exchange" slug={exchangeSlug} size="lg" className="w-8 h-8 rounded-lg" />
          <p className="text-sm font-bold text-text-primary">Send an internal transfer on {order.exchangeName}</p>
        </div>

        <div className="bg-surface shadow-card rounded-xl px-3 py-2.5 flex items-center justify-between">
          <span className="text-xs text-text-muted">Account UID</span>
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-text-primary font-mono">{order.exchangeAccountUid}</span>
            <CopyButton text={order.exchangeAccountUid ?? ''} />
          </div>
        </div>
        <div className="bg-surface shadow-card rounded-xl px-3 py-2.5 flex items-center justify-between">
          <span className="text-xs text-text-muted">Exact amount</span>
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold text-amber-700 dark:text-amber-300">{amountLabel} USDT</span>
            <CopyButton text={amountLabel} />
          </div>
        </div>
      </div>

      <ol className="space-y-2 text-xs text-text-secondary">
        <li className="flex gap-2"><span className="w-5 h-5 flex-shrink-0 rounded-full bg-primary/10 text-primary font-bold flex items-center justify-center">1</span>Open {order.exchangeName} and choose <strong>Internal transfer</strong> (Pay / UID transfer).</li>
        <li className="flex gap-2"><span className="w-5 h-5 flex-shrink-0 rounded-full bg-primary/10 text-primary font-bold flex items-center justify-center">2</span>Copy the UID above and send exactly <strong>{amountLabel} USDT</strong>.</li>
        <li className="flex gap-2"><span className="w-5 h-5 flex-shrink-0 rounded-full bg-primary/10 text-primary font-bold flex items-center justify-center">3</span>Come back here and enter your exchange UID and the transfer order ID.</li>
      </ol>

      <div className="space-y-3">
        <div>
          <label htmlFor="ex-uid" className="text-xs font-semibold text-text-secondary">Your exchange UID</label>
          <input
            id="ex-uid" value={exchangeUserUid} onChange={(e) => setExchangeUserUid(e.target.value)}
            inputMode="numeric" autoComplete="off" placeholder="The UID of the account you sent from"
            className="mt-1 w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-text-primary focus:outline-none focus:border-primary"
          />
        </div>
        <div>
          <label htmlFor="ex-oid" className="text-xs font-semibold text-text-secondary">Transfer order ID</label>
          <input
            id="ex-oid" value={exchangeOrderId} onChange={(e) => setExchangeOrderId(e.target.value)}
            autoComplete="off" placeholder="e.g. 4829103847562"
            className="mt-1 w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-text-primary focus:outline-none focus:border-primary"
          />
        </div>
        <div>
          <p className="text-xs font-semibold text-text-secondary mb-1.5">Screenshot of the transfer <span className="font-normal text-text-muted">(optional, speeds up review)</span></p>
          <label className={`flex items-center justify-center gap-2 h-20 rounded-xl border-2 border-dashed cursor-pointer transition-colors ${proofUrl ? 'border-green-500/50 bg-green-500/10' : 'border-border hover:border-primary/30 bg-surface-alt'}`}>
            <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUploadFile(f) }} />
            {uploading
              ? <><Spinner size="sm" /><span className="text-xs text-text-muted">Uploading…</span></>
              : proofUrl
              ? <span className="text-xs text-green-600 dark:text-green-400 font-semibold">Screenshot uploaded · tap to replace</span>
              : <span className="text-xs text-text-muted">Tap to upload a screenshot</span>}
          </label>
          {uploading && uploadProgress && <UploadProgress progress={uploadProgress} className="mt-2" />}
          {uploadError && <p className="text-xs text-red-500 mt-1">{uploadError}</p>}
        </div>
      </div>

      {exchangeError && <p className="text-sm text-red-500 bg-red-500/10 rounded-xl px-3 py-2">{exchangeError}</p>}

      <Button className="w-full" disabled={!canSubmit || submittingExchange || uploading} loading={submittingExchange} onClick={handleSubmitExchangeProof}>
        {submittingExchange ? 'Submitting…' : 'I have sent it'}
      </Button>

      <p className="text-xs text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2">
        Send only from an account in your own name and only the exact amount. Our team checks each transfer, which usually takes 5 to 10 minutes and can take longer.
      </p>
    </div>
  )
}
