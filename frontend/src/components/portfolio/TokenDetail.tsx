'use client'

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type {
  Currency, PortfolioAsset, PortfolioEvent, PortfolioEventInput, PortfolioEventType, PortfolioPosition, PortfolioPriceView,
} from '@/lib/portfolio/types'
import { AMOUNT_RE, formatDecimal, formatQuantity, formatSigned, isZeroAmount } from '@/lib/portfolio/format'
import { parseSourceUrl, sourceHostname } from '@/lib/portfolio/customAsset'
import { VOID_TEXT } from '@/lib/portfolio/importText'
import { EventForm } from './EventForm'
import { ListingInterestBlock } from './ListingInterestBlock'
import { TokenMonogram } from './TokenMonogram'

export interface TokenDetailProps {
  asset: PortfolioAsset
  position?: PortfolioPosition
  price?: PortfolioPriceView
  /** Currency the portfolio is currently shown in. */
  currency: Currency
  /** True when this token's entries cannot be shown in `currency` (a record has no exchange rate). */
  fxUnavailable?: boolean
  backRef: React.RefObject<HTMLButtonElement>
  onBack: () => void
  onEdit?: () => void
  loadEvents: (assetId: string) => Promise<PortfolioEvent[]>
  onRecordEvent: (assetId: string, input: PortfolioEventInput) => Promise<void>
  onDeleteEvent: (assetId: string, eventId: string) => Promise<void>
  onSetPrice: (assetId: string, price: string, quote: Currency) => Promise<void>
  onArchive?: (assetId: string) => Promise<void>
  onUnarchive?: (assetId: string) => Promise<void>
  /** Only offered when the token has no records. */
  onDeleteAsset?: (assetId: string) => Promise<void>
  onSuggestListing?: (assetId: string) => Promise<void>
  onWithdrawListing?: (assetId: string) => Promise<void>
}

type Mode = { name: 'view' } | { name: 'record'; type: PortfolioEventType } | { name: 'price' }

const TYPE_LABEL: Record<PortfolioEventType, string> = { BUY: 'Buy', SELL: 'Sell', OPENING: 'Opening holding' }

function Stat({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div>
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="text-sm font-semibold text-text-primary break-words">{value}</dd>
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

function PriceForm({ assetName, defaultCurrency, onSubmit, onCancel }: { assetName: string; defaultCurrency: Currency; onSubmit: (p: string, q: Currency) => Promise<void>; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [quote, setQuote] = useState<Currency>(defaultCurrency)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { ref.current?.focus() }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    const v = value.trim()
    if (!AMOUNT_RE.test(v) || isZeroAmount(v)) { setError('Enter a price greater than zero, for example 1200.'); return }
    setError(null)
    setBusy(true)
    try { await onSubmit(v, quote) } catch (err) { setError(err instanceof Error ? err.message : 'Could not save this price.') } finally { setBusy(false) }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-3" aria-label={`Update the current price of ${assetName}`}>
      <p className="text-xs text-text-muted">A price you type in is a note for your own valuation, with today&apos;s time. It is not a market quote and is not a transaction.</p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="portfolio-price-quote" className="text-sm font-medium text-text-primary">Price currency</label>
        <select
          id="portfolio-price-quote" value={quote} onChange={(e) => setQuote(e.target.value as Currency)}
          className="w-full rounded-lg border border-border bg-surface text-text-primary text-base px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-primary/30"
        >
          <option value="PKR">PKR</option>
          <option value="USDT">USDT</option>
        </select>
        <label htmlFor="portfolio-price" className="text-sm font-medium text-text-primary">Current price per unit ({quote})</label>
        <input
          ref={ref} id="portfolio-price" type="text" inputMode="decimal" autoComplete="off" value={value}
          onChange={(e) => setValue(e.target.value)} aria-invalid={error ? true : undefined} aria-describedby={error ? 'portfolio-price-error' : undefined}
          className="w-full rounded-lg border border-border bg-surface text-text-primary text-base px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        {error && <p id="portfolio-price-error" role="alert" className="text-sm text-danger">{error}</p>}
      </div>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm font-semibold rounded-lg border border-border text-text-secondary hover:bg-surface-hover">Cancel</button>
        <button type="submit" disabled={busy} className="px-4 py-2 text-sm font-semibold rounded-lg bg-primary text-white disabled:opacity-60">{busy ? 'Saving…' : 'Save price'}</button>
      </div>
    </form>
  )
}

export function TokenDetail(p: TokenDetailProps) {
  const { asset, position, price, currency } = p
  const [events, setEvents] = useState<PortfolioEvent[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>({ name: 'view' })
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmAssetDelete, setConfirmAssetDelete] = useState(false)
  const [assetError, setAssetError] = useState<string | null>(null)
  const archived = Boolean(asset.archivedAt)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerKey = useRef<string>('')

  const reload = useCallback(async () => {
    setLoadError(null)
    try { setEvents(await p.loadEvents(asset.id)) } catch (e) { setLoadError(e instanceof Error ? e.message : 'Could not load your entries.') }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.id])
  useEffect(() => { void reload() }, [reload])

  // The action buttons unmount while a form is open, so focus is restored to the re-rendered twin by key.
  const closeForm = () => {
    setMode({ name: 'view' })
    setTimeout(() => rootRef.current?.querySelector<HTMLElement>(`[data-trigger="${triggerKey.current}"]`)?.focus(), 0)
  }
  const open = (key: string, m: Mode) => () => { triggerKey.current = key; setMode(m) }

  return (
    <div ref={rootRef} className="space-y-4">
      <button ref={p.backRef} type="button" onClick={p.onBack} className="text-sm font-medium text-primary hover:underline">← Back to portfolio</button>

      <div className="flex items-center gap-3">
        <TokenMonogram name={asset.name} size="lg" logoUrl={asset.logoUrl} />
        <h2 id="tracked-portfolio-heading" className="text-base font-semibold text-text-primary break-words min-w-0">{asset.name}</h2>
      </div>

      <div className="bg-surface shadow-card rounded-xl border border-border p-5 space-y-3">
        <dl className="text-sm space-y-1">
          {asset.symbol && <div className="flex gap-2"><dt className="text-text-muted">Symbol</dt><dd className="text-text-primary break-words">{asset.symbol}</dd></div>}
          {asset.network && <div className="flex gap-2"><dt className="text-text-muted">Network</dt><dd className="text-text-primary break-words">{asset.network}</dd></div>}
          {asset.contractAddress && <div className="flex gap-2"><dt className="text-text-muted">Contract</dt><dd className="text-text-primary break-all font-mono text-xs">{asset.contractAddress}</dd></div>}
        </dl>
        {asset.sourceUrl && <SourceLink href={asset.sourceUrl} />}
        {!asset.network && !asset.contractAddress && <p className="text-xs text-text-muted">Tracked manually. No network or contract recorded.</p>}
        {p.onEdit && <button type="button" onClick={p.onEdit} className="text-sm font-medium text-primary hover:underline">Edit details</button>}
      </div>

      <section aria-label="Position" className="bg-surface shadow-card rounded-xl border border-border p-5">
        {position ? (
          <dl className="grid grid-cols-2 gap-4">
            <Stat label="Recorded quantity" value={formatQuantity(position.quantity)} note="Based on your recorded history" />
            <Stat
              label={`Remaining cost (${currency})`}
              value={position.basisComplete ? formatDecimal(position.knownRemainingBasis) : 'Unknown'}
              note={position.basisComplete ? 'FIFO' : 'Some units have no recorded cost'}
            />
            <Stat
              label={`Current price (${currency})`}
              value={price && price.price !== null ? formatDecimal(price.price, 8).replace(/\.?0+$/, '') : 'No price'}
              note={
                price
                  ? price.price === null
                    ? `Entered in ${price.quote}; no USDT/PKR rate is available to convert it`
                    : `Entered ${new Date(price.observedAt).toLocaleString()}${price.quote !== currency ? ` as ${formatDecimal(price.original, 8).replace(/\.?0+$/, '')} ${price.quote}` : ''}`
                  : 'Enter one to see value and unrealized profit/loss'
              }
            />
            <Stat label={`Marked value (${currency})`} value={position.value === null ? 'Unavailable' : formatDecimal(position.value)} note="Not a promise you could sell at this price" />
            <Stat label="Unrealized profit / loss" value={position.unrealized === null ? 'Unavailable' : `${currency} ${formatSigned(position.unrealized)}`} />
            <Stat label="Realized profit / loss" value={`${currency} ${formatSigned(position.realizedKnown)}`} note={position.realizedComplete ? undefined : 'Excludes sales from units with unknown cost'} />
          </dl>
        ) : p.fxUnavailable ? (
          <p role="alert" className="text-sm text-amber-800">
            Some entries for this token have no USDT/PKR rate recorded, so they cannot be shown in {currency}. Remove and re-add them with the rate for their date, or switch the currency above.
          </p>
        ) : (
          <p className="text-sm text-text-muted">No entries yet. Record a buy or an opening holding to see quantity and profit/loss.</p>
        )}
        {position && position.unresolvedSales.length > 0 && (
          <p role="alert" className="mt-3 text-xs text-amber-800 bg-amber-500/10 border border-amber-500/40 rounded-lg px-3 py-2">
            You recorded selling more than your history shows ({position.unresolvedSales.map((u) => formatQuantity(u.quantity)).join(', ')} units). No profit is counted for the excess. Add an opening holding to complete the history.
          </p>
        )}
      </section>

      {archived && (
        <div role="status" className="rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-secondary space-y-2">
          <p>This token is archived. Its history and realized profit/loss still count in your totals. Restore it to add new records.</p>
          {p.onUnarchive && (
            <button
              type="button" className="font-medium text-primary hover:underline"
              onClick={async () => { setAssetError(null); try { await p.onUnarchive!(asset.id) } catch (e) { setAssetError(e instanceof Error ? e.message : 'Could not restore this token.') } }}
            >
              Restore token
            </button>
          )}
        </div>
      )}

      {mode.name === 'view' && !archived && (
        <div className="flex flex-wrap gap-2">
          <button type="button" data-trigger="buy" onClick={open('buy', { name: 'record', type: 'BUY' })} className="px-3 py-2 text-sm font-semibold rounded-lg bg-primary text-white">Record buy</button>
          <button type="button" data-trigger="sell" onClick={open('sell', { name: 'record', type: 'SELL' })} className="px-3 py-2 text-sm font-semibold rounded-lg border border-border text-text-primary hover:bg-surface-hover">Record sell</button>
          <button type="button" data-trigger="opening" onClick={open('opening', { name: 'record', type: 'OPENING' })} className="px-3 py-2 text-sm font-semibold rounded-lg border border-border text-text-primary hover:bg-surface-hover">Add opening holding</button>
          <button type="button" data-trigger="price" onClick={open('price', { name: 'price' })} className="px-3 py-2 text-sm font-semibold rounded-lg border border-border text-text-primary hover:bg-surface-hover">Update current price</button>
        </div>
      )}

      {mode.name === 'record' && (
        <div className="bg-surface shadow-card rounded-xl border border-border p-5">
          <EventForm
            assetName={asset.name}
            defaultType={mode.type}
            defaultCurrency={currency}
            onCancel={closeForm}
            onSubmit={async (input) => { await p.onRecordEvent(asset.id, input); await reload(); closeForm() }}
          />
        </div>
      )}
      {mode.name === 'price' && (
        <div className="bg-surface shadow-card rounded-xl border border-border p-5">
          <PriceForm assetName={asset.name} defaultCurrency={currency} onCancel={closeForm} onSubmit={async (v, q) => { await p.onSetPrice(asset.id, v, q); closeForm() }} />
        </div>
      )}

      <ListingInterestBlock asset={asset} onSuggest={p.onSuggestListing} onWithdraw={p.onWithdrawListing} />

      <section aria-labelledby="manage-heading" className="space-y-2">
        <h3 id="manage-heading" className="text-sm font-semibold text-text-primary">Manage token</h3>
        {assetError && <p role="alert" className="text-sm text-danger">{assetError}</p>}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {!archived && p.onArchive && (
            <button
              type="button" className="font-medium text-primary hover:underline"
              onClick={async () => { setAssetError(null); try { await p.onArchive!(asset.id); p.onBack() } catch (e) { setAssetError(e instanceof Error ? e.message : 'Could not archive this token.') } }}
            >
              Archive token
            </button>
          )}
          {events !== null && events.length === 0 && p.onDeleteAsset && (
            confirmAssetDelete ? (
              <span className="inline-flex gap-2">
                <button
                  type="button" className="font-medium text-danger hover:underline"
                  onClick={async () => { setAssetError(null); try { await p.onDeleteAsset!(asset.id); p.onBack() } catch (e) { setConfirmAssetDelete(false); setAssetError(e instanceof Error ? e.message : 'Could not delete this token.') } }}
                >
                  Confirm delete
                </button>
                <button type="button" className="text-text-muted hover:underline" onClick={() => setConfirmAssetDelete(false)}>Keep token</button>
              </span>
            ) : (
              <button type="button" className="text-text-muted hover:text-danger hover:underline" onClick={() => setConfirmAssetDelete(true)}>Delete token</button>
            )
          )}
        </div>
        {events !== null && events.length > 0 && (
          <p className="text-xs text-text-muted">A token with records can be archived but not deleted, so your history is never lost.</p>
        )}
      </section>

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
                {events.map((ev) => (
                  <tr key={ev.id}>
                    <td className="px-3 py-2 whitespace-nowrap">{new Date(ev.occurredAt).toLocaleString()}</td>
                    <td className={`px-3 py-2 whitespace-nowrap ${ev.voided ? 'text-text-muted line-through' : ''}`}>
                      {TYPE_LABEL[ev.type]} <span className="text-xs text-text-muted no-underline">· {ev.source === 'ctm' ? 'RupChain trade' : 'manual'}</span>
                      {ev.voided && (
                        <span className="block text-xs text-amber-800 no-underline" style={{ textDecoration: 'none' }}>
                          Not counted: {VOID_TEXT[ev.voidReason ?? ''] ?? 'it no longer qualifies'}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">{formatQuantity(ev.quantity)}</td>
                    <td className="px-3 py-2 text-right">
                      {ev.type === 'OPENING'
                        ? (ev.zeroCost ? '0 (zero cost)' : ev.basis !== null ? `${formatDecimal(ev.basis)} ${ev.quote}` : 'Unknown cost')
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
                        <span className="inline-flex gap-2">
                          <button
                            type="button" className="text-danger font-medium hover:underline"
                            onClick={async () => {
                              setActionError(null)
                              try { await p.onDeleteEvent(asset.id, ev.id); setConfirmDelete(null); await reload() }
                              catch (e) { setConfirmDelete(null); setActionError(e instanceof Error ? e.message : 'Could not remove this entry.') }
                            }}
                          >
                            Confirm remove
                          </button>
                          <button type="button" className="text-text-muted hover:underline" onClick={() => setConfirmDelete(null)}>Keep</button>
                        </span>
                      ) : (
                        <button type="button" className="text-text-muted hover:text-danger hover:underline" onClick={() => setConfirmDelete(ev.id)} aria-label={`Remove ${TYPE_LABEL[ev.type]} entry from ${new Date(ev.occurredAt).toLocaleDateString()}`}>
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
