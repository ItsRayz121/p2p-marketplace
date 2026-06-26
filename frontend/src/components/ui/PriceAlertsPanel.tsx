'use client'
import { useState, useEffect, useCallback } from 'react'
import { Bell, BellOff, Trash2, Plus, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import {
  getAlerts,
  addAlert,
  removeAlert,
  clearTriggeredAlerts,
  type PriceAlert,
} from '@/lib/priceAlerts'

interface Props {
  currentRate: number | null
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}

export function PriceAlertsPanel({ currentRate }: Props) {
  const [open, setOpen] = useState(false)
  const [alerts, setAlerts] = useState<PriceAlert[]>([])
  const [target, setTarget] = useState('')
  const [direction, setDirection] = useState<'above' | 'below'>('above')
  const [formError, setFormError] = useState('')
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | null>(null)

  const reload = useCallback(() => setAlerts(getAlerts()), [])

  useEffect(() => { reload() }, [reload])

  useEffect(() => {
    if ('Notification' in window) setNotifPermission(Notification.permission)
  }, [open])

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
    <div className="relative">
      {/* Trigger button */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={`Price alerts${activeCount > 0 ? ` — ${activeCount} active` : ''}`}
        className="relative flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-surface text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-surface-alt transition-colors"
      >
        <Bell className="w-4 h-4" aria-hidden />
        <span className="hidden sm:inline">Alerts</span>
        {activeCount > 0 && (
          <span className="min-w-[18px] h-[18px] bg-primary text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1">
            {activeCount}
          </span>
        )}
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>

      {/* Panel — on mobile it's a fixed, fully on-screen card (inset from both
          edges) so it can never spill off the left/right like an anchored
          right-0 w-80 dropdown does when the bell sits near a screen edge. On
          sm+ it reverts to the anchored dropdown below the trigger. */}
      {open && (
        <div className="fixed inset-x-4 top-16 z-50 mx-auto w-auto max-w-sm bg-surface border border-border rounded-xl shadow-card-lg overflow-hidden sm:absolute sm:inset-auto sm:right-0 sm:top-full sm:mt-2 sm:w-80 sm:max-w-none sm:mx-0">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h3 className="text-sm font-semibold text-text-primary">USDT / PKR Price Alerts</h3>
            <button onClick={() => setOpen(false)} className="text-text-muted hover:text-text-primary" aria-label="Close">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="p-4 space-y-4">
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
                  className="flex-1 px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary/30"
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
                You'll be notified when 1 USDT goes{' '}
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
        </div>
      )}
    </div>
  )
}
