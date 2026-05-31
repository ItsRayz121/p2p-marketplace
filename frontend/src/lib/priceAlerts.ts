export interface PriceAlert {
  id: string
  coin: string
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

export function addAlert(coin: string, direction: 'above' | 'below', targetPkr: number): PriceAlert {
  const alert: PriceAlert = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    coin,
    direction,
    targetPkr,
    createdAt: new Date().toISOString(),
    triggered: false,
  }
  const alerts = getAlerts()
  saveAlerts([...alerts, alert])
  return alert
}

export function removeAlert(id: string) {
  saveAlerts(getAlerts().filter((a) => a.id !== id))
}

export function clearTriggeredAlerts() {
  saveAlerts(getAlerts().filter((a) => !a.triggered))
}

// Check rate against all active alerts. Returns IDs that were newly triggered.
export function checkAlerts(currentRate: number): PriceAlert[] {
  const alerts = getAlerts()
  const triggered: PriceAlert[] = []
  const updated = alerts.map((a) => {
    if (a.triggered) return a
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
  new Notification(title, { body, icon: '/brand/logo-icon.png' })
}
