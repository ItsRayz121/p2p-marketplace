'use client'
import { useState, useEffect, useCallback, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { authApi } from '@/lib/api'
import type { Session } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { useAuthStore } from '@/store/auth.store'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { LoadingState } from '@/components/ui/LoadingState'
import { Spinner } from '@/components/ui/Spinner'
import { PushToggle } from '@/components/ui/PushToggle'

type Tab = 'profile' | 'security' | 'sessions' | 'notifications'

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// ─── Profile Tab ─────────────────────────────────────────────────────────────

function ProfileTab() {
  const { user } = useAuth()
  const { setUser } = useAuthStore()
  const [fullName, setFullName] = useState(user?.fullName ?? '')
  const [username, setUsername] = useState(user?.username ?? '')
  const [usernameAvailable, setUsernameAvailable] = useState<boolean | null>(null)
  const [checkingUsername, setCheckingUsername] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const original = user?.username ?? ''
    if (!username || username === original) { setUsernameAvailable(null); return }
    const timer = setTimeout(async () => {
      setCheckingUsername(true)
      try {
        const r = await authApi.checkUsername(username)
        setUsernameAvailable(r.available)
      } catch { setUsernameAvailable(null) } finally { setCheckingUsername(false) }
    }, 500)
    return () => clearTimeout(timer)
  }, [username, user?.username])

  const handleSave = async () => {
    setSaving(true); setError(''); setSaved(false)
    try {
      const updated = await authApi.updateProfile({ fullName, username })
      setUser(updated)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally { setSaving(false) }
  }

  return (
    <div className="space-y-5">
      <div>
        <label className="text-sm font-medium text-text-primary block mb-1.5">Full Name</label>
        <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Your full name" />
      </div>
      <div>
        <label className="text-sm font-medium text-text-primary block mb-1.5">Username</label>
        <div className="relative">
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
            placeholder="username"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm">
            {checkingUsername ? <Spinner size="sm" /> :
              usernameAvailable === true ? <span className="text-success">✓</span> :
              usernameAvailable === false ? <span className="text-danger">✗</span> : null}
          </span>
        </div>
        {usernameAvailable === false && (
          <p className="text-sm text-danger mt-1">Username is taken</p>
        )}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {saved && <p className="text-sm text-success">Profile saved successfully!</p>}
      <Button
        onClick={handleSave}
        disabled={saving || usernameAvailable === false}
        className="w-full sm:w-auto"
      >
        {saving ? <Spinner size="sm" /> : 'Save Changes'}
      </Button>
    </div>
  )
}

// ─── Security Tab ────────────────────────────────────────────────────────────

function SecurityTab() {
  const { user } = useAuth()
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [pwSaving, setPwSaving] = useState(false)
  const [pwError, setPwError] = useState('')
  const [pwSaved, setPwSaved] = useState(false)

  const [twoFaSetup, setTwoFaSetup] = useState<{ secret: string; qrCode: string } | null>(null)
  const [twoFaCode, setTwoFaCode] = useState('')
  const [twoFaLoading, setTwoFaLoading] = useState(false)
  const [twoFaError, setTwoFaError] = useState('')
  const [twoFaEnabled, setTwoFaEnabled] = useState(user?.twoFaEnabled ?? false)

  const handleChangePassword = async () => {
    if (newPw !== confirmPw) { setPwError('Passwords do not match'); return }
    if (newPw.length < 8) { setPwError('Password must be at least 8 characters'); return }
    setPwSaving(true); setPwError('')
    try {
      await authApi.changePassword({ currentPassword: currentPw, newPassword: newPw })
      setPwSaved(true)
      setCurrentPw(''); setNewPw(''); setConfirmPw('')
      setTimeout(() => setPwSaved(false), 3000)
    } catch (err) {
      setPwError(err instanceof Error ? err.message : 'Failed to change password')
    } finally { setPwSaving(false) }
  }

  const handleSetup2fa = async () => {
    setTwoFaLoading(true); setTwoFaError('')
    try {
      const r = await authApi.setup2fa()
      setTwoFaSetup(r)
    } catch (err) {
      setTwoFaError(err instanceof Error ? err.message : 'Failed to setup 2FA')
    } finally { setTwoFaLoading(false) }
  }

  const handleEnable2fa = async () => {
    if (twoFaCode.length !== 6) { setTwoFaError('Enter 6-digit code'); return }
    setTwoFaLoading(true); setTwoFaError('')
    try {
      await authApi.enable2fa(twoFaCode)
      setTwoFaEnabled(true)
      setTwoFaSetup(null)
      setTwoFaCode('')
    } catch (err) {
      setTwoFaError(err instanceof Error ? err.message : 'Invalid code')
    } finally { setTwoFaLoading(false) }
  }

  const handleDisable2fa = async () => {
    if (twoFaCode.length !== 6) { setTwoFaError('Enter 6-digit code'); return }
    setTwoFaLoading(true); setTwoFaError('')
    try {
      await authApi.disable2fa(twoFaCode)
      setTwoFaEnabled(false)
      setTwoFaCode('')
    } catch (err) {
      setTwoFaError(err instanceof Error ? err.message : 'Invalid code')
    } finally { setTwoFaLoading(false) }
  }

  return (
    <div className="space-y-6">
      {/* Change Password */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-bold text-text-primary">Change Password</h3>
        <div>
          <label className="text-sm font-medium text-text-primary block mb-1.5">Current Password</label>
          <Input type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} placeholder="Current password" />
        </div>
        <div>
          <label className="text-sm font-medium text-text-primary block mb-1.5">New Password</label>
          <Input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="At least 8 characters" />
        </div>
        <div>
          <label className="text-sm font-medium text-text-primary block mb-1.5">Confirm New Password</label>
          <Input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} placeholder="Repeat new password" />
        </div>
        {pwError && <p className="text-sm text-danger">{pwError}</p>}
        {pwSaved && <p className="text-sm text-success">Password changed successfully!</p>}
        <Button onClick={handleChangePassword} disabled={pwSaving || !currentPw || !newPw || !confirmPw}>
          {pwSaving ? <Spinner size="sm" /> : 'Change Password'}
        </Button>
      </div>

      {/* 2FA */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-text-primary">Two-Factor Authentication</h3>
          <Badge variant={twoFaEnabled ? 'success' : 'default'} size="sm">
            {twoFaEnabled ? 'Enabled' : 'Disabled'}
          </Badge>
        </div>
        <p className="text-sm text-text-muted">
          Protect your admin account with a TOTP authenticator app (e.g. Google Authenticator, Authy).
          Admin accounts should always have 2FA enabled.
        </p>

        {!twoFaEnabled && !twoFaSetup && (
          <Button variant="secondary" onClick={handleSetup2fa} disabled={twoFaLoading}>
            {twoFaLoading ? <Spinner size="sm" /> : 'Enable 2FA'}
          </Button>
        )}

        {!twoFaEnabled && twoFaSetup && (
          <div className="space-y-4">
            <div className="text-center">
              <img src={twoFaSetup.qrCode} alt="2FA QR Code" className="w-40 h-40 mx-auto border border-border rounded-lg" />
            </div>
            <div className="bg-surface rounded-lg p-3">
              <p className="text-xs text-text-muted mb-1">Manual entry secret</p>
              <p className="text-sm font-mono font-bold text-text-primary break-all">{twoFaSetup.secret}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary block mb-1.5">Enter 6-digit code from your app</label>
              <Input
                value={twoFaCode}
                onChange={(e) => setTwoFaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                maxLength={6}
              />
            </div>
            {twoFaError && <p className="text-sm text-danger">{twoFaError}</p>}
            <Button onClick={handleEnable2fa} disabled={twoFaLoading || twoFaCode.length !== 6}>
              {twoFaLoading ? <Spinner size="sm" /> : 'Verify & Enable'}
            </Button>
          </div>
        )}

        {twoFaEnabled && (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-text-primary block mb-1.5">Enter TOTP code to disable</label>
              <Input
                value={twoFaCode}
                onChange={(e) => setTwoFaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                maxLength={6}
              />
            </div>
            {twoFaError && <p className="text-sm text-danger">{twoFaError}</p>}
            <Button variant="secondary" onClick={handleDisable2fa} disabled={twoFaLoading || twoFaCode.length !== 6}>
              {twoFaLoading ? <Spinner size="sm" /> : 'Disable 2FA'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Sessions Tab ─────────────────────────────────────────────────────────────

function SessionsTab() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revoking, setRevoking] = useState<string | null>(null)

  const fetchSessions = useCallback(async () => {
    try {
      const res = await authApi.getSessions()
      setSessions(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchSessions() }, [fetchSessions])

  const handleRevoke = async (id: string) => {
    setRevoking(id)
    try {
      await authApi.revokeSession(id)
      setSessions((s) => s.filter((sess) => sess.id !== id))
    } catch { /* silent */ } finally { setRevoking(null) }
  }

  if (loading) return <LoadingState message="Loading sessions..." />
  if (error) return <p className="text-sm text-danger">{error}</p>

  return (
    <div className="space-y-3">
      {sessions.length === 0 && <p className="text-sm text-text-muted">No active sessions found.</p>}
      {sessions.map((sess) => (
        <div
          key={sess.id}
          className={`bg-surface shadow-card border rounded-xl p-4 ${sess.isCurrent ? 'border-primary/40 bg-primary/5' : 'border-border'}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <p className="text-sm font-semibold text-text-primary truncate">{sess.userAgent}</p>
                {sess.isCurrent && <Badge variant="success" size="sm">Current</Badge>}
              </div>
              <p className="text-xs text-text-muted">IP: {sess.ip}</p>
              <p className="text-xs text-text-muted">Last active: {timeAgo(sess.lastActiveAt)}</p>
              <p className="text-xs text-text-muted">Started: {new Date(sess.createdAt).toLocaleDateString()}</p>
            </div>
            {!sess.isCurrent && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => handleRevoke(sess.id)}
                disabled={revoking === sess.id}
              >
                {revoking === sess.id ? <Spinner size="sm" /> : 'Revoke'}
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Notifications Tab ────────────────────────────────────────────────────────

function NotificationsTab() {
  return (
    <div className="space-y-6">
      <div className="bg-surface shadow-card border border-border rounded-xl p-5 space-y-4">
        <div>
          <h3 className="text-sm font-bold text-text-primary">Push Notifications</h3>
          <p className="text-sm text-text-muted mt-1">
            Get real-time alerts pushed to this device — KYC submissions, disputes, gas orders,
            withdrawals and more — even when the admin panel is closed. This is in addition to the
            in-app notification bell.
          </p>
        </div>
        <PushToggle />
        <p className="text-xs text-text-muted">
          Enable on each device/browser you want to receive alerts on. Disabling stops push only on
          this device.
        </p>
      </div>
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

function AdminSettingsInner() {
  const searchParams = useSearchParams()
  const initialTab = (searchParams.get('tab') as Tab | null) ?? 'profile'
  const [activeTab, setActiveTab] = useState<Tab>(
    ['profile', 'security', 'sessions', 'notifications'].includes(initialTab) ? initialTab : 'profile',
  )

  const tabs: { id: Tab; label: string }[] = [
    { id: 'profile', label: 'Profile' },
    { id: 'security', label: 'Security' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'sessions', label: 'Sessions' },
  ]

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Admin Settings</h1>
        <p className="text-text-muted text-sm mt-0.5">Manage your admin account profile, password, and 2FA.</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-surface rounded-xl p-1 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`flex-1 min-w-0 py-2 px-1.5 sm:px-3 rounded-lg text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
              activeTab === t.id
                ? 'bg-surface text-text-primary shadow-sm'
                : 'text-text-muted hover:text-text-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'profile' && <ProfileTab />}
      {activeTab === 'security' && <SecurityTab />}
      {activeTab === 'notifications' && <NotificationsTab />}
      {activeTab === 'sessions' && <SessionsTab />}
    </div>
  )
}

export default function AdminSettingsPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center py-12"><div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>}>
      <AdminSettingsInner />
    </Suspense>
  )
}
