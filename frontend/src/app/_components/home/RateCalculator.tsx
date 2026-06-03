'use client'

import { useEffect, useMemo, useState } from 'react'
import { ArrowLeftRight, Coins, Fuel, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'

// ─── Types (mirror backend MarketRatesSummary) ──────────────────────────────────

interface MarketRateUsdt {
  averagePkrRate: number | null
  listingCount: number
}

interface MarketRateToken {
  symbol: string
  name: string
  slug: string
  averageUsdtRate: number | null
  averagePkrRate: number | null
  listingCount: number
}

interface MarketRatesSummary {
  usdt: MarketRateUsdt
  communityTokens: MarketRateToken[]
  gasFees: MarketRateToken[]
  updatedAt: string
}

type TabKey = 'usdt' | 'ctm' | 'gas'

// ─── Formatting helpers ──────────────────────────────────────────────────────────

/** PKR with thousands separators, up to 2 decimals. */
function fmtPkr(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

/** USDT with sensible decimals — more precision for sub-dollar values. */
function fmtUsdt(n: number): string {
  const max = n !== 0 && Math.abs(n) < 1 ? 6 : 2
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: max })
}

/** Token / gas amount with up to 6 decimals, trailing zeros trimmed. */
function fmtToken(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 })
}

function parseAmount(v: string): number | null {
  if (v.trim() === '') return null
  const n = parseFloat(v)
  return isNaN(n) || n < 0 ? null : n
}

// ─── Shared UI primitives ────────────────────────────────────────────────────────

const INPUT_CLS =
  'w-full px-3 py-2.5 bg-white/10 border border-white/10 rounded-lg text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary/50'

const SELECT_CLS =
  'w-full px-3 py-2.5 bg-white/10 border border-white/10 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary/50 appearance-none cursor-pointer'

function UnitToggle({
  units,
  value,
  onChange,
}: {
  units: string[]
  value: string
  onChange: (u: string) => void
}) {
  return (
    <div className="inline-flex rounded-lg bg-white/5 border border-white/10 p-0.5">
      {units.map((u) => (
        <button
          key={u}
          type="button"
          onClick={() => onChange(u)}
          className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
            value === u ? 'bg-primary text-white' : 'text-slate-300 hover:text-white'
          }`}
        >
          {u}
        </button>
      ))}
    </div>
  )
}

function OutputRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-slate-400">{label}</span>
      <span className="text-sm font-semibold text-white tabular-nums">{value}</span>
    </div>
  )
}

function EmptyRate() {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-6 text-center">
      <p className="text-sm text-slate-300">No active market rate available yet.</p>
      <p className="mt-1 text-xs text-slate-500">Check back once traders post listings.</p>
    </div>
  )
}

// ─── USDT Marketplace calculator ──────────────────────────────────────────────────

function UsdtCalculator({ usdt }: { usdt: MarketRateUsdt }) {
  const [amount, setAmount] = useState('')
  const [from, setFrom] = useState<'USDT' | 'PKR'>('USDT')

  const rate = usdt.averagePkrRate // PKR per USDT
  const hasRate = rate !== null && rate > 0 && usdt.listingCount > 0

  const out = useMemo(() => {
    if (!hasRate || rate === null) return null
    const n = parseAmount(amount)
    if (n === null) return null
    return from === 'USDT'
      ? { usdt: n, pkr: n * rate }
      : { usdt: n / rate, pkr: n }
  }, [amount, from, rate, hasRate])

  if (!hasRate) return <EmptyRate />

  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-xs font-medium text-slate-400">You enter</label>
          <UnitToggle units={['USDT', 'PKR']} value={from} onChange={(u) => setFrom(u as 'USDT' | 'PKR')} />
        </div>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={from === 'USDT' ? 'e.g. 100' : 'e.g. 50,000'}
          className={INPUT_CLS}
        />
      </div>

      <div className="rounded-lg border border-white/10 bg-white/5 p-3 space-y-2">
        <OutputRow
          label={from === 'USDT' ? 'Estimated PKR' : 'Estimated USDT'}
          value={
            out
              ? from === 'USDT'
                ? `PKR ${fmtPkr(out.pkr)}`
                : `${fmtUsdt(out.usdt)} USDT`
              : '—'
          }
        />
      </div>

      <RateFooter
        lines={[`1 USDT ≈ PKR ${fmtPkr(rate as number)}`]}
        depth={`Based on latest ${usdt.listingCount} active listing${usdt.listingCount === 1 ? '' : 's'}`}
        note="Final trade rate may vary by listing."
      />
    </div>
  )
}

// ─── Community Tokens calculator ──────────────────────────────────────────────────

function CtmCalculator({ tokens }: { tokens: MarketRateToken[] }) {
  const [symbol, setSymbol] = useState(tokens[0]?.symbol ?? '')
  const [amount, setAmount] = useState('')

  const token = tokens.find((t) => t.symbol === symbol) ?? tokens[0]

  const out = useMemo(() => {
    if (!token) return null
    const n = parseAmount(amount)
    if (n === null) return null
    return {
      usdt: token.averageUsdtRate !== null ? n * token.averageUsdtRate : null,
      pkr: token.averagePkrRate !== null ? n * token.averagePkrRate : null,
    }
  }, [amount, token])

  if (tokens.length === 0 || !token) return <EmptyRate />

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-400">Community token</label>
        <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className={SELECT_CLS}>
          {tokens.map((t) => (
            <option key={t.symbol} value={t.symbol} className="bg-slate-900">
              {t.symbol} — {t.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-400">Amount ({token.symbol})</label>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={`e.g. 55 ${token.symbol}`}
          className={INPUT_CLS}
        />
      </div>

      <div className="rounded-lg border border-white/10 bg-white/5 p-3 space-y-2">
        <OutputRow
          label="Estimated USDT"
          value={out && out.usdt !== null ? `${fmtUsdt(out.usdt)} USDT` : '—'}
        />
        <OutputRow
          label="Estimated PKR"
          value={out && out.pkr !== null ? `PKR ${fmtPkr(out.pkr)}` : '—'}
        />
      </div>

      <RateFooter
        lines={[
          token.averageUsdtRate !== null ? `1 ${token.symbol} ≈ ${fmtUsdt(token.averageUsdtRate)} USDT` : null,
          token.averagePkrRate !== null ? `1 ${token.symbol} ≈ PKR ${fmtPkr(token.averagePkrRate)}` : null,
        ]}
        depth={`Based on latest ${token.listingCount} active listing${token.listingCount === 1 ? '' : 's'}`}
        note="Final trade rate may vary by listing."
      />
    </div>
  )
}

// ─── Crypto Gas Fees calculator ────────────────────────────────────────────────────

function GasCalculator({ options }: { options: MarketRateToken[] }) {
  const [symbol, setSymbol] = useState(options[0]?.symbol ?? '')
  const [amount, setAmount] = useState('')
  const [unit, setUnit] = useState<'GAS' | 'USDT' | 'PKR'>('GAS')

  const opt = options.find((o) => o.symbol === symbol) ?? options[0]
  const usdtRate = opt?.averageUsdtRate ?? null // USDT per gas token
  const pkrRate = opt?.averagePkrRate ?? null // PKR per gas token

  const out = useMemo(() => {
    if (!opt || usdtRate === null || usdtRate <= 0) return null
    const n = parseAmount(amount)
    if (n === null) return null
    let gas: number
    if (unit === 'GAS') gas = n
    else if (unit === 'USDT') gas = n / usdtRate
    else {
      if (pkrRate === null || pkrRate <= 0) return null
      gas = n / pkrRate
    }
    return {
      gas,
      usdt: gas * usdtRate,
      pkr: pkrRate !== null ? gas * pkrRate : null,
    }
  }, [amount, unit, opt, usdtRate, pkrRate])

  if (options.length === 0 || !opt) return <EmptyRate />

  // Units offered: PKR only when a PKR rate is available.
  const units = pkrRate !== null ? ['GAS', 'USDT', 'PKR'] : ['GAS', 'USDT']

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-400">Gas option</label>
        <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className={SELECT_CLS}>
          {options.map((o) => (
            <option key={o.symbol} value={o.symbol} className="bg-slate-900">
              {o.name} ({o.symbol})
            </option>
          ))}
        </select>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-xs font-medium text-slate-400">You enter</label>
          <UnitToggle
            units={units}
            value={unit}
            onChange={(u) => setUnit(u as 'GAS' | 'USDT' | 'PKR')}
          />
        </div>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={unit === 'GAS' ? `e.g. 0.05 ${opt.symbol}` : unit === 'USDT' ? 'e.g. 2' : 'e.g. 500'}
          className={INPUT_CLS}
        />
      </div>

      <div className="rounded-lg border border-white/10 bg-white/5 p-3 space-y-2">
        {unit !== 'GAS' && (
          <OutputRow label={`Estimated ${opt.symbol}`} value={out ? `${fmtToken(out.gas)} ${opt.symbol}` : '—'} />
        )}
        {unit !== 'USDT' && (
          <OutputRow label="Estimated USDT" value={out ? `${fmtUsdt(out.usdt)} USDT` : '—'} />
        )}
        {unit !== 'PKR' && (
          <OutputRow label="Estimated PKR" value={out && out.pkr !== null ? `PKR ${fmtPkr(out.pkr)}` : '—'} />
        )}
      </div>

      <RateFooter
        lines={[
          usdtRate !== null ? `1 ${opt.symbol} ≈ ${fmtUsdt(usdtRate)} USDT` : null,
          pkrRate !== null ? `1 ${opt.symbol} ≈ PKR ${fmtPkr(pkrRate)}` : null,
        ]}
        depth="Live RupChain gas rate"
        note="Final cost includes a network + platform fee."
      />
    </div>
  )
}

// ─── Rate / depth footer ───────────────────────────────────────────────────────────

function RateFooter({
  lines,
  depth,
  note,
}: {
  lines: (string | null)[]
  depth: string
  note: string
}) {
  const visible = lines.filter((l): l is string => !!l)
  return (
    <div className="space-y-1 pt-1">
      {visible.map((l) => (
        <div key={l} className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
          <p className="text-xs text-slate-300">
            Avg rate: <span className="font-semibold text-white">{l}</span>
          </p>
        </div>
      ))}
      <p className="text-[11px] text-slate-500">{depth}</p>
      <p className="text-[11px] text-slate-500">{note}</p>
    </div>
  )
}

// ─── Card shell ──────────────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white/5 backdrop-blur-sm rounded-xl border border-white/10 p-6 shadow-card-lg">
      {children}
    </div>
  )
}

const TABS: { key: TabKey; label: string; short: string; Icon: typeof ArrowLeftRight }[] = [
  { key: 'usdt', label: 'USDT Marketplace', short: 'USDT', Icon: ArrowLeftRight },
  { key: 'ctm', label: 'Community Tokens', short: 'Tokens', Icon: Coins },
  { key: 'gas', label: 'Crypto Gas Fees', short: 'Gas', Icon: Fuel },
]

// ─── Main component ────────────────────────────────────────────────────────────────

export function RateCalculator() {
  const [tab, setTab] = useState<TabKey>('usdt')
  const [data, setData] = useState<MarketRatesSummary | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let active = true
    setStatus('loading')
    api
      .get<MarketRatesSummary>('/marketplace/rates/summary')
      .then((res) => {
        if (!active) return
        setData(res)
        setStatus('ready')
      })
      .catch(() => {
        if (active) setStatus('error')
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <Shell>
      <div className="mb-4">
        <h2 className="text-base font-semibold text-white">RupChain Market Calculator</h2>
        <p className="mt-0.5 text-xs text-slate-400">Average rates are based on active RupChain listings.</p>
      </div>

      {/* Tabs */}
      <div className="mb-4 grid grid-cols-3 gap-1.5">
        {TABS.map(({ key, label, short, Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-semibold transition-colors ${
              tab === key
                ? 'bg-primary text-white'
                : 'bg-white/5 text-slate-300 hover:bg-white/10 border border-white/10'
            }`}
            aria-pressed={tab === key}
          >
            <Icon size={14} aria-hidden />
            <span className="hidden sm:inline">{label}</span>
            <span className="sm:hidden">{short}</span>
          </button>
        ))}
      </div>

      {/* Body */}
      {status === 'loading' && (
        <div className="space-y-3 animate-pulse">
          <div className="h-10 rounded-lg bg-white/10" />
          <div className="h-16 rounded-lg bg-white/5" />
          <div className="h-3 w-2/3 rounded bg-white/10" />
        </div>
      )}

      {status === 'error' && (
        <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-6 text-center">
          <p className="text-sm text-slate-300">Couldn&apos;t load live rates.</p>
          <button
            type="button"
            onClick={() => {
              setStatus('loading')
              api
                .get<MarketRatesSummary>('/marketplace/rates/summary')
                .then((res) => {
                  setData(res)
                  setStatus('ready')
                })
                .catch(() => setStatus('error'))
            }}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/20"
          >
            <RefreshCw size={13} aria-hidden /> Retry
          </button>
        </div>
      )}

      {status === 'ready' && data && (
        <>
          {tab === 'usdt' && <UsdtCalculator usdt={data.usdt} />}
          {tab === 'ctm' && <CtmCalculator tokens={data.communityTokens} />}
          {tab === 'gas' && <GasCalculator options={data.gasFees} />}
        </>
      )}
    </Shell>
  )
}
