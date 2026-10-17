import { z } from 'zod'
import { cleanText, validateCustomAsset } from './customAsset'
import type { Currency, PortfolioEventType, PriceBasis } from './types'

/** What GET /portfolio/export returns, and what a backup file contains. */
export interface ExportAsset {
  id: string
  name: string
  symbol: string | null
  sourceUrl: string | null
  network: string | null
  contractAddress: string | null
  createdAt: string
  archivedAt: string | null
  linkedToRupChainToken?: boolean
  /** Account backups: a keyed hash that lets a restore find the RupChain token again (never the platform's own id). */
  linkedTokenRef?: string | null
}
export interface ExportEvent {
  id: string
  assetId: string
  type: PortfolioEventType
  occurredAt: string
  quantity: string
  consideration: string | null
  fee: string | null
  basis: string | null
  zeroCost: boolean
  quote: Currency
  fxRate: string | null
  fxSource: 'platform' | 'manual' | null
  note: string | null
  source: 'manual' | 'ctm'
  voided: boolean
  voidReason: string | null
  priceBasis?: PriceBasis | null
  /** Account backups only: when the entry was last corrected, and the RupChain trade it was recorded for. */
  editedAt?: string | null
  linkedTradeRef?: string | null
}
/** An earlier version of an entry that was corrected or removed (account backups only). */
interface ExportRevision {
  eventId: string
  assetId: string
  action: 'edit' | 'delete'
  before: Record<string, string | boolean | null>
  createdAt: string
}
export interface ExportPrice {
  assetId: string
  price: string
  quote: Currency
  observedAt: string
  /** Account backups: where the price came from ('manual', 'p2p', 'exchange', 'other'). */
  source?: 'manual' | 'p2p' | 'exchange' | 'other'
}
export interface ExportData {
  exportedAt: string
  assets: ExportAsset[]
  events: ExportEvent[]
  prices: ExportPrice[]
  /** Present in a full account backup: lets a restore bring back each entry's correction history. */
  revisions?: ExportRevision[]
  /** True when the account had more correction records than a backup file holds, so the oldest are missing. */
  revisionsTruncated?: boolean
}

/** What POST /portfolio/restore reports back. */
export interface RestoreSummary {
  assets: { created: number; alreadyThere: number }
  entries: { restored: number; alreadyThere: number; notRestored: number }
  prices: { restored: number; alreadyThere: number }
  history: { restored: number; alreadyThere: number; notRestored: number }
  notes: string[]
}

// ───────────────────────────── CSV ─────────────────────────────

const NUMERIC = /^-?\d+(\.\d+)?$/
// Characters that make a spreadsheet read a cell as a formula (OWASP CSV injection): = + - @ TAB CR.
const FORMULA_START = new Set(['=', '+', '-', '@', String.fromCharCode(9), String.fromCharCode(13)])

/**
 * One CSV cell. Text that could be read as a formula is prefixed with an apostrophe so a hostile
 * token name or note cannot run in Excel / Sheets; values that are plain numbers are left alone.
 */
export function csvCell(value: string | number | boolean | null | undefined, kind: 'text' | 'number' = 'text'): string {
  if (value === null || value === undefined) return ''
  let s = String(value)
  const isNumber = kind === 'number' && NUMERIC.test(s)
  if (!isNumber && s.length > 0 && FORMULA_START.has(s.charAt(0))) s = `'${s}`
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s
}

export const CSV_HEADER = [
  'token', 'symbol', 'network', 'contract', 'date_utc', 'type', 'quantity', 'currency', 'amount', 'fee', 'cost_basis',
  'zero_cost', 'usdt_pkr_rate', 'rate_source', 'source', 'counted', 'not_counted_reason', 'note', 'token_id', 'entry_id', 'price_used',
] as const

export function buildCsv(data: ExportData): string {
  const assets = new Map(data.assets.map((a) => [a.id, a]))
  const rows = data.events.map((e) => {
    const a = assets.get(e.assetId)
    return [
      csvCell(a?.name ?? ''), csvCell(a?.symbol), csvCell(a?.network), csvCell(a?.contractAddress),
      csvCell(e.occurredAt), csvCell(e.type), csvCell(e.quantity, 'number'), csvCell(e.quote),
      csvCell(e.consideration, 'number'), csvCell(e.fee, 'number'), csvCell(e.basis, 'number'),
      csvCell(e.zeroCost ? 'yes' : 'no'), csvCell(e.fxRate, 'number'), csvCell(e.fxSource),
      csvCell(e.source === 'ctm' ? 'RupChain trade' : 'manual'), csvCell(e.voided ? 'no' : 'yes'), csvCell(e.voidReason),
      csvCell(e.note), csvCell(e.assetId), csvCell(e.id), csvCell(e.priceBasis === 'platform' ? 'RupChain price' : e.priceBasis === 'own' ? 'own price' : ''),
    ].join(',')
  })
  // UTF-8 byte-order mark so Excel opens non-Latin token names correctly.
  return String.fromCharCode(0xfeff) + [CSV_HEADER.join(','), ...rows].join('\r\n') + '\r\n'
}

// ───────────────────────────── JSON backup ─────────────────────────────

export const BACKUP_FORMAT = 'rupchain-portfolio-backup'
export const BACKUP_VERSION = 1
/** A full account backup: version 1 plus each entry's edit time, trade link and correction history. */
const BACKUP_VERSION_FULL = 2

export function buildBackup(data: ExportData): string {
  const version = data.revisions ? BACKUP_VERSION_FULL : BACKUP_VERSION
  return JSON.stringify({ format: BACKUP_FORMAT, version, ...data }, null, 2)
}

const dec = z.string().regex(/^\d{1,28}(\.\d{1,18})?$/)
const iso = z.string().datetime({ offset: true })
const text = (max: number) => z.string().max(max)
const quote = z.enum(['PKR', 'USDT'])

const assetSchema = z.object({
  id: text(64), name: text(200), symbol: text(64).nullable(), sourceUrl: text(2048).nullable(), network: text(100).nullable(),
  contractAddress: text(200).nullable(), createdAt: iso, archivedAt: iso.nullable(), linkedToRupChainToken: z.boolean().optional(),
  linkedTokenRef: z.string().regex(/^[0-9a-f]{32}$/).nullable().optional(),
}).strict()

const eventSchema = z.object({
  id: text(64), assetId: text(64), type: z.enum(['BUY', 'SELL', 'OPENING']), occurredAt: iso, quantity: dec,
  consideration: dec.nullable(), fee: dec.nullable(), basis: dec.nullable(), zeroCost: z.boolean(), quote,
  fxRate: z.string().regex(/^\d{1,10}(\.\d{1,18})?$/).nullable(), fxSource: z.enum(['platform', 'manual']).nullable(),
  note: text(400).nullable(), source: z.enum(['manual', 'ctm']), voided: z.boolean(), voidReason: text(60).nullable(),
  priceBasis: z.enum(['platform', 'own']).nullable().optional(),
  editedAt: iso.nullable().optional(), linkedTradeRef: text(64).nullable().optional(),
}).strict()

const revisionSchema = z.object({
  eventId: text(40), assetId: text(64), action: z.enum(['edit', 'delete']), createdAt: iso,
  before: z.record(z.string().max(32), z.union([z.string().max(1000), z.boolean(), z.null()])),
}).strict()

const priceSchema = z.object({ assetId: text(64), price: dec, quote, observedAt: iso, source: z.enum(['manual', 'p2p', 'exchange', 'other']).optional() }).strict()

const backupSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.union([z.literal(BACKUP_VERSION), z.literal(BACKUP_VERSION_FULL)]),
  exportedAt: iso,
  assets: z.array(assetSchema).max(200),
  events: z.array(eventSchema).max(5000),
  prices: z.array(priceSchema).max(5000),
  revisions: z.array(revisionSchema).max(20000).optional(),
  revisionsTruncated: z.boolean().optional(),
}).strict()

export const MAX_BACKUP_BYTES = 16 * 1024 * 1024

export type ParsedBackup = { ok: true; data: ExportData } | { ok: false; error: string }

/**
 * Read a backup file safely: size-limited, strictly validated, and cross-checked so every entry
 * points at a token in the same file. Anything unexpected is rejected, never partly loaded.
 */
export function parseBackup(raw: string): ParsedBackup {
  if (raw.length > MAX_BACKUP_BYTES) return { ok: false, error: 'This file is too large to be a portfolio backup.' }
  let json: unknown
  try { json = JSON.parse(raw) } catch { return { ok: false, error: 'This file is not a valid backup.' } }
  const r = backupSchema.safeParse(json)
  if (!r.success) {
    const v = (json as { version?: unknown } | null)?.version
    if (typeof v === 'number' && v !== BACKUP_VERSION && v !== BACKUP_VERSION_FULL) return { ok: false, error: 'This backup was made by a different version and cannot be read.' }
    return { ok: false, error: 'This file is not a valid RupChain portfolio backup.' }
  }
  // A backup is untrusted input: its tokens and notes must pass the same checks as anything typed into
  // the forms (link scheme, no credentials, no hidden or direction-changing characters, sane lengths).
  for (const a of r.data.assets) {
    const v = validateCustomAsset({ name: a.name, symbol: a.symbol ?? undefined, sourceUrl: a.sourceUrl ?? undefined, network: a.network ?? undefined, contractAddress: a.contractAddress ?? undefined })
    if (!v.ok || v.value.name !== a.name) return { ok: false, error: 'This backup contains a token with invalid or unsafe details.' }
  }
  if (r.data.events.some((e) => e.note !== null && cleanText(e.note) !== e.note)) {
    return { ok: false, error: 'This backup contains an entry with hidden or unsafe characters in its note.' }
  }
  // A saved price is "the latest price" by its date, so a date in the future (or a price of zero) would stick forever.
  const earliest = Date.parse('2009-01-03T00:00:00Z'), latest = Date.now() + 5 * 60 * 1000
  if (r.data.prices.some((p) => { const t = Date.parse(p.observedAt); return t < earliest || t > latest || /^0+(\.0+)?$/.test(p.price) })) {
    return { ok: false, error: 'This backup contains a price with an impossible date or a price of zero.' }
  }
  const ids = new Set(r.data.assets.map((a) => a.id))
  if (ids.size !== r.data.assets.length) return { ok: false, error: 'This backup lists the same token twice.' }
  const eventIds = new Set(r.data.events.map((e) => e.id))
  if (eventIds.size !== r.data.events.length) return { ok: false, error: 'This backup lists the same entry twice.' }
  if (r.data.events.some((e) => !ids.has(e.assetId)) || r.data.prices.some((p) => !ids.has(p.assetId))) {
    return { ok: false, error: 'This backup refers to a token that is not in the file.' }
  }
  if (r.data.revisions?.some((v) => !ids.has(v.assetId))) {
    return { ok: false, error: 'This backup refers to a token that is not in the file.' }
  }
  return {
    ok: true,
    data: {
      exportedAt: r.data.exportedAt, assets: r.data.assets, events: r.data.events, prices: r.data.prices,
      ...(r.data.revisions ? { revisions: r.data.revisions } : {}),
      ...(r.data.revisionsTruncated ? { revisionsTruncated: true } : {}),
    },
  }
}

// ───────────────────────────── download ─────────────────────────────

export function downloadTextFile(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export const exportFileName = (ext: 'csv' | 'json', now = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `rupchain-portfolio-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.${ext}`
}
