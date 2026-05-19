'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ctmApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'

const TIERS = [
  { name: 'new', cap: 'PKR 5,000 per trade', trades: '<10 trades', color: 'border-gray-200' },
  { name: 'basic', cap: 'PKR 25,000 per trade', trades: '10–50 trades', color: 'border-blue-200' },
  { name: 'verified', cap: 'PKR 100,000 per trade', trades: '50+ trades + enhanced KYC', color: 'border-green-200' },
  { name: 'elite', cap: 'Unlimited', trades: '200+ trades + <2% dispute rate', color: 'border-purple-200' },
]

export default function CtmMerchantSetupPage() {
  const router = useRouter()
  const { user } = useAuthStore()
  const [profile, setProfile] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [registering, setRegistering] = useState(false)
  const [error, setError] = useState('')
  const [step, setStep] = useState(1)

  useEffect(() => {
    ctmApi.getMyCtmProfile()
      .then((res) => { setProfile(res); if (res) setStep(4) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleRegister = async () => {
    setError('')
    setRegistering(true)
    try {
      const res = await ctmApi.registerCtmMerchant()
      setProfile(res)
      setStep(4)
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Registration failed')
    } finally {
      setRegistering(false)
    }
  }

  if (loading) return <div className="max-w-2xl mx-auto px-4 py-12 text-center text-text-muted">Loading…</div>

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-text-primary mb-2">CTM Merchant Setup</h1>
      <p className="text-text-muted text-sm mb-8">Set up your Community Token Market merchant profile to start posting listings.</p>

      {/* Steps */}
      <div className="flex items-center gap-2 mb-8">
        {[1, 2, 3, 4].map((s) => (
          <div key={s} className="flex items-center gap-2">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-colors ${step >= s ? 'bg-primary text-white' : 'bg-surface border border-border text-text-muted'}`}>{s}</div>
            {s < 4 && <div className={`h-0.5 w-8 transition-colors ${step > s ? 'bg-primary' : 'bg-border'}`} />}
          </div>
        ))}
      </div>

      {step === 1 && (
        <div className="bg-white border border-border rounded-xl p-6 space-y-4">
          <h2 className="font-bold text-text-primary">Step 1: Eligibility Check</h2>
          {user ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-3 bg-green-50 border border-green-200 rounded-xl">
                <span className="text-green-600 text-lg">✓</span>
                <span className="text-sm text-green-800">You are logged in as {user.username}</span>
              </div>
              <p className="text-sm text-text-muted">You need an approved Merchant account to register as a CTM merchant.</p>
              <button onClick={() => setStep(2)} className="w-full bg-primary text-white py-3 rounded-xl font-semibold text-sm hover:bg-primary/90 transition-colors">Continue →</button>
            </div>
          ) : (
            <p className="text-sm text-red-600">You must be logged in to continue.</p>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="bg-white border border-border rounded-xl p-6 space-y-4">
          <h2 className="font-bold text-text-primary">Step 2: Merchant Tiers</h2>
          <p className="text-sm text-text-muted">Your tier determines your per-trade limit. Tiers upgrade automatically as you complete trades.</p>
          <div className="space-y-3">
            {TIERS.map((t) => (
              <div key={t.name} className={`border rounded-xl p-4 ${t.color}`}>
                <div className="flex items-center justify-between">
                  <p className="font-semibold text-text-primary capitalize">{t.name}</p>
                  <span className="font-bold text-primary text-sm">{t.cap}</span>
                </div>
                <p className="text-xs text-text-muted mt-1">{t.trades}</p>
              </div>
            ))}
          </div>
          <button onClick={() => setStep(3)} className="w-full bg-primary text-white py-3 rounded-xl font-semibold text-sm hover:bg-primary/90">Continue →</button>
        </div>
      )}

      {step === 3 && (
        <div className="bg-white border border-border rounded-xl p-6 space-y-4">
          <h2 className="font-bold text-text-primary">Step 3: Register as CTM Merchant</h2>
          <div className="bg-surface rounded-xl p-4 text-sm space-y-2 text-text-muted">
            <p>• You agree to complete trades honestly and on time</p>
            <p>• Your merchant tier starts at &ldquo;new&rdquo; (PKR 5,000 cap per trade)</p>
            <p>• Disputes may result in tier downgrade or suspension</p>
            <p>• Proof screenshots must be genuine</p>
          </div>
          {error && <div className="bg-red-50 text-red-700 border border-red-200 rounded-xl p-3 text-sm">{error}</div>}
          <button onClick={handleRegister} disabled={registering} className="w-full bg-primary text-white py-3 rounded-xl font-semibold text-sm hover:bg-primary/90 disabled:opacity-60">
            {registering ? 'Registering…' : 'Register as CTM Merchant'}
          </button>
        </div>
      )}

      {step === 4 && profile !== null && (
        <div className="bg-white border border-border rounded-xl p-6 space-y-4 text-center">
          <div className="text-5xl mb-3">🎉</div>
          <h2 className="font-bold text-text-primary text-xl">You&apos;re a CTM Merchant!</h2>
          <p className="text-text-muted text-sm">Your profile is set up. You can now create listings and start trading.</p>
          <div className="flex gap-3 justify-center">
            <button onClick={() => router.push('/ctm/listings/create')} className="bg-primary text-white px-5 py-2.5 rounded-xl font-semibold text-sm hover:bg-primary/90">Create First Listing</button>
            <button onClick={() => router.push('/ctm')} className="border border-border px-5 py-2.5 rounded-xl text-sm font-medium text-text-primary hover:bg-surface">Browse Market</button>
          </div>
        </div>
      )}
    </div>
  )
}
