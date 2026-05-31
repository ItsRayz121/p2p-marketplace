'use client'
import { useState, useRef, useCallback, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { authApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { Button } from '@/components/ui/Button'
import { useCountdown } from '@/hooks/useCountdown'
import { cn } from '@/lib/utils'

const OTP_LENGTH = 6

function VerifyEmailContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const email = searchParams.get('email') ?? ''
  const setAccessToken = useAuthStore((s) => s.setAccessToken)
  const setUser = useAuthStore((s) => s.setUser)

  const [digits, setDigits] = useState<string[]>(Array(OTP_LENGTH).fill(''))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resendExpiry, setResendExpiry] = useState(
    () => new Date(Date.now() + 60_000).toISOString(),
  )
  const [resendLoading, setResendLoading] = useState(false)
  const inputRefs = useRef<Array<HTMLInputElement | null>>(Array(OTP_LENGTH).fill(null))

  const { formatted, isExpired } = useCountdown(resendExpiry)

  const focusInput = (index: number) => {
    inputRefs.current[Math.max(0, Math.min(OTP_LENGTH - 1, index))]?.focus()
  }

  const submitCode = useCallback(
    async (code: string) => {
      if (!email) return
      setLoading(true)
      setError(null)
      try {
        const result = await authApi.verifyEmail({ email, code })
        // Backend now auto-creates a session on verify — store the token
        // so the user is immediately logged in without a separate login step.
        setAccessToken(result.accessToken)
        setUser(result.user)
        router.push('/setup-username')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Invalid or expired code. Please try again.')
        setDigits(Array(OTP_LENGTH).fill(''))
        setTimeout(() => focusInput(0), 0)
      } finally {
        setLoading(false)
      }
    },
    [email, router],
  )

  function handleChange(index: number, value: string) {
    const digit = value.replace(/\D/g, '').slice(-1)
    const next = [...digits]
    next[index] = digit
    setDigits(next)

    if (digit && index < OTP_LENGTH - 1) {
      focusInput(index + 1)
    }

    const filled = next.join('')
    if (filled.length === OTP_LENGTH && !filled.includes('')) {
      submitCode(filled)
    }
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace') {
      e.preventDefault()
      if (digits[index]) {
        const next = [...digits]
        next[index] = ''
        setDigits(next)
      } else if (index > 0) {
        const next = [...digits]
        next[index - 1] = ''
        setDigits(next)
        focusInput(index - 1)
      }
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    e.preventDefault()
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH)
    if (!pasted) return

    const next = Array(OTP_LENGTH).fill('')
    for (let i = 0; i < pasted.length; i++) next[i] = pasted[i]
    setDigits(next)
    focusInput(Math.min(pasted.length, OTP_LENGTH - 1))

    if (pasted.length === OTP_LENGTH) {
      submitCode(pasted)
    }
  }

  async function handleResend() {
    if (!email || resendLoading) return
    setResendLoading(true)
    setError(null)
    try {
      await authApi.resendOtp(email)
      setResendExpiry(new Date(Date.now() + 60_000).toISOString())
      setDigits(Array(OTP_LENGTH).fill(''))
      setTimeout(() => focusInput(0), 0)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resend code. Please try again.')
    } finally {
      setResendLoading(false)
    }
  }

  useEffect(() => {
    focusInput(0)
  }, [])

  return (
    <div>
      <h2 className="text-xl font-semibold text-text-primary mb-1">Verify Your Email</h2>
      <p className="text-text-muted text-sm mb-8">
        Enter the 6-digit code sent to{' '}
        <span className="font-medium text-text-primary break-all">{email || 'your email'}</span>
      </p>

      <div className="flex justify-center gap-2 mb-6" role="group" aria-label="One-time passcode">
        {digits.map((digit, i) => (
          <input
            key={i}
            ref={(el) => { inputRefs.current[i] = el }}
            type="text"
            inputMode="numeric"
            maxLength={1}
            value={digit}
            onChange={(e) => handleChange(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            onPaste={handlePaste}
            disabled={loading}
            aria-label={`Digit ${i + 1}`}
            className={cn(
              'w-12 h-14 text-center text-xl font-semibold rounded-lg border bg-surface text-text-primary',
              'transition-colors focus:outline-none focus:ring-2 focus:ring-offset-0',
              error
                ? 'border-danger focus:ring-danger/30'
                : 'border-border focus:ring-primary/30 focus:border-primary',
              loading && 'opacity-50 cursor-not-allowed',
            )}
          />
        ))}
      </div>

      {error && (
        <p className="text-sm text-danger bg-danger/5 border border-danger/20 rounded-lg px-3 py-2 mb-4 text-center">
          {error}
        </p>
      )}

      {loading && (
        <p className="text-sm text-text-muted text-center mb-4">Verifying…</p>
      )}

      <div className="flex flex-col items-center gap-2 mt-2">
        {isExpired ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleResend}
            loading={resendLoading}
            disabled={resendLoading}
          >
            Resend OTP
          </Button>
        ) : (
          <p className="text-sm text-text-muted">
            Resend code in <span className="font-medium text-text-primary tabular-nums">{formatted}</span>
          </p>
        )}

        <button
          type="button"
          onClick={() => router.push('/register')}
          className="text-sm text-text-muted hover:text-primary transition-colors focus:outline-none"
        >
          Wrong email?{' '}
          <span className="text-primary font-medium hover:underline">Change email</span>
        </button>
      </div>
    </div>
  )
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<div className="text-text-muted text-sm text-center">Loading…</div>}>
      <VerifyEmailContent />
    </Suspense>
  )
}
