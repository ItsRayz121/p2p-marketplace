'use client'
import { useState } from 'react'
import { Check, ShieldCheck } from 'lucide-react'
import { supportChatApi, REFUND_NETWORKS, type RefundNetwork, type SupportMessage } from '@/lib/supportChat'
import { toast } from '@/lib/toast'

// Basic per-rail address sanity check (mirrors the backend). Keeps the user from
// submitting an address the refund engine can't pay out to.
function looksValid(network: RefundNetwork, address: string): boolean {
  const a = address.trim()
  if (network === 'TRC20') return /^T[A-Za-z1-9]{33}$/.test(a)
  if (network === 'BEP20' || network === 'ERC20') return /^0x[0-9a-fA-F]{40}$/.test(a)
  // Full 64-hex Aptos address — matches what the refund engine will accept.
  if (network === 'APTOS') return /^0x[0-9a-fA-F]{64}$/.test(a)
  return false
}

/**
 * Renders an admin `refund_request` message as an inline form. If the user has
 * already answered (a matching `refund_response` exists), shows the submitted
 * destination read-only instead.
 */
export function RefundAddressForm({
  request,
  answer,
  onSubmitted,
}: {
  request: SupportMessage
  answer: SupportMessage | null
  onSubmitted: (msg: SupportMessage) => void
}) {
  const answeredNetwork = (answer?.metadata?.network as string | undefined) ?? null
  const answeredAddress = (answer?.metadata?.address as string | undefined) ?? null
  const orderRef = (request.metadata?.orderRef as string | undefined) ?? null

  const [network, setNetwork] = useState<RefundNetwork>('BEP20')
  const [address, setAddress] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    const addr = address.trim()
    if (!looksValid(network, addr)) {
      toast.error(`That doesn't look like a valid ${network} address.`)
      return
    }
    setSubmitting(true)
    try {
      const msg = await supportChatApi.refundResponse(request.id, network, addr)
      onSubmitted(msg)
      toast.success('Refund address sent. Our team will process it shortly.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not submit. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-2xl border border-primary/30 bg-primary/5 px-3 py-3 space-y-2.5">
      <div className="flex items-center gap-1.5 text-primary">
        <ShieldCheck className="w-4 h-4 flex-shrink-0" />
        <span className="text-xs font-semibold">Refund destination{orderRef ? ` · ${orderRef}` : ''}</span>
      </div>
      <p className="text-sm text-text-primary whitespace-pre-wrap break-words">{request.body}</p>

      {answeredAddress ? (
        <div className="rounded-xl border border-success/30 bg-success/10 px-3 py-2 text-sm">
          <div className="flex items-center gap-1.5 text-success font-semibold text-xs mb-1">
            <Check className="w-3.5 h-3.5" /> Address submitted
          </div>
          <p className="font-mono text-xs break-all text-text-primary">{answeredAddress}</p>
          <p className="text-[11px] text-text-muted mt-0.5">Network: {answeredNetwork}</p>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {REFUND_NETWORKS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setNetwork(n)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-colors ${
                  network === n
                    ? 'bg-primary text-white border-primary'
                    : 'bg-surface text-text-muted border-border hover:border-primary/40'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={`Your ${network} USDT address`}
            spellCheck={false}
            className="w-full px-3 py-2 text-sm bg-surface border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary text-text-primary font-mono"
          />
          <button
            onClick={submit}
            disabled={submitting || !address.trim()}
            className="w-full py-2 rounded-xl bg-primary text-white text-sm font-semibold disabled:opacity-40 hover:bg-primary/90 transition-colors"
          >
            {submitting ? 'Sending…' : 'Send refund address'}
          </button>
          <p className="text-[10px] text-text-muted">
            Only send an address you control. This is where your {orderRef ? 'gas ' : ''}refund will be sent as USDT.
          </p>
        </div>
      )}
    </div>
  )
}
