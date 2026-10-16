/**
 * A tiny key-value store over IndexedDB, with an in-memory fallback.
 *
 * Browser storage is NOT a backup and NOT automatically private: it can be cleared by the user,
 * evicted by the browser, lost with the device, and read by any script running on this site
 * (which is why no secrets are ever stored here). `persistent: false` means the fallback is in use
 * and the data will disappear when the tab closes; the UI must say so.
 */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
  readonly persistent: boolean
}

const STORE = 'kv'

function memoryStore(): KeyValueStore {
  const map = new Map<string, string>()
  return {
    persistent: false,
    async get<T>(key: string) { const v = map.get(key); return v === undefined ? undefined : (JSON.parse(v) as T) },
    async set(key, value) { map.set(key, JSON.stringify(value)) },
    async delete(key) { map.delete(key) },
    async keys() { return [...map.keys()] },
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

export async function openStore(dbName: string): Promise<KeyValueStore> {
  if (typeof indexedDB === 'undefined') return memoryStore()
  let db: IDBDatabase
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(dbName, 1)
      open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE) }
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error ?? new Error('IndexedDB open failed'))
      open.onblocked = () => reject(new Error('IndexedDB blocked'))
    })
  } catch {
    return memoryStore() // private mode / blocked storage: keep working, but say it is not saved
  }

  const store = (mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE)
  return {
    persistent: true,
    async get<T>(key: string) { return (await request(store('readonly').get(key))) as T | undefined },
    async set(key, value) { await request(store('readwrite').put(JSON.parse(JSON.stringify(value)), key)) },
    async delete(key) { await request(store('readwrite').delete(key)) },
    async keys() { return (await request(store('readonly').getAllKeys())).map(String) },
  }
}
