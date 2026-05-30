'use client'
import { Suspense, useEffect, useState, useRef } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { walletApi } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'

type Stage = 'loading' | 'confirmed' | 'cancelled' | 'error'

function ConfirmWithdrawalContent() {
  const params = useSearchParams()
  const router = useRouter()

  const [stage, setStage] = useState<Stage>('loading')
  const [message, setMessage] = useState('')
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true

    const wid = params.get('wid')
    const token = params.get('token')
    const cancelToken = params.get('cancel')

    if (!wid) {
      setStage('error')
      setMessage('Invalid link — missing withdrawal ID.')
      return
    }

    if (cancelToken) {
      walletApi
        .cancelWithdrawal(wid, cancelToken)
        .then(() => {
          setStage('cancelled')
          setMessage('Your withdrawal has been cancelled successfully.')
        })
        .catch((err: { message?: string }) => {
          setStage('error')
          setMessage(err?.message ?? 'This cancel link is invalid or has already been used.')
        })
      return
    }

    if (!token) {
      setStage('error')
      setMessage('Invalid link — missing confirmation token.')
      return
    }

    walletApi
      .confirmWithdrawal(wid, token)
      .then(() => {
        setStage('confirmed')
        setMessage('Your withdrawal has been confirmed and is now being processed.')
      })
      .catch((err: { message?: string }) => {
        setStage('error')
        setMessage(err?.message ?? 'This confirmation link is invalid or has expired.')
      })
  }, [params])

  const icon = {
    loading: null,
    confirmed: '✓',
    cancelled: '✕',
    error: '⚠',
  }[stage]

  const color = {
    loading: '',
    confirmed: 'text-emerald-600',
    cancelled: 'text-slate-500',
    error: 'text-red-600',
  }[stage]

  const heading = {
    loading: 'Processing…',
    confirmed: 'Withdrawal Confirmed',
    cancelled: 'Withdrawal Cancelled',
    error: 'Link Invalid',
  }[stage]

  return (
    <>
      {stage === 'loading' ? (
        <div className="flex justify-center py-8">
          <Spinner className="w-10 h-10" />
        </div>
      ) : (
        <>
          <div className={`text-5xl font-bold ${color}`}>{icon}</div>
          <h2 className="text-xl font-semibold text-text-primary">{heading}</h2>
          <p className="text-text-muted text-sm">{message}</p>
        </>
      )}

      {(stage === 'confirmed' || stage === 'cancelled') && (
        <Button
          onClick={() => router.push('/wallet')}
          className="w-full mt-4"
        >
          Go to Wallet
        </Button>
      )}

      {stage === 'error' && (
        <div className="space-y-2">
          <p className="text-text-muted text-xs">
            If this keeps happening, check your email for the latest confirmation link or contact support.
          </p>
          <Button variant="secondary" onClick={() => router.push('/wallet')} className="w-full">
            Go to Wallet
          </Button>
        </div>
      )}
    </>
  )
}

export default function ConfirmWithdrawalPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="max-w-md w-full bg-surface border border-border rounded-2xl p-8 text-center space-y-4">
        <h1 className="text-2xl font-bold text-text-primary">RupChain</h1>
        <Suspense
          fallback={
            <div className="flex justify-center py-8">
              <Spinner className="w-10 h-10" />
            </div>
          }
        >
          <ConfirmWithdrawalContent />
        </Suspense>
      </div>
    </div>
  )
}
