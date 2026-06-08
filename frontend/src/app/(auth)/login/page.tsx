'use client'
import { Suspense, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { authApi, ApiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'

const schema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
  rememberMe: z.boolean().optional(),
})

type FormValues = z.infer<typeof schema>

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? ''

function LoginInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const setAccessToken = useAuthStore((s) => s.setAccessToken)
  const setUser = useAuthStore((s) => s.setUser)
  const [showPassword, setShowPassword] = useState(false)
  const googleError = searchParams.get('googleError')
  const [serverError, setServerError] = useState<string | null>(googleError)
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null)
  const [savedCredentials, setSavedCredentials] = useState<FormValues | null>(null)
  const [alreadyVerified, setAlreadyVerified] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { rememberMe: true } })

  async function onSubmit(values: FormValues) {
    setServerError(null)
    setUnverifiedEmail(null)
    setAlreadyVerified(false)
    try {
      const res = await authApi.login({ email: values.email, password: values.password, rememberMe: values.rememberMe ?? true })

      // Banned / suspended → restricted appeal flow (no session issued).
      if (res.restricted) {
        sessionStorage.setItem('appealToken', res.restricted.appealToken)
        router.push(`/account/restricted?status=${res.restricted.status}`)
        return
      }

      if (res.preAuthToken) {
        sessionStorage.setItem('preAuthToken', res.preAuthToken)
        router.push('/2fa')
        return
      }

      if (res.accessToken) setAccessToken(res.accessToken)
      if (res.user) {
        setUser(res.user)
        const role = res.user.role
        if (role === 'admin' || role === 'super_admin' || role === 'kyc_reviewer' || role === 'dispute_agent') {
          router.push('/admin')
        } else {
          router.push('/dashboard')
        }
      } else {
        router.push('/dashboard')
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EMAIL_NOT_VERIFIED') {
        setUnverifiedEmail(values.email)
        setSavedCredentials(values)
      } else {
        setServerError(err instanceof Error ? err.message : 'Login failed. Please try again.')
      }
    }
  }

  async function handleRefreshStatus() {
    if (!savedCredentials) return
    setRefreshing(true)
    setServerError(null)
    try {
      await onSubmit(savedCredentials)
    } finally {
      setRefreshing(false)
    }
  }

  async function handleResend() {
    if (!unverifiedEmail) return
    try {
      await authApi.resendOtp(unverifiedEmail)
      setServerError(null)
      setUnverifiedEmail(null)
      setSavedCredentials(null)
      router.push(`/verify-email?email=${encodeURIComponent(unverifiedEmail)}`)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ALREADY_VERIFIED') {
        setAlreadyVerified(true)
        setUnverifiedEmail(null)
        setSavedCredentials(null)
      } else {
        setServerError('Failed to resend verification email. Please try again.')
      }
    }
  }

  return (
    <div>
      <h2 className="text-xl font-semibold text-text-primary mb-1">Welcome back</h2>
      <p className="text-text-muted text-sm mb-6">Sign in to your RupChain account</p>

      {/* Google Sign-In */}
      <a
        href={`${API_BASE}/api/v1/auth/google`}
        className="flex items-center justify-center gap-3 w-full border border-border rounded-xl px-4 py-2.5 text-sm font-medium text-text-primary hover:bg-surface transition-colors mb-4"
      >
        <svg className="w-5 h-5" viewBox="0 0 24 24">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
        </svg>
        Continue with Google
      </a>

      <div className="flex items-center gap-3 mb-2">
        <div className="flex-1 h-px bg-border" />
        <span className="text-xs text-text-muted">or</span>
        <div className="flex-1 h-px bg-border" />
      </div>

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
        <Input
          label="Email address"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          error={errors.email?.message}
          {...register('email')}
        />

        <div className="flex flex-col gap-1.5">
          <Input
            label="Password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            placeholder="••••••••"
            error={errors.password?.message}
            rightElement={
              <button
                type="button"
                onClick={() => setShowPassword((p) => !p)}
                className="text-text-muted hover:text-text-primary transition-colors focus:outline-none"
                tabIndex={-1}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? (
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
            }
            {...register('password')}
          />
          <div className="flex justify-end">
            <Link href="/forgot-password" className="text-sm text-primary hover:underline">
              Forgot password?
            </Link>
          </div>
        </div>

        {/* Remember me */}
        <label className="flex items-center gap-2.5 cursor-pointer select-none">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-border text-primary focus:ring-primary/30 cursor-pointer"
            {...register('rememberMe')}
          />
          <span className="text-sm text-text-secondary">Remember me for 30 days</span>
        </label>

        {serverError && (
          <p className="text-sm text-danger bg-danger/5 border border-danger/20 rounded-lg px-3 py-2">
            {serverError}
          </p>
        )}

        {alreadyVerified && (
          <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
            <p className="font-medium mb-0.5">Your email is already verified.</p>
            <p>You can sign in now using the form above.</p>
          </div>
        )}

        {unverifiedEmail && (
          <div className="text-sm bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex flex-col gap-3">
            <div>
              <p className="font-semibold text-amber-800 mb-1">Email verification required</p>
              <p className="text-amber-700 text-xs leading-relaxed">
                Verification status could not be confirmed. Possible reasons:
              </p>
              <ul className="text-amber-700 text-xs mt-1 ml-3 list-disc space-y-0.5">
                <li>Sync delay after recent verification</li>
                <li>Verification link/code expired</li>
                <li>Previous verification was incomplete</li>
              </ul>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="px-3 py-1.5 bg-amber-700 text-white text-xs font-semibold rounded-md hover:bg-amber-800 transition-colors disabled:opacity-60"
                onClick={handleRefreshStatus}
                disabled={refreshing}
              >
                {refreshing ? 'Checking…' : 'Refresh Verification Status'}
              </button>
              <Link
                href={`/verify-email?email=${encodeURIComponent(unverifiedEmail)}`}
                className="px-3 py-1.5 bg-surface border border-amber-300 text-amber-700 text-xs font-semibold rounded-md hover:bg-amber-50 transition-colors"
              >
                Enter verification code
              </Link>
              <button
                type="button"
                className="px-3 py-1.5 bg-surface border border-amber-300 text-amber-700 text-xs font-semibold rounded-md hover:bg-amber-50 transition-colors"
                onClick={handleResend}
              >
                Resend verification email
              </button>
            </div>
          </div>
        )}

        <Button type="submit" fullWidth size="lg" loading={isSubmitting}>
          Sign in
        </Button>
      </form>

      <p className="text-center text-sm text-text-muted mt-6">
        Don&apos;t have an account?{' '}
        <Link href="/register" className="text-primary font-medium hover:underline">
          Create one
        </Link>
      </p>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  )
}
