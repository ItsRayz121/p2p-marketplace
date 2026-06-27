'use client'
import { useState, useEffect, useCallback } from 'react'
import { Bell, BellOff, Trash2, Plus } from 'lucide-react'
import { marketplaceApi } from '@/lib/api'
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

/**
 * Inline USDT/PKR price-alerts manager. Previously this lived behind a bell
 * dropdown in the marketplace header; it now renders as a settings card under
 * Settings → Notifications. It fetches the live USDT rate itself so it can
 * validate new alert targets. Alert evaluation (firing notifications) still
 * happens on the marketplace page while its rate poller is running.
 */
export function PriceAlertsManager() {
  const [alerts, setAlerts] = useState<PriceAlert[]>([])
  const [currentRate, setCurrentRate] = useState<number | null>(null)
  const [target, setTarget] = useState('')
  const [direction, setDirection] = useState<'above' | 'below'>('above')
  const [formError, setFormError] = useState('')
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | null>(null)

  const reload = useCallback(() => setAlerts(getAlerts()), [])

  useEffect(() => { reload() }, [reload])

  useEffect(() => {
    if ('Notification' in window) setNotifPermission(Notification.permission)
  }, [])

  useEffect(() => {
    let active = true
    marketplaceApi.getRate('USDT')
      .then((r) => { if (active) setCurrentRate(r?.rate ?? null) })
      .catch(() => { /* rate is non-critical here */ })
    return () => { active = false }
  }, [])

  const activeCount = alerts.filter((a) => !a.triggered).length
  const triggeredCount = alerts.filter((a) => a.triggered).length

  const handleAdd = () => {
    const n = parseFloat(target)
    if (!target || isNaN(n) || n <= 0) {
      setFormError('Enter a valid PKR price')
      return
    }
    if (currentRate) {
      if (direction === 'above' && n <= currentRate) {
        setFormError(`Current rate is PKR ${currentRate.toLocaleString()} — target must be higher than current`)
        return
      }
      if (direction === 'below' && n >= currentRate) {
        setFormError(`Current rate is PKR ${currentRate.toLocaleString()} — target must be lower than current`)
        return
      }
    }
    addAlert('USDT', direction, n)
    setTarget('')
    setFormError('')
    reload()
  }

  const handleRemove = (id: string) => {
    removeAlert(id)
    reload()
  }

  const handleClearTriggered = () => {
    clearTriggeredAlerts()
    reload()
  }

  const handleRequestNotif = async () => {
    if (!('Notification' in window)) return
    const p = await Notification.requestPermission()
    setNotifPermission(p)
  }

  return (
    <div className="bg-surface shadow-card border border-border rounded-xl p-5 space-y-4">
      <div>
        <h3 className="text-base font-semibold text-text-primary">USDT / PKR Price Alerts</h3>
        <p className="text-sm text-text-muted">Get notified when the USDT rate crosses a price you set.</p>
      </div>

      {/* Current rate display */}
      {currentRate && (
        <div className="flex items-center justify-between bg-surface-alt rounded-lg px-3 py-2 text-xs">
          <span className="text-text-muted">Current rate</span>
          <span className="font-bold text-text-primary">PKR {currentRate.toLocaleString()}</span>
        </div>
      )}

      {/* Notification permission prompt */}
      {notifPermission === 'default' && (
        <button
          onClick={handleRequestNotif}
          className="w-full flex items-center gap-2 bg-primary/5 border border-primary/20 rounded-lg px-3 py-2 text-xs text-primary font-medium hover:bg-primary/10 transition-colors"
        >
          <Bell className="w-3.5 h-3.5 flex-shrink-0" aria-hidden />
          Enable browser notifications for alerts
        </button>
      )}
      {notifPermission === 'denied' && (
        <div className="flex items-center gap-2 bg-warning/5 border border-warning/20 rounded-lg px-3 py-2 text-xs text-warning">
          <BellOff className="w-3.5 h-3.5 flex-shrink-0" aria-hidden />
          Notifications blocked. Alerts will show as in-app toasts instead.
        </div>
      )}

      {/* Add alert form */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-text-primary">Set new alert</p>
        <div className="flex gap-2">
          {/* Direction toggle */}
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
          {/* Target input */}
          <input
            type="number"
            value={target}
            onChange={(e) => { setTarget(e.target.value); setFormError('') }}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            placeholder="PKR price"
            className="flex-1 min-w-0 px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <button
            onClick={handleAdd}
            aria-label="Add alert"
            className="flex-shrink-0 w-9 h-9 bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors flex items-center justify-center"
          >
            <Plus className="w-4 h-4" aria-hidden />
          </button>
        </div>
        {formError && <p className="text-xs text-danger">{formError}</p>}
        <p className="text-[11px] text-text-muted">
          You&apos;ll be notified when 1 USDT goes{' '}
          <span className="font-medium text-text-secondary">{direction}</span>{' '}
          PKR {target ? parseFloat(target).toLocaleString() : '—'}
        </p>
      </div>

      {/* Active alerts list */}
      {activeCount > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-text-primary">Active ({activeCount})</p>
          {alerts.filter((a) => !a.triggered).map((a) => (
            <div key={a.id} className="flex items-center justify-between bg-surface-alt rounded-lg px-3 py-2">
              <div>
                <p className="text-xs font-medium text-text-primary">
                  {a.direction === 'above' ? '↑ Above' : '↓ Below'} PKR {a.targetPkr.toLocaleString()}
                </p>
                <p className="text-[10px] text-text-muted">Set {timeAgo(a.createdAt)}</p>
              </div>
              <button
                onClick={() => handleRemove(a.id)}
                aria-label="Remove alert"
                className="text-text-muted hover:text-danger transition-colors p-1"
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Triggered alerts */}
      {triggeredCount > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-success">Triggered ({triggeredCount})</p>
            <button onClick={handleClearTriggered} className="text-[10px] text-text-muted hover:text-danger transition-colors">
              Clear all
            </button>
          </div>
          {alerts.filter((a) => a.triggered).map((a) => (
            <div key={a.id} className="flex items-center justify-between bg-success/5 border border-success/20 rounded-lg px-3 py-2">
              <div>
                <p className="text-xs font-medium text-success">
                  ✓ {a.direction === 'above' ? 'Above' : 'Below'} PKR {a.targetPkr.toLocaleString()}
                </p>
                <p className="text-[10px] text-text-muted">Set {timeAgo(a.createdAt)}</p>
              </div>
              <button onClick={() => handleRemove(a.id)} aria-label="Remove alert" className="text-text-muted hover:text-danger p-1">
                <Trash2 className="w-3.5 h-3.5" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {activeCount === 0 && triggeredCount === 0 && (
        <p className="text-xs text-text-muted text-center py-2">
          No alerts set. Add one above to get notified when the rate moves.
        </p>
      )}
    </div>
  )
}
