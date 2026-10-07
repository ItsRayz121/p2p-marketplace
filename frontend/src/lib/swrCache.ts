// Tiny in-memory stale-while-revalidate store.
//
// Pages used to start every visit with `loading = true` and a spinner, even when
// the user had loaded the same screen seconds earlier. Seeding state from the
// last response lets the page paint instantly while the normal fetch refreshes
// it in the background.
//
// Memory only (gone on reload) and wiped on logout, so one account's data can
// never show up for another. Keys for user-specific data must include the user
// id — see `userKey`.

const store = new Map<string, { value: unknown; at: number }>()

/** Entries older than this are ignored — better a spinner than very old data. */
const MAX_AGE_MS = 10 * 60_000

export function swrGet<T>(key: string): T | undefined {
  const hit = store.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.at > MAX_AGE_MS) {
    store.delete(key)
    return undefined
  }
  return hit.value as T
}

export function swrSet<T>(key: string, value: T): void {
  store.set(key, { value, at: Date.now() })
}

export function swrClear(): void {
  store.clear()
}

/** Namespace a key by user so cached private data is never shared across accounts. */
export const userKey = (userId: string | undefined, key: string): string => `u:${userId ?? 'anon'}:${key}`
