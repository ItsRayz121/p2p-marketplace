'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'

export default function ReferralLandingPage() {
  const { code } = useParams<{ code: string }>()
  const router = useRouter()
  const [countdown, setCountdown] = useState(5)

  useEffect(() => {
    if (code && typeof window !== 'undefined') {
      localStorage.setItem('referralCode', code)
    }
  }, [code])

  useEffect(() => {
    const interval = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(interval)
          router.push('/register')
          return 0
        }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [router])

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 to-white flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center space-y-6">
        {/* Logo */}
        <div className="flex justify-center">
          <div className="w-16 h-16 rounded-2xl bg-primary text-white font-black text-2xl flex items-center justify-center">
            P
          </div>
        </div>

        {/* Invite Message */}
        <div>
          <h1 className="text-2xl font-black text-text-primary mb-2">You've been invited!</h1>
          <p className="text-text-muted">
            Your friend has invited you to join <span className="font-semibold text-text-primary">RupChain</span> — Pakistan's #1 P2P crypto marketplace.
          </p>
        </div>

        {/* Referral Code */}
        <div className="bg-surface border-2 border-primary rounded-2xl p-6 space-y-2">
          <p className="text-xs text-text-muted font-medium uppercase tracking-wide">Your Referral Code</p>
          <p className="text-4xl font-black text-primary tracking-widest">{code}</p>
          <p className="text-sm text-text-muted">Use this code when signing up to get started with a bonus</p>
        </div>

        {/* Benefits */}
        <div className="bg-surface rounded-xl p-4 space-y-2 text-left">
          <p className="text-sm font-semibold text-text-primary">What you get:</p>
          {[
            'Buy & sell crypto peer-to-peer with PKR',
            'Zero trading fees on all P2P trades',
            'Fast payments via JazzCash, Easypaisa & banks',
            'Dispute protection on every trade',
          ].map((benefit) => (
            <div key={benefit} className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full bg-success/10 text-success flex items-center justify-center flex-shrink-0">
                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-sm text-text-muted">{benefit}</p>
            </div>
          ))}
        </div>

        {/* CTA */}
        <Link href="/register">
          <Button className="w-full text-base py-3">
            Create Account Now
          </Button>
        </Link>

        {/* Auto-redirect */}
        <p className="text-xs text-text-muted">
          Redirecting to registration in {countdown}s...
        </p>

        <p className="text-xs text-text-muted">
          Already have an account?{' '}
          <Link href="/login" className="text-primary underline">Sign in</Link>
        </p>
      </div>
    </div>
  )
}
