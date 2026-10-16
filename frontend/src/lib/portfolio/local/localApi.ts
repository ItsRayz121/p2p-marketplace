import type { PortfolioAssetDto, PortfolioAssetInput } from '@/lib/api'
import { validateCustomAsset } from '../customAsset'
import { chooseFxStamp, cleanRate } from '../engine/currency'
import { computePerformance, currentMarksIn } from '../engine/performance'
import { buildSummary, type EventRow, type PriceRow } from '../engine/summaryBuilder'
import { parseBackup, type ExportAsset, type ExportData, type ExportEvent, type ExportPrice, BACKUP_FORMAT, BACKUP_VERSION } from '../exportFile'
import type { PortfolioApiLike } from '../apiTypes'
import type { Currency, PerformanceResponse, PortfolioEvent, PortfolioEventInput, PortfolioSummaryResponse } from '../types'
import { validateEventInput } from './eventRules'
import type { KeyValueStore } from './idb'

/**
 * The local-only tracker: the same screens and the same calculation engine as the signed-in tracker,
 * but the data lives in this browser only. Nothing is sent anywhere. Guest data is never mixed
 * with an account's data; moving it to an account is a separate, explicit step (a backup file).
 */
export const MAX_LOCAL_ASSETS = 200
export const MAX_LOCAL_EVENTS = 5000
const KEY = 'data'
const CORRUPT_KEY = 'data-corrupt'
const MAX_RANGE_MS = 25 * 365 * 24 * 60 * 60 * 1000

interface LocalState {
  version: 1
  assets: ExportAsset[]
  events: ExportEvent[]
  prices: ExportPrice[]
  /** The USDT/PKR rate the user typed in, used only to value current prices in the other currency. */
  settings: { usdtPkr: string | null }
  /** clientRequestId -> event id, so a retried save never records twice. */
  requestIds: Record<string, string>
}

const emptyState = (): LocalState => ({ version: 1, assets: [], events: [], prices: [], settings: { usdtPkr: null }, requestIds: {} })

const uuid = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `id-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`)

export interface LocalTracker {
  api: PortfolioApiLike
  /** True if stored data could not be read and was set aside (an empty tracker was started). */
  recovered: boolean
  /** False when browser storage is unavailable and data lives in memory only. */
  persistent: boolean
  getUsdtPkr(): string | null
  setUsdtPkr(rate: string | null): Promise<void>
  /** Plain JSON backup of everything. */
  backupText(): string
  /** Replace everything with the contents of a validated backup. */
  replaceAll(data: ExportData): Promise<void>
  /** Remove everything stored in this browser. */
  clearAll(): Promise<void>
  counts(): { assets: number; events: number }
}

export async function createLocalTracker(store: KeyValueStore): Promise<LocalTracker> {
  let state = emptyState()
  let recovered = false

  const stored = await store.get<unknown>(KEY)
  if (stored !== undefined) {
    const s = stored as Partial<LocalState>
    const check = parseBackup(JSON.stringify({
      format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date(0).toISOString(),
      assets: s.assets, events: s.events, prices: s.prices,
    }))
    const rate = cleanRate(s.settings?.usdtPkr ?? null)
    if (check.ok && (s.settings?.usdtPkr == null || rate !== null)) {
      state = { version: 1, assets: check.data.assets, events: check.data.events, prices: check.data.prices, settings: { usdtPkr: rate }, requestIds: s.requestIds ?? {} }
    } else {
      recovered = true
      await store.set(CORRUPT_KEY, stored) // keep the unreadable copy rather than destroying it
    }
  }

  const persist = () => store.set(KEY, state)
  const fail = (message: string): never => { throw new Error(message) }

  const dto = (a: ExportAsset): PortfolioAssetDto => ({
    id: a.id, name: a.name, symbol: a.symbol, sourceUrl: a.sourceUrl, network: a.network, contractAddress: a.contractAddress,
    createdAt: a.createdAt, archivedAt: a.archivedAt,
  })
  const find = (id: string) => state.assets.find((a) => a.id === id) ?? fail('Token not found')

  // Voided entries (from an account backup) are shown in history but never counted, exactly as on the server.
  const rows = (): EventRow[] => state.events.filter((e) => !e.voided).map((e) => ({
    id: e.id, assetId: e.assetId, type: e.type, occurredAt: new Date(e.occurredAt), quantity: e.quantity,
    consideration: e.consideration, fee: e.fee, basis: e.basis, zeroCost: e.zeroCost, quote: e.quote, fxRate: cleanRate(e.fxRate),
  }))
  const priceRows = (): PriceRow[] => state.prices
    .map((p) => ({ assetId: p.assetId, price: p.price, quote: p.quote, observedAt: new Date(p.observedAt) }))
    .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime())
  const latestPrices = (): PriceRow[] => {
    const m = new Map<string, PriceRow>()
    for (const p of priceRows()) m.set(p.assetId, p)
    return [...m.values()]
  }

  const api: PortfolioApiLike = {
    async listAssets(includeArchived = true) {
      return state.assets.filter((a) => includeArchived || !a.archivedAt).map(dto)
    },

    async addAsset(data: PortfolioAssetInput) {
      const v = validateCustomAsset({
        name: data.name, symbol: data.symbol ?? undefined, sourceUrl: data.sourceUrl ?? undefined,
        network: data.network ?? undefined, contractAddress: data.contractAddress ?? undefined,
      })
      if (!v.ok) return fail(Object.values(v.errors)[0] ?? 'Invalid token details')
      if (state.assets.length >= MAX_LOCAL_ASSETS) return fail(`You can track up to ${MAX_LOCAL_ASSETS} custom tokens`)
      const asset: ExportAsset = { id: uuid(), ...v.value, createdAt: new Date().toISOString(), archivedAt: null }
      state.assets.push(asset)
      await persist()
      return dto(asset)
    },

    async updateAsset(id, data) {
      const v = validateCustomAsset({
        name: data.name, symbol: data.symbol ?? undefined, sourceUrl: data.sourceUrl ?? undefined,
        network: data.network ?? undefined, contractAddress: data.contractAddress ?? undefined,
      })
      if (!v.ok) return fail(Object.values(v.errors)[0] ?? 'Invalid token details')
      const a = find(id)
      Object.assign(a, v.value) // display metadata only: no entry, price or result is touched
      await persist()
      return dto(a)
    },

    async archiveAsset(id) {
      const a = find(id)
      if (a.archivedAt) fail('This token is already archived.')
      a.archivedAt = new Date().toISOString()
      await persist()
    },
    async unarchiveAsset(id) {
      const a = find(id)
      if (!a.archivedAt) fail('This token is already not archived.')
      a.archivedAt = null
      await persist()
    },
    async deleteAsset(id) {
      find(id)
      if (state.events.some((e) => e.assetId === id)) fail('This token has records. Archive it instead so your history is kept.')
      state.assets = state.assets.filter((a) => a.id !== id)
      state.prices = state.prices.filter((p) => p.assetId !== id)
      await persist()
    },

    async listEvents(assetId) {
      find(assetId)
      return state.events
        .filter((e) => e.assetId === assetId)
        .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
        .map((e): PortfolioEvent => ({ ...e }))
    },

    async addEvent(assetId: string, data: PortfolioEventInput) {
      const asset = find(assetId)
      if (asset.archivedAt) fail('This token is archived. Restore it before adding records.')
      const check = validateEventInput(data, Date.now())
      if (!check.ok) return fail(check.error)
      const e = check.value
      if (e.clientRequestId && state.requestIds[e.clientRequestId]) {
        const existing = state.events.find((x) => x.id === state.requestIds[e.clientRequestId!])
        if (existing && existing.assetId === assetId) return { ...existing }
        fail('This request id was already used for a different token')
      }
      if (state.events.length >= MAX_LOCAL_EVENTS) fail(`You can record up to ${MAX_LOCAL_EVENTS} entries`)

      // Rate: the user's own, or (for entries dated now) the current rate the user typed in. Never for old entries.
      const stamp = chooseFxStamp({ userRate: e.fxRate, platformRate: e.fxRate ? null : state.settings.usdtPkr, occurredAtMs: Date.parse(e.occurredAt), nowMs: Date.now() })
      const entry: ExportEvent = {
        id: uuid(), assetId, type: e.type, occurredAt: e.occurredAt, quantity: e.quantity, consideration: e.consideration, fee: e.fee,
        basis: e.basis, zeroCost: e.zeroCost, quote: e.quote, fxRate: stamp.fxRate, fxSource: stamp.fxSource ? 'manual' : null,
        note: e.note, source: 'manual', voided: false, voidReason: null,
      }
      state.events.push(entry)
      if (e.clientRequestId) state.requestIds[e.clientRequestId] = entry.id
      await persist()
      return { ...entry }
    },

    async deleteEvent(assetId, eventId) {
      const i = state.events.findIndex((e) => e.id === eventId && e.assetId === assetId)
      if (i < 0) fail('Entry not found')
      state.events.splice(i, 1)
      state.requestIds = Object.fromEntries(Object.entries(state.requestIds).filter(([, id]) => id !== eventId))
      await persist()
    },

    async setPrice(assetId, price, quote: Currency = 'PKR') {
      const asset = find(assetId)
      if (asset.archivedAt) fail('This token is archived. Restore it before adding records.')
      if (!/^\d{1,28}(\.\d{1,18})?$/.test(price) || /^0+(\.0+)?$/.test(price)) fail('Price must be greater than zero')
      const p: ExportPrice = { assetId, price, quote, observedAt: new Date().toISOString() }
      state.prices.push(p)
      await persist()
      return { price: p.price, quote: p.quote, observedAt: p.observedAt }
    },

    async summary(currency: Currency = 'PKR'): Promise<PortfolioSummaryResponse> {
      return buildSummary({ events: rows(), prices: latestPrices(), currency, platformRate: state.settings.usdtPkr }) as unknown as PortfolioSummaryResponse
    },

    async performance(opts): Promise<PerformanceResponse> {
      const now = new Date()
      const to = opts.to ? new Date(opts.to) : now
      const first = rows().reduce<Date | null>((m, r) => (m === null || r.occurredAt < m ? r.occurredAt : m), null)
      const from = opts.from ? new Date(opts.from) : (first ?? to)
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return fail('Invalid date range')
      if (from.getTime() > to.getTime()) return fail('The start date must be before the end date')
      if (to.getTime() - from.getTime() > MAX_RANGE_MS) return fail('That date range is too long')
      return computePerformance({
        events: rows(), prices: priceRows(), currency: opts.currency,
        currentMarks: currentMarksIn(latestPrices(), opts.currency, cleanRate(state.settings.usdtPkr)),
        from, to, now,
      }) as unknown as PerformanceResponse
    },

    async exportAll(): Promise<ExportData> {
      return {
        exportedAt: new Date().toISOString(),
        assets: state.assets.map((a) => ({ ...a, linkedToRupChainToken: false })),
        events: state.events.map((e) => ({ ...e })),
        prices: state.prices.map((p) => ({ ...p })),
      }
    },
    // importCtm / suggestListing / withdrawListingSuggestion are deliberately absent: they involve
    // RupChain's own records and need an account.
  }

  return {
    api,
    recovered,
    persistent: store.persistent,
    getUsdtPkr: () => state.settings.usdtPkr,
    async setUsdtPkr(rate) {
      if (rate !== null && cleanRate(rate) === null) throw new Error('Enter the rate as a plain number greater than zero, for example 280.5')
      state.settings.usdtPkr = rate === null ? null : cleanRate(rate)
      await persist()
    },
    backupText: () => JSON.stringify({
      format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(),
      assets: state.assets.map((a) => ({ ...a, linkedToRupChainToken: false })), events: state.events, prices: state.prices,
    }, null, 2),
    async replaceAll(data) {
      state = { ...emptyState(), settings: state.settings, assets: data.assets.map((a) => ({ ...a })), events: data.events.map((e) => ({ ...e })), prices: data.prices.map((p) => ({ ...p })) }
      await persist()
    },
    async clearAll() {
      state = emptyState()
      await store.delete(KEY)
      await store.delete(CORRUPT_KEY)
    },
    counts: () => ({ assets: state.assets.length, events: state.events.length }),
  }
}
