'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { authApi, accountApi } from '@/lib/api'
import type { Session, TrustedDevice } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { useAuthStore } from '@/store/auth.store'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { LoadingState } from '@/components/ui/LoadingState'
import { Spinner } from '@/components/ui/Spinner'
import { PushToggle } from '@/components/ui/PushToggle'
import { AnnouncementsToggle } from '@/components/ui/AnnouncementsToggle'
import { PriceAlertsManager, CtmPriceAlertsManager } from '@/components/ui/PriceAlertsPanel'
import { WereYouReferred } from '@/components/referral/WereYouReferred'
import { useFileUpload } from '@/hooks/useFileUpload'
import { toast } from '@/lib/toast'
import { Lock, Camera, Mail, Send, Check } from 'lucide-react'
import { SUPPORT_EMAIL, openSupportEmail } from '@/lib/contact'

// ─── Tab types ────────────────────────────────────────────────────────────────

type Tab = 'profile' | 'security' | 'notifications' | 'connections' | 'sessions' | 'danger'

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
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const { upload: uploadAvatar, uploading: uploadingAvatar, error: uploadAvatarError } = useFileUpload('avatar')

  const usernameChangedAt = user?.usernameChangedAt ? new Date(user.usernameChangedAt) : null
  const usernameNextAllowed = usernameChangedAt
    ? new Date(usernameChangedAt.getTime() + 30 * 24 * 60 * 60 * 1000)
    : null
  const usernameOnCooldown = usernameNextAllowed ? new Date() < usernameNextAllowed : false

  useEffect(() => {
    const original = user?.username ?? ''
    if (!username || username === original) { setUsernameAvailable(null); return }
    if (usernameOnCooldown) return
    const timer = setTimeout(async () => {
      setCheckingUsername(true)
      try {
        const r = await authApi.checkUsername(username)
        setUsernameAvailable(r.available)
      } catch { setUsernameAvailable(null) } finally { setCheckingUsername(false) }
    }, 500)
    return () => clearTimeout(timer)
  }, [username, user?.username, usernameOnCooldown])

  const handleSave = async () => {
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      const updated = await authApi.updateProfile({ fullName, username })
      setUser(updated)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const url = await uploadAvatar(file)
      const updated = await authApi.updateAvatar(url)
      setUser(updated)
    } catch { /* upload hook sets error state */ }
    if (avatarInputRef.current) avatarInputRef.current.value = ''
  }

  const initials = (user?.fullName || user?.username || user?.email || '?').charAt(0).toUpperCase()

  return (
    <div className="space-y-5">
      {/* Avatar */}
      <div className="flex items-center gap-4">
        <div className="relative">
          {user?.avatarUrl ? (
            <img src={user.avatarUrl} alt="Avatar" className="w-16 h-16 rounded-full object-cover border-2 border-border" />
          ) : (
            <div className="w-16 h-16 rounded-full bg-primary/10 text-primary text-xl font-bold flex items-center justify-center border-2 border-border">
              {initials}
            </div>
          )}
          <button
            onClick={() => avatarInputRef.current?.click()}
            disabled={uploadingAvatar}
            className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-primary text-white flex items-center justify-center shadow hover:bg-primary-hover transition-colors disabled:opacity-50"
          >
            {uploadingAvatar ? <Spinner size="sm" /> : <Camera size={12} />}
          </button>
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={handleAvatarChange}
          />
        </div>
        <div>
          <p className="text-sm font-medium text-text-primary">{user?.fullName || user?.username || 'Profile Photo'}</p>
          <p className="text-xs text-text-muted">JPEG, PNG or WebP, max 10MB</p>
          {uploadAvatarError && <p className="text-xs text-danger mt-0.5">{uploadAvatarError}</p>}
        </div>
      </div>

      <div>
        <label className="text-sm font-medium text-text-primary block mb-1.5">Full Name</label>
        <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Your full name" />
      </div>
      <div>
        <label className="text-sm font-medium text-text-primary block mb-1.5">Username</label>
        {usernameOnCooldown ? (
          <>
            <Input value={username} disabled className="opacity-60" />
            <p className="text-xs text-warning mt-1">
              Username can be changed again on{' '}
              <strong>{usernameNextAllowed!.toLocaleDateString('en-PK', { day: '2-digit', month: 'long', year: 'numeric' })}</strong>
            </p>
          </>
        ) : (
          <>
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
            <p className="text-xs text-text-muted mt-1">Can be changed once every 30 days</p>
          </>
        )}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {saved && <p className="text-sm text-success">Profile saved successfully!</p>}
      <Button
        onClick={handleSave}
        disabled={saving || usernameAvailable === false || (usernameOnCooldown && username !== user?.username)}
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
    setPwSaving(true)
    setPwError('')
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
    setTwoFaLoading(true)
    setTwoFaError('')
    try {
      const r = await authApi.setup2fa()
      setTwoFaSetup(r)
    } catch (err) {
      setTwoFaError(err instanceof Error ? err.message : 'Failed to setup 2FA')
    } finally { setTwoFaLoading(false) }
  }

  const handleEnable2fa = async () => {
    if (twoFaCode.length !== 6) { setTwoFaError('Enter 6-digit code'); return }
    setTwoFaLoading(true)
    setTwoFaError('')
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
    setTwoFaLoading(true)
    setTwoFaError('')
    try {
      await authApi.disable2fa(twoFaCode)
      setTwoFaEnabled(false)
      setTwoFaCode('')
    } catch (err) {
      setTwoFaError(err instanceof Error ? err.message : 'Invalid code')
    } finally { setTwoFaLoading(false) }
  }

  // Withdrawal lock computed from user data
  const wdLocked = user?.withdrawalLockedUntil
    ? new Date(user.withdrawalLockedUntil) > new Date()
    : false

  return (
    <div className="space-y-6">
      {/* Withdrawal lock notice */}
      {wdLocked && (
        <div className="bg-amber-500/10 border border-amber-500/40 rounded-xl px-4 py-3 flex items-start gap-3">
          <Lock size={18} className="text-amber-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">Withdrawals Temporarily Locked</p>
            <p className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">
              Due to a recent <strong>{user?.withdrawalLockReason ?? 'security change'}</strong>, withdrawals are locked until{' '}
              <strong>{new Date(user!.withdrawalLockedUntil!).toLocaleString()}</strong>.
              This is a security measure — no action is required.
            </p>
          </div>
        </div>
      )}

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
        <p className="text-sm text-text-muted">Use an authenticator app like Google Authenticator to add an extra layer of security.</p>

        {!twoFaEnabled && !twoFaSetup && (
          <Button variant="secondary" onClick={handleSetup2fa} disabled={twoFaLoading}>
            {twoFaLoading ? <Spinner size="sm" /> : 'Enable 2FA'}
          </Button>
        )}

        {!twoFaEnabled && twoFaSetup && (
          <div className="space-y-4">
            <div className="text-center">
              {/* QR Code displayed as img from data URL */}
              <img src={twoFaSetup.qrCode} alt="2FA QR Code" className="w-40 h-40 mx-auto border border-border rounded-lg" />
            </div>
            <div className="bg-surface rounded-lg p-3">
              <p className="text-xs text-text-muted mb-1">Manual entry secret</p>
              <p className="text-sm font-mono font-bold text-text-primary break-all">{twoFaSetup.secret}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary block mb-1.5">Enter 6-digit code</label>
              <Input
                value={twoFaCode}
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, '').slice(0, 6)
                  setTwoFaCode(v)
                  if (v.length === 6 && !twoFaLoading) setTimeout(handleEnable2fa, 0)
                }}
                placeholder="000000"
                maxLength={6}
                inputMode="numeric"
                autoComplete="one-time-code"
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
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, '').slice(0, 6)
                  setTwoFaCode(v)
                  if (v.length === 6 && !twoFaLoading) setTimeout(handleDisable2fa, 0)
                }}
                placeholder="000000"
                maxLength={6}
                inputMode="numeric"
                autoComplete="one-time-code"
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

// ─── Notifications Tab ────────────────────────────────────────────────────────

function NotificationsTab() {
  return (
    <div className="space-y-6">
      {/* Push Notifications */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-5 space-y-3">
        <h3 className="text-base font-semibold text-text-primary">Push Notifications</h3>
        <p className="text-sm text-text-muted">Get instant alerts for trade updates and payment events.</p>
        <PushToggle />
      </div>

      {/* Announcements & updates */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-text-primary">Announcements &amp; updates</h3>
            <p className="text-sm text-text-muted">
              Product news, new features and gas-fee updates. Turning this off never affects your trade, payment or security alerts.
            </p>
          </div>
          <AnnouncementsToggle />
        </div>
      </div>

      {/* USDT/PKR price alerts (moved here from the marketplace bell) */}
      <PriceAlertsManager />

      {/* CTM community-token price alerts */}
      <CtmPriceAlertsManager />
    </div>
  )
}

// ─── Sessions Tab ─────────────────────────────────────────────────────────────

function SessionsTab() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revoking, setRevoking] = useState<string | null>(null)
  const [devices, setDevices] = useState<TrustedDevice[]>([])
  const [forgetting, setForgetting] = useState<string | null>(null)

  const fetchSessions = useCallback(async () => {
    try {
      const [sess, devs] = await Promise.all([
        authApi.getSessions(),
        authApi.getTrustedDevices().catch(() => [] as TrustedDevice[]),
      ])
      setSessions(sess)
      setDevices(devs)
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

  const handleForget = async (id: string) => {
    setForgetting(id)
    try {
      await authApi.forgetTrustedDevice(id)
      setDevices((d) => d.filter((dev) => dev.id !== id))
    } catch { /* silent */ } finally { setForgetting(null) }
  }

  const handleForgetAll = async () => {
    setForgetting('all')
    try {
      await authApi.forgetAllTrustedDevices()
      setDevices([])
    } catch { /* silent */ } finally { setForgetting(null) }
  }

  if (loading) return <LoadingState message="Loading sessions..." />
  if (error) return <p className="text-sm text-danger">{error}</p>

  return (
    <div className="space-y-6">
      <div className="space-y-3">
      {sessions.length === 0 && <p className="text-sm text-text-muted">No active sessions found.</p>}
      {sessions.map((sess) => (
        <div
          key={sess.id}
          className={`shadow-card border rounded-xl p-4 ${sess.isCurrent ? 'border-primary/40 bg-primary/5' : 'border-border bg-surface'}`}
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

      {/* Trusted devices — those that skip the login 2FA code for 30 days. */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Trusted devices</h3>
            <p className="text-xs text-text-muted">
              These devices skip the 2FA code at login. Forget any you don&apos;t recognise.
            </p>
          </div>
          {devices.length > 0 && (
            <Button
              size="sm"
              variant="secondary"
              onClick={handleForgetAll}
              disabled={forgetting === 'all'}
            >
              {forgetting === 'all' ? <Spinner size="sm" /> : 'Forget all'}
            </Button>
          )}
        </div>

        {devices.length === 0 && (
          <p className="text-sm text-text-muted">No trusted devices. You&apos;ll enter a 2FA code at each login.</p>
        )}
        {devices.map((dev) => (
          <div
            key={dev.id}
            className={`shadow-card border rounded-xl p-4 ${dev.current ? 'border-primary/40 bg-primary/5' : 'border-border bg-surface'}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-sm font-semibold text-text-primary truncate">{dev.label}</p>
                  {dev.current && <Badge variant="success" size="sm">This device</Badge>}
                </div>
                <p className="text-xs text-text-muted">IP: {dev.lastIp ?? dev.ip ?? 'unknown'}</p>
                <p className="text-xs text-text-muted">Last used: {timeAgo(dev.lastUsedAt)}</p>
                <p className="text-xs text-text-muted">Trusted until: {new Date(dev.expiresAt).toLocaleDateString()}</p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => handleForget(dev.id)}
                disabled={forgetting === dev.id}
              >
                {forgetting === dev.id ? <Spinner size="sm" /> : 'Forget'}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Connections Tab (link email + Telegram) ───────────────────────────────────

function ConnectionsTab() {
  const { user } = useAuth()
  const { setUser } = useAuthStore()

  // Email linking state
  const [email, setEmail] = useState('')
  const [emailStep, setEmailStep] = useState<'idle' | 'code'>('idle')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [emailBusy, setEmailBusy] = useState(false)
  const [emailErr, setEmailErr] = useState('')
  const [emailDone, setEmailDone] = useState(false)

  // Telegram linking state
  const [tgBusy, setTgBusy] = useState(false)
  const [tgErr, setTgErr] = useState('')
  const [tgLink, setTgLink] = useState<string | null>(null)
  const [tgWaiting, setTgWaiting] = useState(false)

  // Telegram DISCONNECT state (fix a wrong Telegram → password-confirmed unlink)
  const [tgUnlinkOpen, setTgUnlinkOpen] = useState(false)
  const [tgUnlinkPassword, setTgUnlinkPassword] = useState('')
  const [tgUnlinkBusy, setTgUnlinkBusy] = useState(false)
  const [tgUnlinkErr, setTgUnlinkErr] = useState('')

  const hasRealEmail = user?.hasRealEmail ?? true
  const telegramLinked = user?.telegramLinked ?? false

  // While waiting for the user to complete linking inside Telegram, poll /auth/me
  // so the UI flips to "connected" automatically once the bot attaches the id.
  useEffect(() => {
    if (!tgWaiting || telegramLinked) return
    const timer = setInterval(async () => {
      try {
        const fresh = await authApi.me()
        setUser(fresh)
        if (fresh.telegramLinked) setTgWaiting(false)
      } catch { /* keep polling */ }
    }, 4000)
    return () => clearInterval(timer)
  }, [tgWaiting, telegramLinked, setUser])

  const sendCode = async () => {
    setEmailBusy(true); setEmailErr('')
    try {
      await accountApi.startEmailLink(email.trim())
      setEmailStep('code')
    } catch (e) {
      setEmailErr(e instanceof Error ? e.message : 'Failed to send code')
    } finally { setEmailBusy(false) }
  }

  const verifyCode = async () => {
    if (!hasRealEmail && password.length < 8) {
      setEmailErr('Set a password of at least 8 characters so you can log in on the website')
      return
    }
    setEmailBusy(true); setEmailErr('')
    try {
      const updated = await accountApi.verifyEmailLink({
        email: email.trim(),
        code,
        ...(!hasRealEmail && password ? { password } : {}),
      })
      setUser(updated)
      setEmailDone(true)
      setEmailStep('idle'); setCode(''); setPassword('')
    } catch (e) {
      setEmailErr(e instanceof Error ? e.message : 'Invalid code')
    } finally { setEmailBusy(false) }
  }

  const startTelegramLink = async () => {
    setTgBusy(true); setTgErr('')
    try {
      const { deepLink } = await accountApi.createTelegramLinkToken()
      if (!deepLink) {
        setTgErr('Telegram linking is not available right now. Please try again later.')
        return
      }
      setTgLink(deepLink)
      setTgWaiting(true)
    } catch (e) {
      setTgErr(e instanceof Error ? e.message : 'Failed to start Telegram linking')
    } finally { setTgBusy(false) }
  }

  const disconnectTelegram = async () => {
    setTgUnlinkBusy(true); setTgUnlinkErr('')
    try {
      const updated = await accountApi.unlinkTelegram(tgUnlinkPassword)
      setUser(updated)
      // Reset every Telegram sub-state so the section cleanly returns to the
      // "Link Telegram" flow, ready for the correct account.
      setTgUnlinkOpen(false); setTgUnlinkPassword('')
      setTgLink(null); setTgWaiting(false); setTgErr('')
    } catch (e) {
      setTgUnlinkErr(e instanceof Error ? e.message : 'Failed to disconnect Telegram')
    } finally { setTgUnlinkBusy(false) }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-text-muted">
        Connect one email and one Telegram account so you can reach the <strong>same</strong> RupChain
        account from both the website and Telegram. For your security, an account already in use
        can’t be merged.
      </p>

      {/* ── Email ── */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Mail size={16} className="text-text-muted" />
            <h3 className="text-sm font-bold text-text-primary">Email</h3>
          </div>
          <Badge variant={hasRealEmail ? 'success' : 'default'} size="sm">
            {hasRealEmail ? 'Connected' : 'Not set'}
          </Badge>
        </div>

        {hasRealEmail ? (
          <p className="text-sm text-text-primary">
            {user?.email}
            <span className="block text-xs text-text-muted mt-0.5">
              You can sign in on the website with this email and your password.
            </span>
          </p>
        ) : (
          <p className="text-sm text-text-muted">
            Add an email and password to also sign in on the website with this same account.
          </p>
        )}

        {emailDone && (
          <p className="text-sm text-success flex items-center gap-1.5">
            <Check size={14} /> Email connected successfully.
          </p>
        )}

        {emailStep === 'idle' && (
          <div className="space-y-3">
            <Input
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setEmailDone(false) }}
              placeholder={hasRealEmail ? 'New email address' : 'you@example.com'}
            />
            {emailErr && <p className="text-sm text-danger">{emailErr}</p>}
            <Button onClick={sendCode} disabled={emailBusy || !email.includes('@')}>
              {emailBusy ? <Spinner size="sm" /> : hasRealEmail ? 'Change Email' : 'Add Email'}
            </Button>
          </div>
        )}

        {emailStep === 'code' && (
          <div className="space-y-3">
            <p className="text-xs text-text-muted">
              We sent a 6-digit code to <strong>{email}</strong>. Enter it below.
            </p>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              maxLength={6}
              inputMode="numeric"
              autoComplete="one-time-code"
            />
            {!hasRealEmail && (
              <div>
                <label className="text-sm font-medium text-text-primary block mb-1.5">Set a password</label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                />
                <p className="text-xs text-text-muted mt-1">You’ll use this with your email to log in on the website.</p>
              </div>
            )}
            {emailErr && <p className="text-sm text-danger">{emailErr}</p>}
            <div className="flex gap-2">
              <Button onClick={verifyCode} disabled={emailBusy || code.length !== 6}>
                {emailBusy ? <Spinner size="sm" /> : 'Verify'}
              </Button>
              <Button variant="secondary" onClick={() => { setEmailStep('idle'); setCode(''); setEmailErr('') }} disabled={emailBusy}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* ── Telegram ── */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Send size={16} className="text-text-muted" />
            <h3 className="text-sm font-bold text-text-primary">Telegram</h3>
          </div>
          <Badge variant={telegramLinked ? 'success' : 'default'} size="sm">
            {telegramLinked ? 'Connected' : 'Not linked'}
          </Badge>
        </div>

        {telegramLinked ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-canvas p-3 space-y-1.5">
              {user?.telegramUsername && (
                <div className="flex items-center gap-1.5 text-sm">
                  <Check size={14} className="text-success flex-shrink-0" />
                  <span className="text-text-muted">Linked as</span>
                  <strong className="text-text-primary break-all">@{user.telegramUsername}</strong>
                </div>
              )}
              <p className="text-xs text-text-muted leading-relaxed">
                Open the app in Telegram and you’ll be signed into this same account.
              </p>
            </div>

            {!tgUnlinkOpen ? (
              <button
                onClick={() => { setTgUnlinkOpen(true); setTgUnlinkErr('') }}
                className="text-sm text-danger hover:underline"
              >
                Connected the wrong Telegram? Disconnect
              </button>
            ) : (
              <div className="space-y-2 rounded-lg border border-border bg-canvas p-3">
                <p className="text-xs text-text-muted">
                  Enter your password to disconnect. You can then link the correct Telegram account.
                  Only one Telegram can be linked at a time.
                </p>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={tgUnlinkPassword}
                  onChange={(e) => setTgUnlinkPassword(e.target.value)}
                  placeholder="Current password"
                  className="w-full px-3 py-2 border border-border rounded-lg text-sm bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
                />
                {tgUnlinkErr && <p className="text-sm text-danger">{tgUnlinkErr}</p>}
                <div className="flex gap-2">
                  <Button variant="danger" onClick={disconnectTelegram} disabled={tgUnlinkBusy || tgUnlinkPassword.length < 1}>
                    {tgUnlinkBusy ? <Spinner size="sm" /> : 'Disconnect Telegram'}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => { setTgUnlinkOpen(false); setTgUnlinkPassword(''); setTgUnlinkErr('') }}
                    disabled={tgUnlinkBusy}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
            <p className="text-sm text-text-muted">
              Link your Telegram account to sign in from the Telegram Mini App with this same account.
            </p>

            {!tgLink && (
              <>
                {tgErr && <p className="text-sm text-danger">{tgErr}</p>}
                <Button onClick={startTelegramLink} disabled={tgBusy}>
                  {tgBusy ? <Spinner size="sm" /> : 'Link Telegram'}
                </Button>
              </>
            )}

            {tgLink && (
              <div className="space-y-3">
                <ol className="text-sm text-text-muted list-decimal list-inside space-y-1">
                  <li>Tap the button below — it opens our bot in Telegram.</li>
                  <li>Press <strong>Start</strong> in the chat.</li>
                  <li>Come back here — this page updates automatically.</li>
                </ol>
                <a href={tgLink} target="_blank" rel="noopener noreferrer">
                  <Button className="w-full sm:w-auto">Open Telegram to confirm</Button>
                </a>
                {tgWaiting && (
                  <p className="text-xs text-text-muted flex items-center gap-1.5">
                    <Spinner size="sm" /> Waiting for you to confirm in Telegram…
                  </p>
                )}
                <p className="text-xs text-text-muted">This link expires in 15 minutes.</p>
              </div>
            )}
          </>
        )}
      </div>

      {/* Referral linkage — set who invited you (once) */}
      <WereYouReferred />
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('profile')

  const tabs: { id: Tab; label: string }[] = [
    { id: 'profile', label: 'Profile' },
    { id: 'security', label: 'Security' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'connections', label: 'Connections' },
    { id: 'sessions', label: 'Sessions' },
    { id: 'danger', label: 'Danger Zone' },
  ]

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-text-primary mb-6">Settings</h1>

      {/* Tabs — a 3-column grid on phones (two tidy rows of three) and a single
          6-column row on sm+. Each label gets its own cell with whitespace-nowrap
          so neighbours never merge and "Danger Zone" stays on one line, with no
          horizontal scroll. */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 bg-surface rounded-xl p-1.5 mb-6">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`min-w-0 py-2 px-1 rounded-lg text-xs sm:text-sm font-medium transition-colors text-center whitespace-nowrap ${
              activeTab === t.id
                ? 'bg-surface-alt text-text-primary shadow-sm'
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
      {activeTab === 'connections' && <ConnectionsTab />}
      {activeTab === 'sessions' && <SessionsTab />}
      {activeTab === 'danger' && (
        <div className="bg-danger/5 border border-danger/30 rounded-xl p-5 space-y-4">
          <h3 className="text-base font-bold text-danger whitespace-nowrap">Danger Zone</h3>
          <p className="text-sm text-text-muted">
            Deleting your account is permanent and cannot be undone. All your data, trades, and balances will be permanently deleted.
          </p>
          <div className="bg-surface shadow-card border border-border rounded-lg p-4">
            <p className="text-sm font-semibold text-text-primary mb-1">Delete Account</p>
            <p className="text-sm text-text-muted mb-3">
              To request account deletion, please contact our support team at{' '}
              <button type="button" onClick={() => openSupportEmail('Account Deletion Request')} className="text-primary underline">{SUPPORT_EMAIL}</button>{' '}
              from your registered email address.
            </p>
            <Button variant="secondary" disabled className="opacity-50">
              Contact Support to Delete Account
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
