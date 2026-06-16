'use client'
import { useState, useRef, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { authApi, ApiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

const OTP_LENGTH = 6

function getRoleRedirect(role: string | undefined): string {
  if (role === 'admin' || role === 'super_admin' || role === 'kyc_reviewer' || role === 'dispute_agent') {
    return '/admin'
  }
  return '/dashboard'
}

export default function TwoFaPage() {
  const router = useRouter()
  const setAccessToken = useAuthStore((s) => s.setAccessToken)
  const setUser = useAuthStore((s) => s.setUser)

  const [digits, setDigits] = useState<string[]>(Array(OTP_LENGTH).fill(''))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preAuthToken, setPreAuthToken] = useState<string | null>(null)
  const [trustDevice, setTrustDevice] = useState(true)
  // Keep the latest checkbox value reachable from the auto-submit callback,
  // which is memoised and would otherwise capture a stale value.
  const trustDeviceRef = useRef(true)
  const inputRefs = useRef<Array<HTMLInputElement | null>>(Array(OTP_LENGTH).fill(null))

  const focusInput = (index: number) => {
    inputRefs.current[Math.max(0, Math.min(OTP_LENGTH - 1, index))]?.focus()
  }

  useEffect(() => {
    const token = sessionStorage.getItem('preAuthToken')
    if (!token) {
      router.replace('/login')
      return
    }
    setPreAuthToken(token)
    setTimeout(() => focusInput(0), 50)
  }, [router])

  const submitCode = useCallback(
    async (code: string) => {
      const token = sessionStorage.getItem('preAuthToken')
      if (!token) {
        router.replace('/login')
        return
      }
      setLoading(true)
      setError(null)
      try {
        const result = await authApi.verify2fa({ preAuthToken: token, code, trustDevice: trustDeviceRef.current })
        sessionStorage.removeItem('preAuthToken')
        setAccessToken(result.accessToken)
        setUser(result.user)
        router.push(getRoleRedirect(result.user.role))
      } catch (err) {
        const message =
          err instanceof ApiError && err.code === 'INVALID_OTP'
            ? 'Invalid authentication code. Please try again.'
            : err instanceof ApiError && err.status === 401
            ? 'Session expired. Please go back and log in again.'
            : err instanceof Error
            ? err.message
            : 'Verification failed. Please try again.'
        setError(message)
        setDigits(Array(OTP_LENGTH).fill(''))
        setTimeout(() => focusInput(0), 0)
      } finally {
        setLoading(false)
      }
    },
    [router, setAccessToken, setUser],
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
    if (next.every((d) => d.length === 1)) {
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

  // While we haven't confirmed the preAuthToken exists yet, show nothing
  if (!preAuthToken) return null

  return (
    <div>
      <h2 className="text-xl font-semibold text-text-primary mb-1">Two-Factor Authentication</h2>
      <p className="text-text-muted text-sm mb-8">
        Enter the 6-digit code from your authenticator app.
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

      <label className="flex items-center gap-2.5 cursor-pointer select-none mb-2">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-border text-primary focus:ring-primary/30 cursor-pointer"
          checked={trustDevice}
          onChange={(e) => {
            setTrustDevice(e.target.checked)
            trustDeviceRef.current = e.target.checked
          }}
          disabled={loading}
        />
        <span className="text-sm text-text-secondary">
          Trust this device for 30 days
        </span>
      </label>
      <p className="text-xs text-text-muted mb-4">
        Skip the code on this device next time. Don&apos;t tick this on a shared or public computer.
      </p>

      <Button
        type="button"
        variant="ghost"
        fullWidth
        size="sm"
        onClick={() => {
          sessionStorage.removeItem('preAuthToken')
          router.push('/login')
        }}
        disabled={loading}
        className="mt-2"
      >
        Back to login
      </Button>
    </div>
  )
}
