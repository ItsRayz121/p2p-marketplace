export interface PriceAlert {
  id: string
  /** 'USDT' for the stablecoin, or a CTM token slug (e.g. 'mec') */
  coin: string
  /** Human label shown in alert lists / notifications (e.g. 'USDT', 'MEC') */
  label?: string
  direction: 'above' | 'below'
  targetPkr: number
  createdAt: string
  triggered: boolean
}

const KEY = 'rupchain-price-alerts'

export function getAlerts(): PriceAlert[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as PriceAlert[]) : []
  } catch {
    return []
  }
}

export function saveAlerts(alerts: PriceAlert[]) {
  localStorage.setItem(KEY, JSON.stringify(alerts))
}

export function addAlert(coin: string, direction: 'above' | 'below', targetPkr: number, label?: string): PriceAlert {
  const alert: PriceAlert = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    coin,
    ...(label ? { label } : {}),
    direction,
    targetPkr,
    createdAt: new Date().toISOString(),
    triggered: false,
  }
  const alerts = getAlerts()
  saveAlerts([...alerts, alert])
  return alert
}

export function getAlertsForCoin(coin: string): PriceAlert[] {
  return getAlerts().filter((a) => a.coin === coin)
}

export function removeAlert(id: string) {
  saveAlerts(getAlerts().filter((a) => a.id !== id))
}

export function clearTriggeredAlerts() {
  saveAlerts(getAlerts().filter((a) => !a.triggered))
}

// Check a coin's rate against its active alerts. Returns the alerts that were
// newly triggered. Only alerts whose `coin` matches are evaluated, so USDT and
// each CTM token are scored against their own rate.
export function checkAlerts(coin: string, currentRate: number): PriceAlert[] {
  const alerts = getAlerts()
  const triggered: PriceAlert[] = []
  const updated = alerts.map((a) => {
    if (a.triggered || a.coin !== coin) return a
    const hit =
      (a.direction === 'above' && currentRate >= a.targetPkr) ||
      (a.direction === 'below' && currentRate <= a.targetPkr)
    if (hit) {
      triggered.push(a)
      return { ...a, triggered: true }
    }
    return a
  })
  if (triggered.length) saveAlerts(updated)
  return triggered
}

// Request browser notification permission and fire a notification.
export async function requestAndNotify(title: string, body: string) {
  if (typeof window === 'undefined' || !('Notification' in window)) return
  if (Notification.permission === 'denied') return
  if (Notification.permission !== 'granted') {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return
  }
  new Notification(title, { body, icon: '/brand/icon-192.png' })
}
