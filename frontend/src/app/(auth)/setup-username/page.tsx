'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { authApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { cn } from '@/lib/utils'

const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/

type AvailabilityState = 'idle' | 'checking' | 'available' | 'taken' | 'invalid'

function getRoleRedirect(role: string | undefined): string {
  if (role === 'admin' || role === 'super_admin' || role === 'kyc_reviewer' || role === 'dispute_agent') {
    return '/admin'
  }
  return '/dashboard'
}

export default function SetupUsernamePage() {
  const router = useRouter()
  const user = useAuthStore((s) => s.user)
  const isLoading = useAuthStore((s) => s.isLoading)
  const setUser = useAuthStore((s) => s.setUser)

  const [username, setUsername] = useState('')
  const [availability, setAvailability] = useState<AvailabilityState>('idle')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const checkAvailability = useCallback(async (value: string) => {
    if (!USERNAME_REGEX.test(value)) {
      setAvailability('invalid')
      return
    }
    setAvailability('checking')
    try {
      const res = await authApi.checkUsername(value)
      setAvailability(res.available ? 'available' : 'taken')
    } catch {
      setAvailability('idle')
    }
  }, [])

  function handleUsernameChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value
    setUsername(value)
    setError(null)

    if (debounceRef.current) clearTimeout(debounceRef.current)

    if (!value) {
      setAvailability('idle')
      return
    }

    if (!USERNAME_REGEX.test(value)) {
      setAvailability('invalid')
      return
    }

    setAvailability('checking')
    debounceRef.current = setTimeout(() => checkAvailability(value), 500)
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!username || availability !== 'available') return
    setSaving(true)
    setError(null)
    try {
      const updatedUser = await authApi.updateProfile({ username })
      setUser(updatedUser)
      router.push(getRoleRedirect(updatedUser.role))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save username. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  function handleSkip() {
    router.push(getRoleRedirect(user?.role))
  }

  // Wait for auth store to finish loading
  if (isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Spinner size="lg" />
      </div>
    )
  }

  const AvailabilityIcon = () => {
    if (availability === 'checking') return <Spinner size="sm" className="text-text-muted" />
    if (availability === 'available')
      return (
        <svg className="w-5 h-5 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
      )
    if (availability === 'taken')
      return (
        <svg className="w-5 h-5 text-danger" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
        </svg>
      )
    return null
  }

  const availabilityText = () => {
    if (availability === 'available')
      return <span className="text-sm text-success">Username available</span>
    if (availability === 'taken')
      return <span className="text-sm text-danger">Username taken</span>
    if (availability === 'invalid')
      return <span className="text-sm text-danger">Invalid format</span>
    return null
  }

  const canSave = availability === 'available' && username.length > 0 && !saving

  return (
    <div>
      <h2 className="text-xl font-semibold text-text-primary mb-1">Choose Your Username</h2>
      <p className="text-text-muted text-sm mb-6">
        Pick a unique username for your RupChain profile
      </p>

      <form onSubmit={handleSave} noValidate className="flex flex-col gap-4">
        {/* Trust guidance callout */}
        <div className="bg-primary/5 border border-primary/15 rounded-lg px-4 py-3 text-sm">
          <p className="font-medium text-primary mb-1">Build trust from the start</p>
          <ul className="text-text-secondary text-xs space-y-0.5 list-disc ml-3">
            <li>Use your real name or CNIC name</li>
            <li>Or a username close to your real or exchange identity</li>
          </ul>
          <p className="text-text-muted text-xs mt-1.5">
            Recognizable identities earn more trust and complete more trades.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Input
            label="Username"
            type="text"
            autoComplete="username"
            placeholder="e.g. AhmedKhan or ahmed_trader"
            value={username}
            onChange={handleUsernameChange}
            rightElement={<AvailabilityIcon />}
            error={
              availability === 'taken'
                ? 'Username taken'
                : availability === 'invalid'
                ? 'Invalid format'
                : undefined
            }
          />
          <p className="text-xs text-text-muted">
            3–20 characters. Letters, numbers, and underscores only.
          </p>
          {availability !== 'taken' && availability !== 'invalid' && (
            <div className={cn('min-h-[20px]')}>{availabilityText()}</div>
          )}
        </div>

        {error && (
          <p className="text-sm text-danger bg-danger/5 border border-danger/20 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        <Button
          type="submit"
          fullWidth
          size="lg"
          loading={saving}
          disabled={!canSave}
        >
          Save Username
        </Button>

        <Button
          type="button"
          variant="ghost"
          fullWidth
          size="md"
          onClick={handleSkip}
          disabled={saving}
        >
          Skip for now
        </Button>
      </form>
    </div>
  )
}
