import { apiRequest } from './api'

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)))
}

export async function getVapidPublicKey(): Promise<string | null> {
  try {
    const res = await apiRequest<{ vapidPublicKey: string }>('/push/vapid-public-key', { method: 'GET' })
    return res.vapidPublicKey
  } catch {
    return null
  }
}

export async function subscribeToPush(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return null

  const reg = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready

  const vapidKey = await getVapidPublicKey()
  if (!vapidKey) return null

  const existing = await reg.pushManager.getSubscription()
  if (existing) return existing

  const keyBytes = urlBase64ToUint8Array(vapidKey)
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes.buffer as ArrayBuffer,
  })
}

export async function savePushSubscription(sub: PushSubscription): Promise<void> {
  const raw = sub.toJSON()
  await apiRequest('/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({
      endpoint: sub.endpoint,
      keys: raw.keys,
      userAgent: navigator.userAgent.slice(0, 200),
    }),
  })
}

export async function unsubscribeFromPush(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  const reg = await navigator.serviceWorker.getRegistration('/sw.js')
  if (!reg) return
  const sub = await reg.pushManager.getSubscription()
  if (!sub) return
  await apiRequest('/push/unsubscribe', {
    method: 'DELETE',
    body: JSON.stringify({ endpoint: sub.endpoint }),
  })
  await sub.unsubscribe()
}
