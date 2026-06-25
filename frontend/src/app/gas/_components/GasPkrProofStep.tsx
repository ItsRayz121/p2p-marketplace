'use client'
import { Spinner } from '@/components/ui/Spinner'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/CopyButton'
import { useGasCtx } from './GasContext'
import { CardHeader, PkrMethodIcon } from './GasPrimitives'
import { PKR_METHOD_META } from './GasContext'
import { GasPromoApplied } from './GasPromo'

export function GasPkrProofStep() {
  const {
    order, selectedPkrMethod, pkrMethods,
    effectivePkr, getPkrDetails,
    proofUrl, uploading, uploadError,
    handleUploadFile, handleSubmitProof,
    submittingProof, proofError,
  } = useGasCtx()

  if (!order || !selectedPkrMethod) return null

  const details = getPkrDetails()

  return (
    <div className="p-5 space-y-4">
      <CardHeader title="Make Payment" sub={`Order #${order.orderRef}`} />

      <GasPromoApplied />

      <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <PkrMethodIcon methodKey={selectedPkrMethod} pkrMethods={pkrMethods} sizeCls="w-8 h-8" />
          <p className="text-sm font-bold text-text-primary">Send via {PKR_METHOD_META[selectedPkrMethod].label}</p>
        </div>

        <div className="bg-surface shadow-card rounded-xl p-3 flex items-center justify-between">
          <span className="text-xs text-text-muted">Amount to Send</span>
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold text-green-700 dark:text-green-300">PKR {order.pkrAmount ?? effectivePkr.toFixed(0)}</span>
            <CopyButton text={String(order.pkrAmount ?? effectivePkr.toFixed(0))} />
          </div>
        </div>

        {!details || details.length === 0 ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">Payment account details not configured yet. Please contact support.</p>
        ) : (
          <div className="space-y-2">
            {details.map(({ label, value }) => value && (
              <div key={label} className="bg-surface rounded-xl px-3 py-2.5 flex items-center justify-between">
                <span className="text-xs text-text-muted">{label}</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-text-primary font-mono">{value}</span>
                  <CopyButton text={value} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 flex items-start gap-2">
        <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
        <p className="text-xs text-amber-700 dark:text-amber-300 font-medium">
          Send <strong>exactly PKR {order.pkrAmount ?? effectivePkr.toFixed(0)}</strong> and upload your payment screenshot below.
        </p>
      </div>

      <div>
        <p className="text-xs font-semibold text-text-secondary mb-2">Upload Payment Screenshot</p>
        <label className={`flex flex-col items-center justify-center gap-2 h-32 rounded-xl border-2 border-dashed cursor-pointer transition-colors ${proofUrl ? 'border-green-500/50 bg-green-500/10' : 'border-border hover:border-primary/30 bg-surface-alt'}`}>
          <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={e => { const f = e.target.files?.[0]; if (f) handleUploadFile(f) }} />
          {uploading
            ? <><Spinner size="md" /><p className="text-xs text-text-muted">Uploading...</p></>
            : proofUrl
            ? <><svg className="w-8 h-8 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg><p className="text-xs text-green-600 dark:text-green-400 font-semibold">Screenshot uploaded</p><p className="text-xs text-text-muted">Click to replace</p></>
            : <><svg className="w-8 h-8 text-text-disabled" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg><p className="text-xs text-text-muted">Click to upload screenshot</p><p className="text-xs text-text-muted">JPEG, PNG, WebP · Max 10MB</p></>
          }
        </label>
        {uploadError && <p className="text-xs text-red-500 mt-1">{uploadError}</p>}
      </div>

      {proofError && <p className="text-sm text-red-500 bg-red-500/10 rounded-xl px-3 py-2">{proofError}</p>}

      <Button className="w-full" disabled={!proofUrl || submittingProof} loading={submittingProof} onClick={handleSubmitProof}>
        {submittingProof ? 'Submitting...' : 'Submit Payment Proof'}
      </Button>
    </div>
  )
}
