'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type {
  Currency, EventRevision, PortfolioAsset, PortfolioEvent, PortfolioEventInput, PortfolioEventType, PortfolioPosition, PortfolioPriceView,
} from '@/lib/portfolio/types'
import { newlyOversold } from '@/lib/portfolio/oversold'
import { AMOUNT_RE, formatDecimal, formatQuantity, formatSigned, isZeroAmount } from '@/lib/portfolio/format'
import { parseSourceUrl, sourceHostname } from '@/lib/portfolio/customAsset'
import { VOID_TEXT } from '@/lib/portfolio/importText'
import { PRICE_SOURCE_CHOICES, priceAge, priceSourceLabel, type PriceSourceChoice } from '@/lib/portfolio/priceStatus'
import { Modal } from '@/components/ui/Modal'
import { AnchoredMenu } from '@/components/ui/AnchoredMenu'
import { averageCost, StaleClock } from './TokenCard'
import { EventForm } from './EventForm'
import { InfoTip } from './InfoTip'
import { ListingInterestBlock } from './ListingInterestBlock'
import { TokenMonogram } from './TokenMonogram'

export type StartWith = 'price' | 'buy' | 'sell' | 'opening' | 'history'

export interface TokenDetailProps {
  /** Open straight into this action (from a card or the attention list). */
  startWith?: StartWith
  asset: PortfolioAsset
  position?: PortfolioPosition
  price?: PortfolioPriceView
  /** Currency the portfolio is currently shown in. */
  currency: Currency
  /** Today's RupChain rate (PKR per 1 USDT), for the conversion shown while recording. */
  usdtPkr?: string | null
  /** True when some of this token's entries have no exchange rate for `currency` (their cost is unknown in it). */
  fxUnavailable?: boolean
  backRef: React.RefObject<HTMLButtonElement>
  onBack: () => void
  onEdit?: () => void
  loadEvents: (assetId: string) => Promise<PortfolioEvent[]>
  onRecordEvent: (assetId: string, input: PortfolioEventInput) => Promise<void>
  onDeleteEvent: (assetId: string, eventId: string) => Promise<void>
  /** Correct one of your own manual entries (signed-in and local trackers). */
  onUpdateEvent?: (assetId: string, eventId: string, input: PortfolioEventInput) => Promise<void>
  /** Earlier versions of an entry (signed-in only). */
  loadHistory?: (assetId: string, eventId: string) => Promise<EventRevision[]>
  onSetPrice: (assetId: string, price: string, quote: Currency, source?: string) => Promise<void>
  onArchive?: (assetId: string) => Promise<void>
  onUnarchive?: (assetId: string) => Promise<void>
  /** Only offered when the token has no records. */
  onDeleteAsset?: (assetId: string) => Promise<void>
  onSuggestListing?: (assetId: string) => Promise<void>
  onWithdrawListing?: (assetId: string) => Promise<void>
}

type Mode =
  | { name: 'view' }
  | { name: 'record'; type: PortfolioEventType }
  | { name: 'price' }
  | { name: 'edit'; eventId: string }
  | { name: 'archive' }
  | { name: 'delete' }

const TYPE_LABEL: Record<PortfolioEventType, string> = { BUY: 'Buy', SELL: 'Sell', OPENING: 'Previous holding' }

/** One line describing an earlier version of an entry. */
function describeBefore(b: EventRevision['before']): string {
  const kind = b.type ? TYPE_LABEL[b.type] : 'Entry'
  const parts = [`${kind} ${b.quantity ? formatQuantity(b.quantity) : ''}`.trim()]
  if (b.type === 'OPENING') parts.push(b.zeroCost ? 'zero cost' : b.basis ? `cost ${formatDecimal(b.basis)} ${b.quote ?? ''}`.trim() : 'cost not recorded')
  else if (b.consideration) parts.push(`${formatDecimal(b.consideration)} ${b.quote ?? ''}`.trim())
  if (b.fee && !isZeroAmount(b.fee)) parts.push(`fee ${formatDecimal(b.fee)}`)
  if (b.occurredAt) parts.push(new Date(b.occurredAt).toLocaleString())
  return parts.join(' · ')
}

function Tile({ label, value, tone, trailing }: { label: string; value: ReactNode; tone?: 'good' | 'bad'; trailing?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-2xl border border-border bg-surface px-3 py-2.5 shadow-card sm:px-4 sm:py-3">
      <dt className="flex items-center justify-between gap-1 text-[11px] text-text-muted sm:text-xs"><span className="truncate">{label}</span>{trailing}</dt>
      <dd className={`mt-1 break-words text-[15px] font-semibold tabular-nums sm:text-lg ${tone === 'bad' ? 'text-danger' : tone === 'good' ? 'text-success' : 'text-text-primary'}`}>{value}</dd>
    </div>
  )
}

function Detail({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div>
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="text-sm font-semibold break-words tabular-nums text-text-primary">{value}</dd>
      {note && <p className="text-xs text-text-muted">{note}</p>}
    </div>
  )
}

function SourceLink({ href }: { href: string }) {
  // Re-validated at render so a bad stored value can never become a javascript: link.
  const r = parseSourceUrl(href)
  if (!r.ok) return null
  return (
    <p className="text-sm">
      <span className="text-text-muted">Source </span>
      <a href={r.href} target="_blank" rel="noopener noreferrer nofollow" className="text-primary hover:underline break-all">{sourceHostname(r.href)}</a>
      <span className="block text-xs text-text-muted">A link does not verify the token.</span>
    </p>
  )
}

function PriceForm({ assetName, defaultCurrency, onSubmit, onCancel }: { assetName: string; defaultCurrency: Currency; onSubmit: (p: string, q: Currency, source: PriceSourceChoice) => Promise<void>; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [quote, setQuote] = useState<Currency>(defaultCurrency)
  const [source, setSource] = useState<PriceSourceChoice>('manual')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { ref.current?.focus() }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    const v = value.trim()
    if (!AMOUNT_RE.test(v) || isZeroAmount(v)) { setError('Enter a price greater than zero, for example 1200.'); return }
    setError(null)
    setBusy(true)
    try { await onSubmit(v, quote, source) } catch (err) { setError(err instanceof Error ? err.message : 'Could not save this price.') } finally { setBusy(false) }
  }

  const field = 'w-full rounded-lg border border-border bg-surface text-text-primary text-base px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-primary/30'
  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label={`Update the current price of ${assetName}`}>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="portfolio-price" className="text-sm font-medium text-text-primary">
            Price per unit ({quote})
            <InfoTip text="A price you type in is a note for your own valuation, with today's time. It is not a market quote and is not a transaction." />
          </label>
          <div role="radiogroup" aria-label="Price currency" className="inline-flex flex-shrink-0 overflow-hidden rounded-lg border border-border">
            {(['PKR', 'USDT'] as const).map((c) => (
              <button
                key={c} type="button" role="radio" aria-checked={quote === c} onClick={() => setQuote(c)}
                className={`px-3 py-1 text-xs font-semibold ${quote === c ? 'bg-primary text-white' : 'bg-surface text-text-secondary hover:bg-surface-hover'}`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
        <input
          ref={ref} id="portfolio-price" type="text" inputMode="decimal" autoComplete="off" value={value}
          onChange={(e) => setValue(e.target.value)} aria-invalid={error ? true : undefined} aria-describedby={error ? 'portfolio-price-error' : undefined}
          className={field}
        />
        {error && <p id="portfolio-price-error" role="alert" className="text-sm text-danger">{error}</p>}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="portfolio-price-source" className="text-sm font-medium text-text-primary">Source, optional</label>
        <select id="portfolio-price-source" value={source} onChange={(e) => setSource(e.target.value as PriceSourceChoice)} className={field}>
          {PRICE_SOURCE_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </div>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm font-semibold rounded-lg border border-border text-text-secondary hover:bg-surface-hover">Cancel</button>
        <button type="submit" disabled={busy} className="px-4 py-2 text-sm font-semibold rounded-lg bg-primary text-white disabled:opacity-60">{busy ? 'Saving…' : 'Save price'}</button>
      </div>
    </form>
  )
}

/** Newest entry first for display. The list itself stays oldest-first because the oversold checks depend on that order. */
function newestFirst(events: PortfolioEvent[]): PortfolioEvent[] {
  return [...events].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || (a.id < b.id ? -1 : 1))
}

interface Issue { key: string; text: string; action?: { label: string; run: () => void } }

export function TokenDetail(p: TokenDetailProps) {
  const { asset, position, price, currency } = p
  const [events, setEvents] = useState<PortfolioEvent[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>(() => {
    switch (p.startWith) {
      case 'price': return { name: 'price' }
      case 'buy': return { name: 'record', type: 'BUY' }
      case 'sell': return { name: 'record', type: 'SELL' }
      case 'opening': return { name: 'record', type: 'OPENING' }
      default: return { name: 'view' }
    }
  })
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState<string | null>(null)
  const [revisions, setRevisions] = useState<EventRevision[] | null>(null)
  const [revisionError, setRevisionError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [assetError, setAssetError] = useState<string | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const archived = Boolean(asset.archivedAt)
  const rootRef = useRef<HTMLDivElement>(null)

  const reload = useCallback(async () => {
    setLoadError(null)
    try { setEvents(await p.loadEvents(asset.id)) } catch (e) { setLoadError(e instanceof Error ? e.message : 'Could not load your entries.') }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.id])
  useEffect(() => { void reload() }, [reload])
  useEffect(() => {
    if (p.startWith === 'history') rootRef.current?.querySelector('#history-heading')?.scrollIntoView?.({ block: 'start' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const closeModal = () => setMode({ name: 'view' })
  const hasRecords = events !== null && events.length > 0
  // A previous holding must sit BEFORE the earliest record to fill the gap it is meant to fill.
  const beforeFirst = useMemo(() => {
    if (!events || events.length === 0) return undefined
    const first = Math.min(...events.map((e) => Date.parse(e.occurredAt)).filter((t) => !Number.isNaN(t)))
    return Number.isFinite(first) ? new Date(first - 60_000) : undefined
  }, [events])

  // What needs the user's attention, each with the exact step that fixes it.
  const age = price && price.price !== null ? priceAge(price.observedAt) : null
  const issues: Issue[] = []
  if (position) {
    if (!archived && !price) issues.push({ key: 'price', text: 'No current price, so the value is unknown.', action: { label: 'Add price', run: () => setMode({ name: 'price' }) } })
    else if (!archived && price && price.price === null) issues.push({ key: 'price-fx', text: `The price was entered in ${price.quote} and no USDT/PKR rate is available to convert it.` })
    else if (!archived && age?.stale) issues.push({ key: 'stale', text: `The price was recorded ${age.label} and may be out of date.`, action: { label: 'Update price', run: () => setMode({ name: 'price' }) } })
    if (position.unresolvedSales.length > 0) {
      issues.push({
        key: 'oversold',
        text: `You sold more than your history shows (${position.unresolvedSales.map((u) => formatQuantity(u.quantity)).join(', ')} units), so no profit is counted for the excess.`,
        action: archived ? undefined : { label: 'Add previous holdings', run: () => setMode({ name: 'record', type: 'OPENING' }) },
      })
    } else if (!position.basisComplete || !position.realizedComplete) {
      issues.push({
        key: 'cost',
        text: p.fxUnavailable
          ? `Some entries have no recorded USDT/PKR rate, so their cost is unknown in ${currency}. Switch the currency to see their profit.`
          : 'Some units have no recorded cost, so profit is not complete.',
        action: archived || p.fxUnavailable ? undefined : { label: 'Fix history', run: () => rootRef.current?.querySelector('#history-heading')?.scrollIntoView?.({ block: 'start' }) },
      })
    }
  }

  const archive = async () => {
    setAssetError(null); setBusy(true)
    try { await p.onArchive!(asset.id); closeModal(); p.onBack() } catch (e) { setAssetError(e instanceof Error ? e.message : 'Could not archive this token.'); closeModal() } finally { setBusy(false) }
  }
  const unarchive = async () => {
    setAssetError(null)
    try { await p.onUnarchive!(asset.id) } catch (e) { setAssetError(e instanceof Error ? e.message : 'Could not restore this token.') }
  }
  const deleteAsset = async () => {
    setAssetError(null); setBusy(true)
    try { await p.onDeleteAsset!(asset.id); closeModal(); p.onBack() } catch (e) { setAssetError(e instanceof Error ? e.message : 'Could not delete this token.'); closeModal() } finally { setBusy(false) }
  }

  const menuItems: Array<{ key: string; label: string; danger?: boolean; run: () => void }> = []
  menuItems.push({ key: 'details', label: 'View details', run: () => setInfoOpen(true) })
  if (!archived) menuItems.push({ key: 'previous', label: 'Add previous holdings', run: () => setMode({ name: 'record', type: 'OPENING' }) })
  if (p.onEdit) menuItems.push({ key: 'edit', label: 'Edit details', run: () => p.onEdit!() })
  if (!archived && p.onArchive) menuItems.push({ key: 'archive', label: 'Archive asset', run: () => setMode({ name: 'archive' }) })
  if (archived && p.onUnarchive) menuItems.push({ key: 'restore', label: 'Restore asset', run: () => void unarchive() })
  if (events !== null && events.length === 0 && p.onDeleteAsset) menuItems.push({ key: 'delete', label: 'Delete token', danger: true, run: () => setMode({ name: 'delete' }) })

  const editTarget = mode.name === 'edit' ? events?.find((e) => e.id === mode.eventId) : undefined
  const sourceOk = asset.sourceUrl ? parseSourceUrl(asset.sourceUrl).ok : false

  return (
    <div ref={rootRef} className="space-y-4">
      <button ref={p.backRef} type="button" onClick={p.onBack} className="text-sm font-medium text-primary hover:underline">← Back to portfolio</button>

      <div className="flex items-center gap-3">
        <TokenMonogram name={asset.name} size="lg" logoUrl={asset.logoUrl} />
        <div className="min-w-0 flex-1">
          <h2 id="tracked-portfolio-heading" className="text-lg font-bold text-text-primary break-words leading-tight">{asset.name}</h2>
          <p className="text-xs text-text-muted break-words">{[asset.symbol, asset.network].filter(Boolean).join(' · ') || 'Tracked manually'}{archived ? ' · Archived' : ''}</p>
        </div>
        <button
          type="button" aria-label="Token information" aria-expanded={infoOpen} onClick={() => setInfoOpen((v) => !v)}
          className={`inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border text-sm font-semibold ${infoOpen ? 'border-primary text-primary' : 'border-border text-text-secondary hover:bg-surface-hover'}`}
        >
          i
        </button>
        {menuItems.length > 0 && (
          <>
            <button
              ref={menuBtnRef} type="button" aria-label="More actions" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}
              className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-border text-text-secondary hover:bg-surface-hover"
            >
              <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor"><circle cx="8" cy="3" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle cx="8" cy="13" r="1.4" /></svg>
            </button>
            <AnchoredMenu anchorRef={menuBtnRef} open={menuOpen} onClose={() => setMenuOpen(false)} width={208} align="end">
              <div role="menu" className="rounded-xl border border-border bg-surface py-1 shadow-xl">
                {menuItems.map((m) => (
                  <button
                    key={m.key} type="button" role="menuitem"
                    onClick={() => { setMenuOpen(false); m.run() }}
                    className={`block w-full px-4 py-2 text-left text-sm hover:bg-surface-hover ${m.danger ? 'text-danger' : 'text-text-primary'}`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </AnchoredMenu>
          </>
        )}
      </div>

      {infoOpen && (
        <section aria-label="Token information" className="space-y-2 rounded-2xl border border-border bg-surface px-4 py-3 text-sm">
          <dl className="space-y-1">
            {asset.symbol && <div className="flex gap-2"><dt className="text-text-muted">Symbol</dt><dd className="break-words text-text-primary">{asset.symbol}</dd></div>}
            {asset.network && <div className="flex gap-2"><dt className="text-text-muted">Network</dt><dd className="break-words text-text-primary">{asset.network}</dd></div>}
            {asset.contractAddress && <div className="flex gap-2"><dt className="text-text-muted">Contract</dt><dd className="break-all font-mono text-xs text-text-primary">{asset.contractAddress}</dd></div>}
          </dl>
          {asset.sourceUrl && sourceOk && <SourceLink href={asset.sourceUrl} />}
          {!asset.network && !asset.contractAddress && !sourceOk && !asset.catalogSlug && <p className="text-xs text-text-muted">Tracked manually. No network or contract recorded.</p>}
          {asset.catalogSlug && (
            <a href={`/ctm/tokens/${encodeURIComponent(asset.catalogSlug)}`} className="inline-block font-medium text-primary hover:underline">View on RupChain →</a>
          )}
        </section>
      )}

      {assetError && <p role="alert" className="text-sm text-danger">{assetError}</p>}

      {position ? (
        <>
          <dl className="grid grid-cols-3 gap-2 sm:gap-3" aria-label="Position">
            <Tile
              label={`Value (${currency})`}
              value={position.value === null ? <span className="font-medium text-text-muted">No price</span> : formatDecimal(position.value)}
              trailing={age?.stale ? <StaleClock label={age.label} /> : undefined}
            />
            <Tile label="Quantity" value={formatQuantity(position.quantity)} />
            <Tile
              label={`Profit / loss (${currency})`}
              value={position.unrealized === null ? <span className="font-medium text-text-muted">Not known</span> : formatSigned(position.unrealized)}
              tone={position.unrealized === null ? undefined : /^-/.test(position.unrealized) && /[1-9]/.test(position.unrealized) ? 'bad' : 'good'}
            />
          </dl>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            {issues.length > 0 && (
              <button
                type="button" aria-expanded={reviewOpen} onClick={() => setReviewOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 font-semibold text-amber-700 dark:text-amber-400"
              >
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                Needs review{issues.length > 1 ? ` · ${issues.length}` : ''}
              </button>
            )}
          </div>
          {reviewOpen && issues.length > 0 && (
            <ul className="space-y-2 rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
              {issues.map((i) => (
                <li key={i.key} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm text-text-secondary">
                  <span className="min-w-0 flex-1">{i.text}</span>
                  {i.action && <button type="button" onClick={() => { setReviewOpen(false); i.action!.run() }} className="flex-shrink-0 font-semibold text-primary hover:underline">{i.action.label}</button>}
                </li>
              ))}
            </ul>
          )}
          <details className="group rounded-2xl border border-border bg-surface px-4 py-2.5">
            <summary className="cursor-pointer select-none text-xs font-medium text-primary">Accounting details</summary>
            <dl className="mt-3 grid grid-cols-2 gap-4">
              <Detail
                label="Average cost"
                value={(() => { const avg = averageCost(position); return avg === null ? 'Not known yet' : `${currency} ${avg}` })()}
                note={position.basisComplete ? undefined : 'Some units have no recorded cost'}
              />
              <Detail label={`Remaining cost (${currency})`} value={position.basisComplete ? formatDecimal(position.knownRemainingBasis) : 'Not known yet'} note={position.basisComplete ? 'FIFO' : undefined} />
              <Detail
                label={`Current price (${currency})`}
                value={price && price.price !== null ? formatDecimal(price.price, 8).replace(/\.?0+$/, '') : 'No price'}
                note={
                  price
                    ? price.price === null
                      ? `Entered in ${price.quote}; no USDT/PKR rate is available to convert it`
                      : `${priceSourceLabel(price.source)}, ${new Date(price.observedAt).toLocaleString()}${price.quote !== currency ? `, as ${formatDecimal(price.original, 8).replace(/\.?0+$/, '')} ${price.quote}` : ''}`
                    : 'Add one to see value and profit/loss'
                }
              />
              <Detail
                label="Profit from sales"
                value={!position.realizedComplete && /^-?0+(\.0+)?$/.test(position.realizedKnown) ? 'Not known yet' : `${currency} ${formatSigned(position.realizedKnown)}`}
                note={position.realizedComplete ? undefined : 'Leaves out sales whose cost is not recorded'}
              />
            </dl>
          </details>
        </>
      ) : (
        <p className="rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-text-muted">No entries yet. Record a transaction to see quantity and profit/loss.</p>
      )}

      {archived ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface px-4 py-2.5 text-sm text-text-secondary">
          <span>Archived. Its history still counts in your totals.</span>
          {p.onUnarchive && <button type="button" className="font-semibold text-primary hover:underline" onClick={() => void unarchive()}>Restore</button>}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" data-trigger="record" onClick={() => setMode({ name: 'record', type: 'BUY' })} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90">Record Transaction</button>
          <button type="button" data-trigger="price" onClick={() => setMode({ name: 'price' })} className="rounded-lg border border-border px-3 py-2 text-sm font-semibold text-text-primary hover:bg-surface-hover">Update price</button>
        </div>
      )}

      <Modal
        isOpen={mode.name === 'record'} onClose={closeModal} size="md"
        title={mode.name === 'record' && mode.type === 'OPENING' ? 'Add previous holdings' : 'Record transaction'}
      >
        {mode.name === 'record' && (
          <EventForm
            // Remount when the type this opens with changes (previous holdings vs a normal entry).
            key={mode.type}
            assetName={asset.name}
            defaultType={mode.type}
            defaultCurrency={currency}
            usdtPkr={p.usdtPkr}
            defaultWhen={mode.type === 'OPENING' ? beforeFirst : undefined}
            platformPrices={price && price.source === 'platform'
              ? { [price.quote]: price.original, ...(price.price !== null ? { [currency]: price.price } : {}) }
              : null}
            onCancel={closeModal}
            onSubmit={async (input) => { await p.onRecordEvent(asset.id, input); await reload(); closeModal() }}
          />
        )}
      </Modal>

      <Modal isOpen={mode.name === 'edit' && Boolean(editTarget) && Boolean(p.onUpdateEvent)} onClose={closeModal} size="md" title="Edit entry">
        {editTarget && p.onUpdateEvent && (
          <EventForm
            assetName={asset.name}
            initial={editTarget}
            defaultCurrency={currency}
            usdtPkr={p.usdtPkr}
            onCancel={closeModal}
            warn={(input) => {
              const extra = newlyOversold(events ?? [], { replace: { id: editTarget.id, type: input.type, occurredAt: input.occurredAt, quantity: input.quantity } })
              return extra === '0' ? null : `After this change, ${formatQuantity(extra)} units would be sold beyond what your history shows, so no profit would be counted for them. Save anyway?`
            }}
            onSubmit={async (input) => { await p.onUpdateEvent!(asset.id, editTarget.id, input); setHistoryOpen(null); await reload(); closeModal() }}
          />
        )}
      </Modal>

      <Modal isOpen={mode.name === 'price'} onClose={closeModal} size="sm" title="Update price">
        {mode.name === 'price' && (
          <PriceForm assetName={asset.name} defaultCurrency={currency} onCancel={closeModal} onSubmit={async (v, q, src) => { await p.onSetPrice(asset.id, v, q, src); closeModal() }} />
        )}
      </Modal>

      <Modal isOpen={mode.name === 'archive'} onClose={closeModal} size="sm" title="Archive this asset?">
        <div className="space-y-4 text-sm text-text-secondary">
          {position && /[1-9]/.test(position.quantity)
            ? <p>You still hold {formatQuantity(position.quantity)} {asset.symbol ?? 'units'}. Archiving only hides this token from your list; those units, your history and your profit still count in the totals.</p>
            : <p>This hides the token from your list. Your history and profit still count in the totals.</p>}
          <p>You can restore it at any time. Nothing is deleted.</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={closeModal} className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-text-secondary hover:bg-surface-hover">Keep</button>
            <button type="button" disabled={busy} onClick={() => void archive()} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">{busy ? 'Archiving…' : 'Archive asset'}</button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={mode.name === 'delete'} onClose={closeModal} size="sm" title="Delete this token?">
        <div className="space-y-4 text-sm text-text-secondary">
          <p>This token has no records, so deleting it loses nothing. A token with records can only be archived.</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={closeModal} className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-text-secondary hover:bg-surface-hover">Keep token</button>
            <button type="button" disabled={busy} onClick={() => void deleteAsset()} className="rounded-lg bg-danger px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">{busy ? 'Deleting…' : 'Confirm delete'}</button>
          </div>
        </div>
      </Modal>

      <ListingInterestBlock asset={asset} onSuggest={p.onSuggestListing} onWithdraw={p.onWithdrawListing} />

      <section aria-labelledby="history-heading">
        <h3 id="history-heading" className="text-sm font-semibold text-text-primary mb-2">History</h3>
        {actionError && <p role="alert" className="text-sm text-danger mb-2">{actionError}</p>}
        {loadError ? (
          <p role="alert" className="text-sm text-danger">{loadError} <button type="button" onClick={() => void reload()} className="font-medium text-primary hover:underline">Try again</button></p>
        ) : events === null ? (
          <p role="status" className="text-sm text-text-muted">Loading your entries…</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-text-muted">No entries yet.</p>
        ) : (
          <div className="bg-surface shadow-card rounded-xl border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Entries you recorded for {asset.name}</caption>
              <thead>
                <tr className="text-left text-xs text-text-muted border-b border-border">
                  <th scope="col" className="px-3 py-2 font-medium">Date</th>
                  <th scope="col" className="px-3 py-2 font-medium">Type</th>
                  <th scope="col" className="px-3 py-2 font-medium text-right">Quantity</th>
                  <th scope="col" className="px-3 py-2 font-medium text-right">Amount</th>
                  <th scope="col" className="px-3 py-2 font-medium text-right">Fee</th>
                  <th scope="col" className="px-3 py-2 font-medium">Note</th>
                  <th scope="col" className="px-3 py-2 font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {newestFirst(events).map((ev) => (
                  <Fragment key={ev.id}>
                  <tr>
                    <td className="px-3 py-2 whitespace-nowrap">{new Date(ev.occurredAt).toLocaleString()}</td>
                    <td className={`px-3 py-2 whitespace-nowrap ${ev.voided ? 'text-text-muted line-through' : ''}`}>
                      {TYPE_LABEL[ev.type]} <span className="text-xs text-text-muted no-underline">· {ev.source === 'ctm' ? 'RupChain trade' : 'manual'}{ev.editedAt ? ', edited' : ''}{ev.priceBasis ? `, ${ev.priceBasis === 'platform' ? 'RupChain price' : 'own price'}` : ''}</span>
                      {ev.voided && (
                        <span className="block text-xs text-amber-800 no-underline" style={{ textDecoration: 'none' }}>
                          Not counted: {VOID_TEXT[ev.voidReason ?? ''] ?? 'it no longer qualifies'}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">{formatQuantity(ev.quantity)}</td>
                    <td className="px-3 py-2 text-right">
                      {ev.type === 'OPENING'
                        ? (ev.zeroCost ? '0 (zero cost)' : ev.basis !== null ? `${formatDecimal(ev.basis)} ${ev.quote}` : 'Cost not recorded')
                        : `${formatDecimal(ev.consideration ?? '0')} ${ev.quote}`}
                      {ev.fxRate !== null && ev.type !== 'OPENING' && (
                        <span className="block text-xs text-text-muted">
                          @ {formatDecimal(ev.fxRate)} PKR/USDT{ev.fxSource === 'manual' ? ' (entered by you)' : ''}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">{ev.fee && !isZeroAmount(ev.fee) ? `${formatDecimal(ev.fee)} ${ev.quote}` : '—'}</td>
                    <td className="px-3 py-2 break-words max-w-[12rem]">{ev.note ?? ''}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-right">
                      {ev.source !== 'manual' ? (
                        <span className="text-xs text-text-muted">Read-only</span>
                      ) : confirmDelete === ev.id ? (
                        <span className="inline-flex flex-col items-end gap-1">
                          {(() => {
                            const extra = newlyOversold(events, { remove: ev.id })
                            return extra === '0' ? null : (
                              <span role="alert" className="block max-w-[16rem] whitespace-normal text-left text-xs text-amber-800">
                                Removing this leaves {formatQuantity(extra)} units sold beyond what your history shows, so no profit would be counted for them.
                              </span>
                            )
                          })()}
                          <span className="inline-flex gap-2">
                            <button
                              type="button" className="text-danger font-medium hover:underline"
                              onClick={async () => {
                                setActionError(null)
                                try { await p.onDeleteEvent(asset.id, ev.id); setConfirmDelete(null); setHistoryOpen(null); await reload() }
                                catch (e) { setConfirmDelete(null); setActionError(e instanceof Error ? e.message : 'Could not remove this entry.') }
                              }}
                            >
                              Confirm remove
                            </button>
                            <button type="button" className="text-text-muted hover:underline" onClick={() => setConfirmDelete(null)}>Keep</button>
                          </span>
                        </span>
                      ) : (
                        <span className="inline-flex gap-3">
                          {p.onUpdateEvent && !archived && (
                            <button
                              type="button" className="text-primary font-medium hover:underline"
                              onClick={() => setMode({ name: 'edit', eventId: ev.id })}
                              aria-label={`Edit ${TYPE_LABEL[ev.type]} entry from ${new Date(ev.occurredAt).toLocaleDateString()}`}
                            >
                              Edit
                            </button>
                          )}
                          {p.loadHistory && ev.editedAt && (
                            <button
                              type="button" className="text-text-muted hover:underline" aria-expanded={historyOpen === ev.id}
                              onClick={async () => {
                                if (historyOpen === ev.id) { setHistoryOpen(null); return }
                                setHistoryOpen(ev.id); setRevisions(null); setRevisionError(null)
                                try { setRevisions(await p.loadHistory!(asset.id, ev.id)) }
                                catch (e) { setRevisionError(e instanceof Error ? e.message : 'Could not load the history.') }
                              }}
                            >
                              History
                            </button>
                          )}
                          <button type="button" className="text-text-muted hover:text-danger hover:underline" onClick={() => setConfirmDelete(ev.id)} aria-label={`Remove ${TYPE_LABEL[ev.type]} entry from ${new Date(ev.occurredAt).toLocaleDateString()}`}>
                            Remove
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                  {historyOpen === ev.id && (
                    <tr>
                      <td colSpan={7} className="px-3 py-2 bg-surface-hover/40">
                        <p className="text-xs font-semibold text-text-primary mb-1">Earlier versions of this entry</p>
                        {revisionError ? (
                          <p role="alert" className="text-xs text-danger">{revisionError}</p>
                        ) : revisions === null ? (
                          <p role="status" className="text-xs text-text-muted">Loading…</p>
                        ) : revisions.length === 0 ? (
                          <p className="text-xs text-text-muted">No earlier versions.</p>
                        ) : (
                          <ul className="space-y-1">
                            {revisions.map((r) => (
                              <li key={r.id} className="text-xs text-text-secondary">
                                <span className="text-text-muted">{new Date(r.changedAt).toLocaleString()}, {r.action === 'delete' ? 'removed' : 'corrected'}: </span>
                                {describeBefore(r.before)}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {hasRecords && <p className="sr-only">A token with records can be archived but not deleted, so your history is never lost.</p>}
      </section>
    </div>
  )
}
