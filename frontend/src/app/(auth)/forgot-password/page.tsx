'use client'
import { useState, useRef, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { authApi } from '@/lib/api'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { useCountdown } from '@/hooks/useCountdown'
import { cn } from '@/lib/utils'
import Link from 'next/link'

const OTP_LENGTH = 6

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-2 mb-6">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={cn(
            'h-1.5 flex-1 rounded-full transition-all',
            i + 1 <= current ? 'bg-primary' : 'bg-border',
          )}
        />
      ))}
      <span className="text-xs text-text-muted whitespace-nowrap ml-1">
        Step {current} of {total}
      </span>
    </div>
  )
}

interface OtpInputProps {
  digits: string[]
  disabled?: boolean
  error?: boolean
  onChange: (index: number, value: string) => void
  onKeyDown: (index: number, e: React.KeyboardEvent<HTMLInputElement>) => void
  onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => void
  inputRefs: React.MutableRefObject<Array<HTMLInputElement | null>>
}

function OtpInput({ digits, disabled, error, onChange, onKeyDown, onPaste, inputRefs }: OtpInputProps) {
  return (
    <div className="flex justify-center gap-2" role="group" aria-label="One-time passcode">
      {digits.map((digit, i) => (
        <input
          key={i}
          ref={(el) => { inputRefs.current[i] = el }}
          type="text"
          inputMode="numeric"
          maxLength={1}
          value={digit}
          onChange={(e) => onChange(i, e.target.value)}
          onKeyDown={(e) => onKeyDown(i, e)}
          onPaste={onPaste}
          disabled={disabled}
          aria-label={`Digit ${i + 1}`}
          className={cn(
            'w-12 h-14 text-center text-xl font-semibold rounded-lg border bg-white text-text-primary',
            'transition-colors focus:outline-none focus:ring-2 focus:ring-offset-0',
            error
              ? 'border-danger focus:ring-danger/30'
              : 'border-border focus:ring-primary/30 focus:border-primary',
            disabled && 'opacity-50 cursor-not-allowed',
          )}
        />
      ))}
    </div>
  )
}

export default function ForgotPasswordPage() {
  const router = useRouter()
  const [step, setStep] = useState<1 | 2 | 3>(1)

  // Shared state
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Step 1
  const [emailInput, setEmailInput] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)

  // Step 2 — OTP
  const [digits, setDigits] = useState<string[]>(Array(OTP_LENGTH).fill(''))
  const [resendExpiry, setResendExpiry] = useState(
    () => new Date(Date.now() + 60_000).toISOString(),
  )
  const [resendLoading, setResendLoading] = useState(false)
  const inputRefs = useRef<Array<HTMLInputElement | null>>(Array(OTP_LENGTH).fill(null))
  const { formatted, isExpired } = useCountdown(resendExpiry)

  // Step 3 — New password
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const focusOtpInput = (index: number) => {
    inputRefs.current[Math.max(0, Math.min(OTP_LENGTH - 1, index))]?.focus()
  }

  useEffect(() => {
    if (step === 2) {
      setTimeout(() => focusOtpInput(0), 50)
    }
  }, [step])

  // Step 1: send reset code
  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault()
    setEmailError(null)
    if (!emailInput.trim()) {
      setEmailError('Please enter your email address')
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput)) {
      setEmailError('Please enter a valid email address')
      return
    }
    setLoading(true)
    try {
      await authApi.forgotPassword(emailInput.trim())
      setEmail(emailInput.trim())
      setDigits(Array(OTP_LENGTH).fill(''))
      setResendExpiry(new Date(Date.now() + 60_000).toISOString())
      setError(null)
      setStep(2)
    } catch {
      // Move to step 2 regardless (no email enumeration)
      setEmail(emailInput.trim())
      setDigits(Array(OTP_LENGTH).fill(''))
      setResendExpiry(new Date(Date.now() + 60_000).toISOString())
      setError(null)
      setStep(2)
    } finally {
      setLoading(false)
    }
  }

  // Step 2: OTP change helpers
  function handleDigitChange(index: number, value: string) {
    const digit = value.replace(/\D/g, '').slice(-1)
    const next = [...digits]
    next[index] = digit
    setDigits(next)
    if (digit && index < OTP_LENGTH - 1) focusOtpInput(index + 1)
  }

  function handleDigitKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
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
        focusOtpInput(index - 1)
      }
    }
  }

  function handleDigitPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    e.preventDefault()
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH)
    if (!pasted) return
    const next = Array(OTP_LENGTH).fill('')
    for (let i = 0; i < pasted.length; i++) next[i] = pasted[i]
    setDigits(next)
    focusOtpInput(Math.min(pasted.length, OTP_LENGTH - 1))
  }

  // Step 2: verify code (manual submit)
  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const filled = digits.join('')
    if (filled.length < OTP_LENGTH || digits.includes('')) {
      setError('Please enter the complete 6-digit code')
      return
    }
    setCode(filled)
    setError(null)
    setStep(3)
  }

  async function handleResend() {
    if (resendLoading) return
    setResendLoading(true)
    setError(null)
    try {
      await authApi.forgotPassword(email)
      setResendExpiry(new Date(Date.now() + 60_000).toISOString())
      setDigits(Array(OTP_LENGTH).fill(''))
      setTimeout(() => focusOtpInput(0), 0)
    } catch {
      // Silently reset timer regardless
      setResendExpiry(new Date(Date.now() + 60_000).toISOString())
    } finally {
      setResendLoading(false)
    }
  }

  // Step 3: reset password
  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    setLoading(true)
    try {
      await authApi.resetPassword({ email, code, newPassword })
      setSuccessMessage('Password reset successfully! Redirecting to login…')
      setTimeout(() => router.push('/login'), 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const EyeToggle = ({ show, onToggle }: { show: boolean; onToggle: () => void }) => (
    <button
      type="button"
      onClick={onToggle}
      className="text-text-muted hover:text-text-primary transition-colors focus:outline-none"
      tabIndex={-1}
      aria-label={show ? 'Hide password' : 'Show password'}
    >
      {show ? (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
        </svg>
      ) : (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
        </svg>
      )}
    </button>
  )

  return (
    <div>
      <StepIndicator current={step} total={3} />

      {/* ── Step 1: Email ── */}
      {step === 1 && (
        <>
          <h2 className="text-xl font-semibold text-text-primary mb-1">Forgot Password</h2>
          <p className="text-text-muted text-sm mb-6">
            Enter your email and we&apos;ll send you a reset code.
          </p>

          <form onSubmit={handleSendCode} noValidate className="flex flex-col gap-4">
            <Input
              label="Email address"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              error={emailError ?? undefined}
            />

            <Button type="submit" fullWidth size="lg" loading={loading}>
              Send Reset Code
            </Button>
          </form>

          <p className="text-center text-sm text-text-muted mt-6">
            <Link href="/login" className="text-primary font-medium hover:underline">
              Back to login
            </Link>
          </p>
        </>
      )}

      {/* ── Step 2: OTP ── */}
      {step === 2 && (
        <>
          <h2 className="text-xl font-semibold text-text-primary mb-1">Enter Reset Code</h2>
          <p className="text-text-muted text-sm mb-8">
            Enter the 6-digit code sent to{' '}
            <span className="font-medium text-text-primary break-all">{email}</span>
          </p>

          <form onSubmit={handleVerifyCode} noValidate className="flex flex-col gap-6">
            <OtpInput
              digits={digits}
              disabled={loading}
              error={!!error}
              onChange={handleDigitChange}
              onKeyDown={handleDigitKeyDown}
              onPaste={handleDigitPaste}
              inputRefs={inputRefs}
            />

            {error && (
              <p className="text-sm text-danger bg-danger/5 border border-danger/20 rounded-lg px-3 py-2 text-center">
                {error}
              </p>
            )}

            <Button type="submit" fullWidth size="lg" loading={loading}>
              Verify Code
            </Button>
          </form>

          <div className="flex flex-col items-center gap-2 mt-4">
            {isExpired ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleResend}
                loading={resendLoading}
                disabled={resendLoading}
              >
                Resend Code
              </Button>
            ) : (
              <p className="text-sm text-text-muted">
                Resend code in{' '}
                <span className="font-medium text-text-primary tabular-nums">{formatted}</span>
              </p>
            )}

            <button
              type="button"
              onClick={() => { setStep(1); setError(null) }}
              className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors focus:outline-none"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back
            </button>
          </div>
        </>
      )}

      {/* ── Step 3: New Password ── */}
      {step === 3 && (
        <>
          <h2 className="text-xl font-semibold text-text-primary mb-1">Set New Password</h2>
          <p className="text-text-muted text-sm mb-6">
            Choose a strong password for your account.
          </p>

          <form onSubmit={handleResetPassword} noValidate className="flex flex-col gap-4">
            <Input
              label="New password"
              type={showNew ? 'text' : 'password'}
              autoComplete="new-password"
              placeholder="At least 8 characters"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              rightElement={
                <EyeToggle show={showNew} onToggle={() => setShowNew((p) => !p)} />
              }
            />

            <Input
              label="Confirm new password"
              type={showConfirm ? 'text' : 'password'}
              autoComplete="new-password"
              placeholder="Re-enter your new password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              rightElement={
                <EyeToggle show={showConfirm} onToggle={() => setShowConfirm((p) => !p)} />
              }
            />

            {error && (
              <p className="text-sm text-danger bg-danger/5 border border-danger/20 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            {successMessage && (
              <p className="text-sm text-success bg-success/5 border border-success/20 rounded-lg px-3 py-2">
                {successMessage}
              </p>
            )}

            <Button type="submit" fullWidth size="lg" loading={loading} disabled={!!successMessage}>
              Reset Password
            </Button>
          </form>

          <div className="flex justify-center mt-4">
            <button
              type="button"
              onClick={() => { setStep(2); setError(null) }}
              className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors focus:outline-none"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back
            </button>
          </div>
        </>
      )}
    </div>
  )
}
