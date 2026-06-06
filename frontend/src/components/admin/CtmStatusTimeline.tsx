// Happy-path lifecycle of a CTM trade, in order. Terminal states (cancelled /
// expired / disputed) are handled separately.
export const CTM_TIMELINE: Array<{ key: string; label: string }> = [
  { key: 'awaiting_payment', label: 'Created' },
  { key: 'payment_uploaded', label: 'Payment sent' },
  { key: 'payment_confirmed', label: 'Payment confirmed' },
  { key: 'seller_transferring', label: 'Transferring' },
  { key: 'proof_submitted', label: 'Proof submitted' },
  { key: 'completed', label: 'Released' },
]

export function CtmStatusTimeline({ status }: { status: string }) {
  const terminalBad = ['cancelled', 'expired'].includes(status)
  const disputed = ['disputed', 'dispute_resolved'].includes(status)
  // dispute_resolved counts as released for progress purposes
  const effective = status === 'dispute_resolved' ? 'completed' : status
  const reachedIdx = CTM_TIMELINE.findIndex((s) => s.key === effective)
  return (
    <div>
      <div className="flex items-center">
        {CTM_TIMELINE.map((step, i) => {
          const done = reachedIdx >= 0 && i <= reachedIdx
          return (
            <div key={step.key} className="flex items-center flex-1 last:flex-none">
              <div className="flex flex-col items-center">
                <div className={`w-3 h-3 rounded-full ${done ? 'bg-primary' : 'bg-surface-alt border border-border'}`} />
                <span className={`mt-1 text-[9px] text-center leading-tight ${done ? 'text-text-secondary' : 'text-text-muted'}`}>{step.label}</span>
              </div>
              {i < CTM_TIMELINE.length - 1 && (
                <div className={`h-0.5 flex-1 mx-1 ${reachedIdx > i ? 'bg-primary' : 'bg-surface-alt'}`} />
              )}
            </div>
          )
        })}
      </div>
      {(terminalBad || disputed) && (
        <p className={`mt-2 text-xs font-medium ${disputed ? 'text-danger' : 'text-text-muted'}`}>
          {disputed ? 'This trade went to dispute.' : `Trade ${status}.`}
        </p>
      )}
    </div>
  )
}
