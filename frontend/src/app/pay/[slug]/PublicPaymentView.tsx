'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ShieldCheck } from 'lucide-react'
import { ApiError, paymentShareApi, type PublicPaymentPage } from '@/lib/api'
import { BrandLogo } from '@/components/ui/BrandLogo'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { Spinner } from '@/components/ui/Spinner'
import { Button } from '@/components/ui/Button'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { hapticSelection } from '@/lib/telegram'
import { toast } from '@/lib/toast'

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; page: PublicPaymentPage }
  | { status: 'unavailable' }
  | { status: 'error' }

/** One copyable value (account number, IBAN, mobile number) with a large, obvious Copy button. */
function CopyRow({ label, value }: { label: string; value: string }) {
  const { copy, copied } = useCopyToClipboard()
  async function onCopy() {
    hapticSelection()
    if (!(await copy(value))) toast.error('Could not copy — press and hold the number to copy it')
  }
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-surface-alt px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wide text-text-muted">{label}</p>
        <p className="font-mono text-sm sm:text-base font-semibold text-text-primary break-all select-all">{value}</p>
      </div>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? `${label} copied` : `Copy ${label.toLowerCase()}`}
        className={`flex-shrink-0 min-h-[44px] min-w-[84px] rounded-lg px-3 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
          copied ? 'bg-success/15 text-success' : 'bg-primary text-white hover:bg-primary-hover active:scale-[0.98]'
        }`}
      >
        <span role="status">{copied ? 'Copied ✓' : 'Copy'}</span>
      </button>
    </div>
  )
}

export default function PublicPaymentView({ slug }: { slug: string }) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ status: 'loading' })
    try {
      const page = await paymentShareApi.getPublic(slug, signal)
      setState({ status: 'ready', page })
    } catch (err) {
      if (signal?.aborted) return
      // A missing, malformed or disabled link all look the same on purpose.
      setState(err instanceof ApiError && (err.status === 404 || err.status === 400) ? { status: 'unavailable' } : { status: 'error' })
    }
  }, [slug])

  useEffect(() => {
    const ctrl = new AbortController()
    void load(ctrl.signal)
    return () => ctrl.abort()
  }, [load])

  return (
    <main className="min-h-screen bg-canvas">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-lg items-center gap-2.5 px-4 py-3">
          <BrandLogo size={32} className="w-8 h-8" priority />
          <span className="text-base font-bold text-text-primary">RupChain</span>
        </div>
      </header>

      <div className="mx-auto max-w-lg px-4 py-6 sm:py-10">
        {state.status === 'loading' && (
          <div className="flex justify-center py-20" role="status" aria-label="Loading payment details"><Spinner /></div>
        )}

        {state.status === 'unavailable' && (
          <div className="rounded-2xl border border-border bg-surface px-6 py-12 text-center shadow-card">
            <h1 className="text-lg font-semibold text-text-primary">This payment link is currently unavailable</h1>
            <p className="mt-2 text-sm text-text-muted">The link may have been turned off or replaced. Ask the person who sent it for a new one.</p>
            <Link href="/" className="mt-6 inline-block text-sm font-medium text-primary hover:underline">Go to RupChain</Link>
          </div>
        )}

        {state.status === 'error' && (
          <div className="rounded-2xl border border-border bg-surface px-6 py-12 text-center shadow-card">
            <h1 className="text-lg font-semibold text-text-primary">Couldn&apos;t load payment details</h1>
            <p className="mt-2 text-sm text-text-muted">Check your connection and try again.</p>
            <Button className="mt-6" onClick={() => void load()}>Try again</Button>
          </div>
        )}

        {state.status === 'ready' && (
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <UserAvatar name={state.page.displayName} avatarUrl={state.page.avatarUrl} size="lg" />
              <div className="min-w-0">
                <h1 className="truncate text-xl font-bold text-text-primary">Pay {state.page.displayName}</h1>
                <p className="text-sm text-text-muted">PKR payment methods</p>
              </div>
            </div>

            {state.page.methods.length === 0 ? (
              <div className="rounded-2xl border border-border bg-surface px-6 py-10 text-center text-sm text-text-muted shadow-card">
                No payment methods are being shared right now.
              </div>
            ) : (
              <ul className="space-y-3">
                {state.page.methods.map((m, i) => (
                  <li key={`${m.type}-${i}`} className="rounded-2xl border border-border bg-surface p-4 shadow-card">
                    <div className="mb-3 flex items-center gap-3">
                      <EntityLogo type={m.type === 'bank_transfer' ? 'bank' : 'payment_method'} slug={m.bankName ?? m.label} size="md" className="flex-shrink-0" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-text-primary">{m.label}</p>
                        <p className="truncate text-sm text-text-muted">{m.accountName}</p>
                      </div>
                    </div>
                    <div className="space-y-2">
                      {m.numbers.map((n) => <CopyRow key={n.label} label={n.label} value={n.value} />)}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <p className="flex items-start gap-2 text-xs text-text-muted">
              <ShieldCheck size={14} className="mt-0.5 flex-shrink-0" aria-hidden />
              Check that the account name matches the person you intend to pay before sending money.
            </p>
          </div>
        )}
      </div>
    </main>
  )
}
