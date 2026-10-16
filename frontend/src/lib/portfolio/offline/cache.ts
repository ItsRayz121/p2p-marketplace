import type { PortfolioAssetDto } from '@/lib/api'
import type { Currency, PortfolioEventInput, PortfolioSummaryResponse } from '../types'
import { openStore, type KeyValueStore } from '../local/idb'

/**
 * A device-local copy of the signed-in user's last portfolio view, plus entries recorded while
 * offline that are waiting to sync.
 *
 * Privacy rules:
 *  - it is keyed by user id and dropped if a DIFFERENT user is ever seen on this device;
 *  - it is deleted on logout / session end (see auth.store clearAuth);
 *  - it holds no passwords, tokens, seed phrases or keys, only the portfolio view the user already saw.
 * Only analytical edits are queued (recording an entry). Nothing that moves money is ever queued.
 */
const DB = 'rupchain-portfolio-cache'
export const MAX_QUEUE = 200

let storePromise: Promise<KeyValueStore> | null = null
const store = () => (storePromise ??= openStore(DB))

/** Test hook: forget the opened store so a fresh fake IndexedDB is used. */
export function resetCacheForTests() { storePromise = null }

export interface Snapshot {
  savedAt: string
  currency: Currency
  assets: PortfolioAssetDto[]
  summary: PortfolioSummaryResponse | null
}

export interface QueuedEntry {
  id: string
  assetId: string
  assetName: string
  input: PortfolioEventInput
  queuedAt: string
  status: 'pending' | 'failed'
  error?: string
}

const snapKey = (u: string) => `snap:${u}`
const queueKey = (u: string) => `queue:${u}`
const OWNER = 'owner'

/** Call when a user opens the tracker: anything cached for a different user is wiped first. */
export async function claimCacheOwner(userId: string): Promise<void> {
  try {
    const s = await store()
    const owner = await s.get<string>(OWNER)
    if (owner !== undefined && owner !== userId) {
      for (const k of await s.keys()) await s.delete(k)
    }
    if (owner !== userId) await s.set(OWNER, userId)
  } catch { /* the cache is a convenience; never let it break the tracker */ }
}

export async function saveSnapshot(userId: string, snap: Snapshot): Promise<void> {
  try { await (await store()).set(snapKey(userId), snap) } catch { /* ignore */ }
}

export async function loadSnapshot(userId: string): Promise<Snapshot | undefined> {
  try { return await (await store()).get<Snapshot>(snapKey(userId)) } catch { return undefined }
}

export async function loadQueue(userId: string): Promise<QueuedEntry[]> {
  try { return (await (await store()).get<QueuedEntry[]>(queueKey(userId))) ?? [] } catch { return [] }
}

export async function saveQueue(userId: string, q: QueuedEntry[]): Promise<void> {
  try { await (await store()).set(queueKey(userId), q.slice(0, MAX_QUEUE)) } catch { /* ignore */ }
}

/** Remove everything this feature stored on the device. Never throws. */
export async function purgePortfolioCache(): Promise<void> {
  try {
    const s = await store()
    for (const k of await s.keys()) await s.delete(k)
  } catch { /* nothing to purge or storage unavailable */ }
}
