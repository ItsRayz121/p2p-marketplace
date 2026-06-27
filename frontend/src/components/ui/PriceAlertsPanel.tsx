'use client'
import { useState, useEffect, useCallback } from 'react'
import { Bell, BellOff, Trash2, Plus, ChevronDown } from 'lucide-react'
import { marketplaceApi, ctmApi } from '@/lib/api'
import {
  getAlerts,
  addAlert,
  removeAlert,
  clearTriggeredAlerts,
  type PriceAlert,
} from '@/lib/priceAlerts'

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}

// ─── Collapsible card shell ────────────────────────────────────────────────────

function CollapsibleCard({
  title,
  subtitle,
  defaultOpen = false,
  badge,
  children,
}: {
  title: string
  subtitle: string
  defaultOpen?: boolean
  badge?: number
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="bg-surface shadow-card border border-border rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 p-5 text-left hover:bg-surface-alt/50 transition-colors"
      >
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-text-primary flex items-center gap-2">
            {title}
            {badge != null && badge > 0 && (
              <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-primary/10 text-primary text-[11px] font-bold">
                {badge}
              </span>
            )}
          </h3>
          <p className="text-sm text-text-muted">{subtitle}</p>
        </div>
        <ChevronDown
          className={`w-5 h-5 text-text-muted flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>
      {open && <div className="px-5 pb-5 space-y-4">{children}</div>}
    </div>
  )
}

// Shared browser-notification permission prompt
function useNotifPermission() {
  const [perm, setPerm] = useState<NotificationPermission | null>(null)
  useEffect(() => {
    if ('Notification' in window) setPerm(Notification.permission)
  }, [])
  const request = useCallback(async () => {
    if (!('Notification' in window)) return
    const p = await Notification.requestPermission()
    setPerm(p)
  }, [])
  return { perm, request }
}

function NotifPermissionNotice({ perm, request }: { perm: NotificationPermission | null; request: () => void }) {
  if (perm === 'default') {
    return (
      <button
        onClick={request}
        className="w-full flex items-center gap-2 bg-primary/5 border border-primary/20 rounded-lg px-3 py-2 text-xs text-primary font-medium hover:bg-primary/10 transition-colors"
      >
        <Bell className="w-3.5 h-3.5 flex-shrink-0" aria-hidden />
        Enable browser notifications for alerts
      </button>
    )
  }
  if (perm === 'denied') {
    return (
      <div className="flex items-center gap-2 bg-warning/5 border border-warning/20 rounded-lg px-3 py-2 text-xs text-warning">
        <BellOff className="w-3.5 h-3.5 flex-shrink-0" aria-hidden />
        Notifications blocked. Alerts will show as in-app toasts instead.
      </div>
    )
  }
  return null
}

// Active / triggered alert lists, reused by both managers.
function AlertLists({
  alerts,
  onRemove,
  onClearTriggered,
}: {
  alerts: PriceAlert[]
  onRemove: (id: string) => void
  onClearTriggered: () => void
}) {
  const active = alerts.filter((a) => !a.triggered)
  const triggered = alerts.filter((a) => a.triggered)
  return (
    <>
      {active.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-text-primary">Active ({active.length})</p>
          {active.map((a) => (
            <div key={a.id} className="flex items-center justify-between bg-surface-alt rounded-lg px-3 py-2">
              <div>
                <p className="text-xs font-medium text-text-primary">
                  {a.label ? <span className="text-text-muted">{a.label} </span> : null}
                  {a.direction === 'above' ? '↑ Above' : '↓ Below'} PKR {a.targetPkr.toLocaleString()}
                </p>
                <p className="text-[10px] text-text-muted">Set {timeAgo(a.createdAt)}</p>
              </div>
              <button
                onClick={() => onRemove(a.id)}
                aria-label="Remove alert"
                className="text-text-muted hover:text-danger transition-colors p-1"
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}

      {triggered.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-success">Triggered ({triggered.length})</p>
            <button onClick={onClearTriggered} className="text-[10px] text-text-muted hover:text-danger transition-colors">
              Clear all
            </button>
          </div>
          {triggered.map((a) => (
            <div key={a.id} className="flex items-center justify-between bg-success/5 border border-success/20 rounded-lg px-3 py-2">
              <div>
                <p className="text-xs font-medium text-success">
                  ✓ {a.label ? `${a.label} ` : ''}{a.direction === 'above' ? 'Above' : 'Below'} PKR {a.targetPkr.toLocaleString()}
                </p>
                <p className="text-[10px] text-text-muted">Set {timeAgo(a.createdAt)}</p>
              </div>
              <button onClick={() => onRemove(a.id)} aria-label="Remove alert" className="text-text-muted hover:text-danger p-1">
                <Trash2 className="w-3.5 h-3.5" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}

      {active.length === 0 && triggered.length === 0 && (
        <p className="text-xs text-text-muted text-center py-2">
          No alerts set. Add one above to get notified when the rate moves.
        </p>
      )}
    </>
  )
}

// Direction toggle + target input + add button
function AddAlertForm({
  direction,
  setDirection,
  target,
  setTarget,
  onAdd,
  unitLabel,
  disabled,
}: {
  direction: 'above' | 'below'
  setDirection: (d: 'above' | 'below') => void
  target: string
  setTarget: (v: string) => void
  onAdd: () => void
  unitLabel: string
  disabled?: boolean
}) {
  return (
    <div className="flex gap-2">
      <div className="flex rounded-lg border border-border overflow-hidden flex-shrink-0">
        {(['above', 'below'] as const).map((d) => (
          <button
            key={d}
            onClick={() => setDirection(d)}
            className={`px-2.5 py-2 text-xs font-medium transition-colors capitalize ${
              direction === d ? 'bg-primary text-white' : 'bg-surface text-text-secondary hover:bg-surface-alt'
            }`}
          >
            {d}
          </button>
        ))}
      </div>
      <input
        type="number"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onAdd()}
        placeholder={`${unitLabel} price`}
        disabled={disabled}
        className="flex-1 min-w-0 px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
      />
      <button
        onClick={onAdd}
        disabled={disabled}
        aria-label="Add alert"
        className="flex-shrink-0 w-9 h-9 bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors flex items-center justify-center disabled:opacity-50"
      >
        <Plus className="w-4 h-4" aria-hidden />
      </button>
    </div>
  )
}

// ─── USDT / PKR price alerts (collapsible) ──────────────────────────────────────

export function PriceAlertsManager() {
  const [alerts, setAlerts] = useState<PriceAlert[]>([])
  const [currentRate, setCurrentRate] = useState<number | null>(null)
  const [target, setTarget] = useState('')
  const [direction, setDirection] = useState<'above' | 'below'>('above')
  const [formError, setFormError] = useState('')
  const { perm, request } = useNotifPermission()

  const reload = useCallback(() => setAlerts(getAlerts().filter((a) => a.coin === 'USDT')), [])
  useEffect(() => { reload() }, [reload])

  useEffect(() => {
    let active = true
    marketplaceApi.getRate('USDT')
      .then((r) => { if (active) setCurrentRate(r?.rate ?? null) })
      .catch(() => { /* rate is non-critical here */ })
    return () => { active = false }
  }, [])

  const handleAdd = () => {
    const n = parseFloat(target)
    if (!target || isNaN(n) || n <= 0) { setFormError('Enter a valid PKR price'); return }
    if (currentRate) {
      if (direction === 'above' && n <= currentRate) {
        setFormError(`Current rate is PKR ${currentRate.toLocaleString()} — target must be higher than current`); return
      }
      if (direction === 'below' && n >= currentRate) {
        setFormError(`Current rate is PKR ${currentRate.toLocaleString()} — target must be lower than current`); return
      }
    }
    addAlert('USDT', direction, n, 'USDT')
    setTarget('')
    setFormError('')
    reload()
  }

  const activeCount = alerts.filter((a) => !a.triggered).length

  return (
    <CollapsibleCard
      title="USDT / PKR Price Alerts"
      subtitle="Get notified when the USDT rate crosses a price you set."
      defaultOpen
      badge={activeCount}
    >
      {currentRate && (
        <div className="flex items-center justify-between bg-surface-alt rounded-lg px-3 py-2 text-xs">
          <span className="text-text-muted">Current rate</span>
          <span className="font-bold text-text-primary">PKR {currentRate.toLocaleString()}</span>
        </div>
      )}

      <NotifPermissionNotice perm={perm} request={request} />

      <div className="space-y-2">
        <p className="text-xs font-medium text-text-primary">Set new alert</p>
        <AddAlertForm
          direction={direction}
          setDirection={setDirection}
          target={target}
          setTarget={(v) => { setTarget(v); setFormError('') }}
          onAdd={handleAdd}
          unitLabel="PKR"
        />
        {formError && <p className="text-xs text-danger">{formError}</p>}
        <p className="text-[11px] text-text-muted">
          You&apos;ll be notified when 1 USDT goes{' '}
          <span className="font-medium text-text-secondary">{direction}</span>{' '}
          PKR {target ? parseFloat(target).toLocaleString() : '—'}
        </p>
      </div>

      <AlertLists
        alerts={alerts}
        onRemove={(id) => { removeAlert(id); reload() }}
        onClearTriggered={() => { clearTriggeredAlerts((a) => a.coin === 'USDT'); reload() }}
      />
    </CollapsibleCard>
  )
}

// ─── CTM token price alerts (collapsible) ───────────────────────────────────────

interface CtmTokenLite { slug: string; symbol: string; name: string }

export function CtmPriceAlertsManager() {
  const [alerts, setAlerts] = useState<PriceAlert[]>([])
  const [tokens, setTokens] = useState<CtmTokenLite[]>([])
  const [rateBySlug, setRateBySlug] = useState<Record<string, number | null>>({})
  const [selectedSlug, setSelectedSlug] = useState('')
  const [target, setTarget] = useState('')
  const [direction, setDirection] = useState<'above' | 'below'>('above')
  const [formError, setFormError] = useState('')
  const [loaded, setLoaded] = useState(false)

  // CTM alerts = any alert that isn't the USDT stablecoin.
  const reload = useCallback(() => setAlerts(getAlerts().filter((a) => a.coin !== 'USDT')), [])
  useEffect(() => { reload() }, [reload])

  useEffect(() => {
    let active = true
    Promise.allSettled([
      ctmApi.getTokens({ limit: 50 }),
      marketplaceApi.getMarketRatesSummary(),
    ]).then(([tokensRes, ratesRes]) => {
      if (!active) return
      if (tokensRes.status === 'fulfilled') {
        const list = (tokensRes.value as { tokens: CtmTokenLite[] }).tokens ?? []
        setTokens(list)
        if (list.length && !selectedSlug) setSelectedSlug(list[0].slug)
      }
      if (ratesRes.status === 'fulfilled') {
        const map: Record<string, number | null> = {}
        for (const t of ratesRes.value.communityTokens) map[t.slug] = t.averagePkrRate
        setRateBySlug(map)
      }
      setLoaded(true)
    })
    return () => { active = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const currentRate = selectedSlug ? rateBySlug[selectedSlug] ?? null : null
  const selectedToken = tokens.find((t) => t.slug === selectedSlug)

  const handleAdd = () => {
    if (!selectedToken) { setFormError('Select a token first'); return }
    const n = parseFloat(target)
    if (!target || isNaN(n) || n <= 0) { setFormError('Enter a valid PKR price'); return }
    if (currentRate) {
      if (direction === 'above' && n <= currentRate) {
        setFormError(`Current ${selectedToken.symbol} rate is PKR ${currentRate.toLocaleString()} — target must be higher`); return
      }
      if (direction === 'below' && n >= currentRate) {
        setFormError(`Current ${selectedToken.symbol} rate is PKR ${currentRate.toLocaleString()} — target must be lower`); return
      }
    }
    addAlert(selectedToken.slug, direction, n, selectedToken.symbol)
    setTarget('')
    setFormError('')
    reload()
  }

  const activeCount = alerts.filter((a) => !a.triggered).length

  return (
    <CollapsibleCard
      title="CTM Token Price Alerts"
      subtitle="Pick a community token and get notified when its PKR price crosses your target."
      badge={activeCount}
    >
      {loaded && tokens.length === 0 ? (
        <p className="text-xs text-text-muted text-center py-2">
          No community tokens are available right now.
        </p>
      ) : (
        <>
          {/* Token picker */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-text-primary">Token</p>
            <div className="relative">
              <select
                value={selectedSlug}
                onChange={(e) => { setSelectedSlug(e.target.value); setTarget(''); setFormError('') }}
                className="w-full appearance-none px-3 py-2 pr-9 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                {tokens.map((t) => (
                  <option key={t.slug} value={t.slug}>{t.symbol} — {t.name}</option>
                ))}
              </select>
              <ChevronDown className="w-4 h-4 text-text-muted absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
            </div>
          </div>

          {/* Current rate for the picked token */}
          <div className="flex items-center justify-between bg-surface-alt rounded-lg px-3 py-2 text-xs">
            <span className="text-text-muted">Current {selectedToken?.symbol ?? 'token'} rate</span>
            <span className="font-bold text-text-primary">
              {currentRate != null ? `PKR ${currentRate.toLocaleString()}` : 'No recent trades'}
            </span>
          </div>

          {/* Add alert */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-text-primary">Set new alert</p>
            <AddAlertForm
              direction={direction}
              setDirection={setDirection}
              target={target}
              setTarget={(v) => { setTarget(v); setFormError('') }}
              onAdd={handleAdd}
              unitLabel="PKR"
              disabled={!selectedToken}
            />
            {formError && <p className="text-xs text-danger">{formError}</p>}
            <p className="text-[11px] text-text-muted">
              You&apos;ll be notified when 1 {selectedToken?.symbol ?? 'token'} goes{' '}
              <span className="font-medium text-text-secondary">{direction}</span>{' '}
              PKR {target ? parseFloat(target).toLocaleString() : '—'}
            </p>
          </div>

          <AlertLists
            alerts={alerts}
            onRemove={(id) => { removeAlert(id); reload() }}
            onClearTriggered={() => { clearTriggeredAlerts((a) => a.coin !== 'USDT'); reload() }}
          />
        </>
      )}
    </CollapsibleCard>
  )
}
