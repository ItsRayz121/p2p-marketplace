'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import Link from 'next/link'
import { authApi, ApiError } from '@/lib/api'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { analytics } from '@/lib/analytics'

const schema = z
  .object({
    fullName: z.string().min(2, 'Full name must be at least 2 characters'),
    email: z.string().email('Please enter a valid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string().min(1, 'Please confirm your password'),
    referralCode: z.string().optional(),
    terms: z.literal(true, { errorMap: () => ({ message: 'You must accept the terms to continue' }) }),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })

type FormValues = z.infer<typeof schema>

export default function RegisterPage() {
  const router = useRouter()
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [conflictEmail, setConflictEmail] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) })

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('referralCode')
      if (stored) setValue('referralCode', stored)
    }
  }, [setValue])

  async function onSubmit(values: FormValues) {
    setServerError(null)
    setConflictEmail(null)
    try {
      await authApi.register({
        email: values.email,
        fullName: values.fullName,
        password: values.password,
        referralCode: values.referralCode || undefined,
      })
      analytics.userRegistered()
      router.push(`/verify-email?email=${encodeURIComponent(values.email)}`)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONFLICT') {
        setConflictEmail(values.email)
      } else {
        setServerError(err instanceof Error ? err.message : 'Registration failed. Please try again.')
      }
    }
  }

  const EyeIcon = ({ open }: { open: boolean }) =>
    open ? (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
      </svg>
    ) : (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
      </svg>
    )

  const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? ''

  return (
    <div>
      <h2 className="text-xl font-semibold text-text-primary mb-1">Create your account</h2>
      <p className="text-text-muted text-sm mb-6">Join PakSwap to buy and sell crypto peer-to-peer</p>

      {/* Google Sign-Up */}
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
        Sign up with Google
      </a>

      <div className="flex items-center gap-3 mb-4">
        <div className="flex-1 h-px bg-border" />
        <span className="text-xs text-text-muted">or sign up with email</span>
        <div className="flex-1 h-px bg-border" />
      </div>

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
        <div>
          <Input
            label="Full name"
            type="text"
            autoComplete="name"
            placeholder="Your full name"
            error={errors.fullName?.message}
            {...register('fullName')}
          />
          <p className="text-xs text-text-muted mt-1.5">
            Use your real CNIC name — required for KYC, withdrawals, disputes, and account recovery.
          </p>
        </div>

        <Input
          label="Email address"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          error={errors.email?.message}
          {...register('email')}
        />

        <Input
          label="Password"
          type={showPassword ? 'text' : 'password'}
          autoComplete="new-password"
          placeholder="At least 8 characters"
          error={errors.password?.message}
          rightElement={
            <button
              type="button"
              onClick={() => setShowPassword((p) => !p)}
              className="text-text-muted hover:text-text-primary transition-colors focus:outline-none"
              tabIndex={-1}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              <EyeIcon open={showPassword} />
            </button>
          }
          {...register('password')}
        />

        <Input
          label="Confirm password"
          type={showConfirm ? 'text' : 'password'}
          autoComplete="new-password"
          placeholder="Re-enter your password"
          error={errors.confirmPassword?.message}
          rightElement={
            <button
              type="button"
              onClick={() => setShowConfirm((p) => !p)}
              className="text-text-muted hover:text-text-primary transition-colors focus:outline-none"
              tabIndex={-1}
              aria-label={showConfirm ? 'Hide confirm password' : 'Show confirm password'}
            >
              <EyeIcon open={showConfirm} />
            </button>
          }
          {...register('confirmPassword')}
        />

        <Input
          label="Referral code (optional)"
          type="text"
          autoComplete="off"
          placeholder="Enter referral code"
          {...register('referralCode')}
        />

        <div className="flex flex-col gap-1">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary/30 cursor-pointer"
              {...register('terms')}
            />
            <span className="text-sm text-text-secondary leading-snug">
              I agree to the{' '}
              <a href="/terms" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">
                Terms of Service
              </a>{' '}
              and{' '}
              <a href="/privacy" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">
                Privacy Policy
              </a>
            </span>
          </label>
          {errors.terms && (
            <p className="text-sm text-danger pl-6">{errors.terms.message}</p>
          )}
        </div>

        {serverError && (
          <p className="text-sm text-danger bg-danger/5 border border-danger/20 rounded-lg px-3 py-2">
            {serverError}
          </p>
        )}

        {conflictEmail && (
          <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-3 space-y-2">
            <p className="font-medium">An account with this email already exists.</p>
            <p>If you haven&apos;t verified your email yet, check your inbox or resend the verification email.</p>
            <div className="flex flex-wrap gap-3 pt-1">
              <Link href="/login" className="font-medium underline hover:no-underline">Sign in</Link>
              <button
                type="button"
                className="font-medium underline hover:no-underline"
                onClick={async () => {
                  try {
                    await authApi.resendOtp(conflictEmail)
                    router.push(`/verify-email?email=${encodeURIComponent(conflictEmail)}`)
                  } catch {
                    setServerError('Could not resend verification email. Try logging in instead.')
                    setConflictEmail(null)
                  }
                }}
              >
                Resend verification email
              </button>
            </div>
          </div>
        )}

        <Button type="submit" fullWidth size="lg" loading={isSubmitting}>
          Create Account
        </Button>
      </form>

      <p className="text-center text-sm text-text-muted mt-6">
        Already have an account?{' '}
        <Link href="/login" className="text-primary font-medium hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  )
}
