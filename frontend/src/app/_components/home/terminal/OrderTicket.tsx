'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeftRight, Coins, Fuel } from 'lucide-react'
import type { MarketRateToken } from '@/lib/api'
import { useTerminal } from './TerminalProvider'
import { fmtPkr, fmtPrice } from './format'

// Exchange-style order ticket. The pricing rules are the same ones the classic
// homepage RateCalculator uses (see _components/home/RateCalculator.tsx):
//  · USDT  Buy uses sellRatePkr (maker-sell ads), Sell uses buyRatePkr.
//  · Token Buy uses sellRateUsdt/sellPricePkr, Sell uses the buy side.
//  · Gas   is buy-only and priced from buyRateUsdt/buyPricePkr.

type Kind = 'usdt' | 'ctm' | 'gas'
type Side = 'Buy' | 'Sell'

const KINDS: { key: Kind; label: string; Icon: typeof Coins }[] = [
  { key: 'usdt', label: 'USDT', Icon: ArrowLeftRight },
  { key: 'ctm', label: 'Tokens', Icon: Coins },
  { key: 'gas', label: 'Gas', Icon: Fuel },
]

function parseAmount(v: string): number | null {
  if (v.trim() === '') return null
  const n = parseFloat(v)
  return isNaN(n) || n < 0 ? null : n
}

interface Quote {
  symbol: string
  rateLine: string | null
  get: number | null
  pkr: number | null
  usdt: number | null
  depth: string
}

export function OrderTicket() {
  const { summary } = useTerminal()
  const [kind, setKind] = useState<Kind>('usdt')
  const [side, setSide] = useState<Side>('Buy')
  const [usdtUnit, setUsdtUnit] = useState<'USDT' | 'PKR'>('USDT')
  const [gasUnit, setGasUnit] = useState<'GAS' | 'USDT' | 'PKR'>('GAS')
  const [symbol, setSymbol] = useState('')
  const [amount, setAmount] = useState('100')

  const list: MarketRateToken[] = kind === 'ctm' ? summary?.communityTokens ?? [] : kind === 'gas' ? summary?.gasFees ?? [] : []
  const token = list.find((t) => t.symbol === symbol) ?? list[0]
  const n = parseAmount(amount)

  const quote = useMemo<Quote | null>(() => {
    if (!summary) return null
    if (kind === 'usdt') {
      const rate = side === 'Buy' ? summary.usdt.sellRatePkr : summary.usdt.buyRatePkr
      const count = side === 'Buy' ? summary.usdt.sellListingCount : summary.usdt.buyListingCount
      if (rate === null || rate <= 0) return null
      const usdt = n === null ? null : usdtUnit === 'USDT' ? n : n / rate
      const pkr = n === null ? null : usdtUnit === 'USDT' ? n * rate : n
      return { symbol: 'USDT', rateLine: `PKR ${fmtPkr(rate)} / USDT`, get: usdt, pkr, usdt: null, depth: `${count} active listing${count === 1 ? '' : 's'}` }
    }
    if (!token) return null
    if (kind === 'ctm') {
      const ru = side === 'Buy' ? token.sellRateUsdt : token.buyRateUsdt
      const rp = side === 'Buy' ? token.sellPricePkr : token.buyPricePkr
      const count = side === 'Buy' ? token.sellListingCount : token.buyListingCount
      if (ru === null && rp === null) return null
      return {
        symbol: token.symbol,
        rateLine: rp !== null ? `PKR ${fmtPrice(rp)} / ${token.symbol}` : `${fmtPrice(ru)} USDT / ${token.symbol}`,
        get: n,
        pkr: n !== null && rp !== null ? n * rp : null,
        usdt: n !== null && ru !== null ? n * ru : null,
        depth: `${count} active listing${count === 1 ? '' : 's'}`,
      }
    }
    const ru = token.buyRateUsdt, rp = token.buyPricePkr
    if (ru === null || ru <= 0) return null
    let gas: number | null = null
    if (n !== null) gas = gasUnit === 'GAS' ? n : gasUnit === 'USDT' ? n / ru : rp ? n / rp : null
    return {
      symbol: token.symbol,
      rateLine: rp !== null ? `PKR ${fmtPrice(rp)} / ${token.symbol}` : `${fmtPrice(ru)} USDT / ${token.symbol}`,
      get: gas,
      pkr: gas !== null && rp !== null ? gas * rp : null,
      usdt: gas !== null ? gas * ru : null,
      depth: 'Live gas rate',
    }
  }, [summary, kind, side, usdtUnit, gasUnit, token, n])

  const isGas = kind === 'gas'
  const buying = isGas || side === 'Buy'
  const presets = kind === 'usdt' && usdtUnit === 'PKR' ? ['5000', '10000', '50000', '100000'] : ['10', '100', '500', '1000']
  const units: string[] = kind === 'usdt' ? ['USDT', 'PKR'] : isGas ? (token?.buyPricePkr != null ? ['GAS', 'USDT', 'PKR'] : ['GAS', 'USDT']) : []
  const curUnit = kind === 'usdt' ? usdtUnit : gasUnit
  const setUnit = (u: string) => (kind === 'usdt' ? setUsdtUnit(u as 'USDT' | 'PKR') : setGasUnit(u as 'GAS' | 'USDT' | 'PKR'))
  const ctaHref = kind === 'usdt' ? `/marketplace?side=${buying ? 'buy' : 'sell'}` : kind === 'ctm' ? '/ctm/listings' : '/gas'
  const ctaLabel = isGas ? `Top up ${token?.symbol ?? ''} gas` : `${side} ${kind === 'usdt' ? 'USDT' : token?.symbol ?? 'tokens'}`
  const ctaCls = isGas ? 'bg-primary hover:bg-primary-hover' : buying ? 'bg-success hover:bg-success-hover' : 'bg-danger hover:bg-danger-hover'

  return (
    <div className="rounded-2xl border border-border bg-surface shadow-card overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border">
        <p className="font-mono text-xs font-semibold text-text-primary">ORDER TICKET</p>
        <div className="flex gap-1">
          {KINDS.map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => { setKind(key); setSymbol('') }}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded font-mono text-[11px] font-semibold transition-colors ${kind === key ? 'bg-text-primary text-surface' : 'text-text-muted hover:bg-surface-alt'}`}
            >
              <Icon className="w-3 h-3" aria-hidden />{label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4">
        {isGas ? (
          <p className="font-mono text-[11px] text-text-muted mb-3">TOP UP GAS · ONE-WAY PURCHASE</p>
        ) : (
          <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-surface-alt mb-4">
            {(['Buy', 'Sell'] as Side[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSide(s)}
                className={`py-2 rounded-md text-sm font-bold transition-colors ${side === s ? (s === 'Buy' ? 'bg-success text-white' : 'bg-danger text-white') : 'text-text-muted hover:text-text-primary'}`}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {kind !== 'usdt' && (
          <>
            <label htmlFor="ticket-asset" className="font-mono text-[11px] text-text-muted">{isGas ? 'CHAIN' : 'TOKEN'}</label>
            <select
              id="ticket-asset"
              value={token?.symbol ?? ''}
              onChange={(e) => setSymbol(e.target.value)}
              className="mt-1 mb-3 w-full px-3 py-2.5 rounded-lg bg-surface-alt border border-border text-sm font-semibold text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              {list.length ? list.map((t) => <option key={t.symbol} value={t.symbol}>{t.symbol} · {t.name}</option>) : <option value="">None listed yet</option>}
            </select>
          </>
        )}

        <label htmlFor="ticket-amount" className="font-mono text-[11px] text-text-muted">AMOUNT</label>
        <div className="mt-1 flex items-center rounded-lg bg-surface-alt border border-border focus-within:ring-2 focus-within:ring-primary/40">
          <input
            id="ticket-amount"
            type="number"
            inputMode="decimal"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full min-w-0 bg-transparent px-3 py-3 font-mono text-lg font-semibold tabular-nums text-text-primary focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          {units.length ? (
            <div className="flex gap-0.5 pr-1.5">
              {units.map((u) => (
                <button
                  key={u}
                  type="button"
                  onClick={() => setUnit(u)}
                  className={`px-2 py-1 rounded font-mono text-[11px] font-bold ${curUnit === u ? 'bg-surface text-text-primary shadow-card' : 'text-text-muted'}`}
                >
                  {u === 'GAS' ? token?.symbol ?? 'GAS' : u}
                </button>
              ))}
            </div>
          ) : (
            <span className="pr-3 font-mono text-xs font-bold text-text-muted">{token?.symbol}</span>
          )}
        </div>
        <div className="mt-2 flex gap-1.5">
          {presets.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setAmount(v)}
              className={`flex-1 py-1 rounded font-mono text-[11px] border transition-colors ${amount === v ? 'bg-text-primary text-surface border-text-primary' : 'border-border text-text-muted hover:text-text-primary'}`}
            >
              {Number(v).toLocaleString('en-US')}
            </button>
          ))}
        </div>

        {quote ? (
          <dl className="mt-4 space-y-2 font-mono text-xs">
            <div className="flex justify-between gap-3"><dt className="text-text-muted">Avg price</dt><dd className="tabular-nums text-right text-text-primary">{quote.rateLine ?? '—'}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-text-muted">{buying ? 'You get' : 'You send'}</dt><dd className="tabular-nums font-semibold text-text-primary">{quote.get !== null ? `${fmtPrice(quote.get)} ${quote.symbol}` : '—'}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-text-muted">Depth</dt><dd className="tabular-nums text-text-primary">{quote.depth}</dd></div>
            <div className="flex justify-between items-baseline gap-3 border-t border-dashed border-border pt-3">
              <dt className="text-text-muted">{buying ? 'YOU PAY' : 'YOU RECEIVE'}</dt>
              <dd className="tabular-nums text-xl font-bold text-text-primary">{quote.pkr !== null ? `PKR ${fmtPkr(quote.pkr)}` : '—'}</dd>
            </div>
            {quote.usdt !== null && <p className="text-right text-[11px] text-text-muted">≈ {fmtPrice(quote.usdt)} USDT</p>}
          </dl>
        ) : (
          <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-5 text-center">
            <p className="text-sm text-text-secondary">No active market rate yet.</p>
            <p className="mt-1 text-xs text-text-muted">Check back once traders post listings.</p>
          </div>
        )}

        <Link href={ctaHref} className={`mt-4 flex w-full items-center justify-center py-3 rounded-lg text-white font-bold text-sm transition-colors ${ctaCls}`}>
          {ctaLabel} →
        </Link>
        <p className="mt-2 text-center font-mono text-[10px] text-text-muted">
          {isGas ? 'Final cost includes network + platform fee' : 'Estimate from active listings · final rate set by trader'}
        </p>
      </div>
    </div>
  )
}
