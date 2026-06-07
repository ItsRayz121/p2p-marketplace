'use client'
import { useState, useCallback, useEffect } from 'react'
import { adminApi } from '@/lib/api'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { GasSectionTabs } from '@/components/admin/GasSectionTabs'

type BurnRate = {
  chain: string
  nativePerDay: number
  usdPerDay: number
  windowDays: number
}

type Runway = {
  chain: string
  nativeSymbol: string
  currentBalanceNative: number | null
  burnRateNativePerDay: number
  daysRemaining: number | null
  status: 'healthy' | 'low' | 'critical' | 'no_data'
}

type Profitability = {
  chain: string
  revenueUsd: number
  deliveryCostUsd: number
  refundCostUsd: number
  netProfitUsd: number
  margin: number | null
}

type DailyVolume = {
  date: string
  orders: number
  revenueUsd: number
}

function runwayColor(s: Runway['status']) {
  if (s === 'critical') return 'bg-danger/10 border-danger/30 text-danger'
  if (s === 'low') return 'bg-warning/10 border-warning/30 text-warning'
  if (s === 'no_data') return 'bg-surface border-border text-text-muted'
  return 'bg-success/10 border-success/30 text-success'
}

function runwayLabel(d: number | null) {
  if (d === null) return 'N/A'
  if (d > 365) return '365+ days'
  return `${d.toFixed(0)} day${d !== 1 ? 's' : ''}`
}

function usd(v: number) {
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const CHAINS = ['TRON','BSC','ETH','BASE','ARB','OP','MATIC','AVAX']

function VolumeChart({ data }: { data: DailyVolume[] }) {
  const W = 600, H = 200, PAD = { top: 10, right: 10, bottom: 30, left: 45 }
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom

  const maxOrders = Math.max(...data.map((d) => d.orders), 1)
  const maxRevenue = Math.max(...data.map((d) => d.revenueUsd), 1)

  function xPos(i: number) { return PAD.left + (i / (data.length - 1 || 1)) * innerW }
  function yOrders(v: number) { return PAD.top + innerH - (v / maxOrders) * innerH }
  function yRevenue(v: number) { return PAD.top + innerH - (v / maxRevenue) * innerH }

  const ordersPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${xPos(i)},${yOrders(d.orders)}`).join(' ')
  const revPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${xPos(i)},${yRevenue(d.revenueUsd)}`).join(' ')

  const labelEvery = Math.ceil(data.length / 6)

  return (
    <div className="bg-surface shadow-card rounded-xl border border-border p-4 overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 300 }}>
        {/* Y-axis tick lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const y = PAD.top + innerH - t * innerH
          return (
            <g key={t}>
              <line x1={PAD.left} y1={y} x2={PAD.left + innerW} y2={y} stroke="#e5e7eb" strokeWidth={1} />
              <text x={PAD.left - 4} y={y + 4} textAnchor="end" fontSize={9} fill="#9ca3af">
                {Math.round(maxOrders * t)}
              </text>
            </g>
          )
        })}
        {/* X-axis labels */}
        {data.map((d, i) => i % labelEvery === 0 ? (
          <text key={i} x={xPos(i)} y={H - 4} textAnchor="middle" fontSize={9} fill="#9ca3af">
            {d.date.slice(5)}
          </text>
        ) : null)}
        {/* Lines */}
        <path d={ordersPath} fill="none" stroke="#6366f1" strokeWidth={2} strokeLinejoin="round" />
        <path d={revPath} fill="none" stroke="#22c55e" strokeWidth={2} strokeLinejoin="round" />
      </svg>
      <div className="flex gap-4 mt-2 text-xs text-text-muted">
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-[#6366f1] rounded"></span> Orders (left scale)</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-[#22c55e] rounded"></span> Revenue USD (right scale)</span>
      </div>
    </div>
  )
}

export default function GasAnalyticsPage() {
  const [burnRates, setBurnRates] = useState<BurnRate[]>([])
  const [runways, setRunways] = useState<Runway[]>([])
  const [profitability, setProfitability] = useState<Profitability[]>([])
  const [volume, setVolume] = useState<DailyVolume[]>([])

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [volumeChain, setVolumeChain] = useState('')
  const [volumeWindow, setVolumeWindow] = useState(30)
  const [profitFrom, setProfitFrom] = useState('')
  const [profitTo, setProfitTo] = useState('')
  const [burnWindow, setBurnWindow] = useState(7)

  const [volumeLoading, setVolumeLoading] = useState(false)
  const [profitLoading, setProfitLoading] = useState(false)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [br, rw, pf, vol] = await Promise.all([
        adminApi.getGasBurnRates(burnWindow),
        adminApi.getGasRunways(),
        adminApi.getGasProfitability(),
        adminApi.getGasVolume(undefined, volumeWindow),
      ])
      setBurnRates(br.burnRates)
      setRunways(rw.runways)
      setProfitability(pf.profitability)
      setVolume(vol.series)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load analytics')
    } finally {
      setLoading(false)
    }
  }, [burnWindow, volumeWindow])

  useEffect(() => { fetchAll() }, [fetchAll])

  async function refreshVolume() {
    setVolumeLoading(true)
    try {
      const res = await adminApi.getGasVolume(volumeChain || undefined, volumeWindow)
      setVolume(res.series)
    } catch { /* swallow */ }
    finally { setVolumeLoading(false) }
  }

  async function refreshProfitability() {
    setProfitLoading(true)
    try {
      const res = await adminApi.getGasProfitability(profitFrom || undefined, profitTo || undefined)
      setProfitability(res.profitability)
    } catch { /* swallow */ }
    finally { setProfitLoading(false) }
  }

  if (loading) return <LoadingState message="Loading analytics..." />
  if (error) return <ErrorState title={error} onRetry={fetchAll} />

  return (
    <div className="space-y-8">
      <GasSectionTabs active="analytics" />
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Gas Analytics</h1>
        <p className="text-text-muted text-sm mt-0.5">Burn rates, runway estimates, and profitability by chain.</p>
      </div>

      {/* ── Runway Cards ─────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold text-text-primary">Chain Runway</h2>
        {runways.length === 0 ? (
          <p className="text-text-muted text-sm">No runway data — wallets may not have been fetched yet.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {runways.map((r) => (
              <div key={r.chain} className={`border rounded-xl p-4 ${runwayColor(r.status)}`}>
                <p className="font-bold text-lg">{r.chain}</p>
                <p className="text-2xl font-semibold mt-1">{runwayLabel(r.daysRemaining)}</p>
                <p className="text-xs mt-1 opacity-75">
                  {r.currentBalanceNative != null ? r.currentBalanceNative.toFixed(4) : '?'} {r.nativeSymbol}
                </p>
                <p className="text-xs opacity-75">{r.burnRateNativePerDay.toFixed(4)}/day burn</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Volume Chart ─────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-base font-semibold text-text-primary">Order Volume</h2>
          <select
            className="border border-border rounded-lg px-3 py-1.5 text-sm"
            value={volumeChain}
            onChange={(e) => setVolumeChain(e.target.value)}
          >
            <option value="">All chains</option>
            {CHAINS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select
            className="border border-border rounded-lg px-3 py-1.5 text-sm"
            value={volumeWindow}
            onChange={(e) => setVolumeWindow(Number(e.target.value))}
          >
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
          <button
            onClick={refreshVolume}
            disabled={volumeLoading}
            className="text-sm text-primary underline disabled:opacity-50"
          >
            {volumeLoading ? 'Loading...' : 'Refresh'}
          </button>
        </div>

        {volume.length === 0 ? (
          <p className="text-text-muted text-sm">No volume data for the selected window.</p>
        ) : (
          <VolumeChart data={volume} />
        )}
      </section>

      {/* ── Profitability Table ───────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-base font-semibold text-text-primary">Profitability</h2>
          <input
            type="date"
            className="border border-border rounded-lg px-3 py-1.5 text-sm"
            value={profitFrom}
            onChange={(e) => setProfitFrom(e.target.value)}
          />
          <span className="text-text-muted text-sm">to</span>
          <input
            type="date"
            className="border border-border rounded-lg px-3 py-1.5 text-sm"
            value={profitTo}
            onChange={(e) => setProfitTo(e.target.value)}
          />
          <button
            onClick={refreshProfitability}
            disabled={profitLoading}
            className="text-sm text-primary underline disabled:opacity-50"
          >
            {profitLoading ? 'Loading...' : 'Refresh'}
          </button>
        </div>

        {profitability.length === 0 ? (
          <p className="text-text-muted text-sm">No profitability data available.</p>
        ) : (
          <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface border-b border-border">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-text-muted">Chain</th>
                    <th className="text-right px-4 py-3 font-medium text-text-muted">Revenue</th>
                    <th className="text-right px-4 py-3 font-medium text-text-muted">Delivery Cost</th>
                    <th className="text-right px-4 py-3 font-medium text-text-muted">Refund Cost</th>
                    <th className="text-right px-4 py-3 font-medium text-text-muted">Net Profit</th>
                    <th className="text-right px-4 py-3 font-medium text-text-muted">Margin</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {profitability.map((p) => (
                    <tr key={p.chain} className="hover:bg-surface/50 transition-colors">
                      <td className="px-4 py-3 font-medium text-text-primary">{p.chain}</td>
                      <td className="px-4 py-3 text-right text-text-primary">{usd(p.revenueUsd)}</td>
                      <td className="px-4 py-3 text-right text-text-muted">{usd(p.deliveryCostUsd)}</td>
                      <td className="px-4 py-3 text-right text-text-muted">{usd(p.refundCostUsd)}</td>
                      <td className={`px-4 py-3 text-right font-semibold ${p.netProfitUsd >= 0 ? 'text-success' : 'text-danger'}`}>
                        {usd(p.netProfitUsd)}
                      </td>
                      <td className="px-4 py-3 text-right text-text-muted">
                        {p.margin != null ? `${(p.margin * 100).toFixed(1)}%` : 'N/A'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* ── Burn Rates ───────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold text-text-primary">Burn Rates</h2>
          <select
            className="border border-border rounded-lg px-3 py-1.5 text-sm"
            value={burnWindow}
            onChange={(e) => setBurnWindow(Number(e.target.value))}
          >
            <option value={7}>7-day avg</option>
            <option value={14}>14-day avg</option>
            <option value={30}>30-day avg</option>
          </select>
        </div>

        {burnRates.length === 0 ? (
          <p className="text-text-muted text-sm">No burn rate data yet.</p>
        ) : (
          <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface border-b border-border">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-text-muted">Chain</th>
                    <th className="text-right px-4 py-3 font-medium text-text-muted">Native/Day</th>
                    <th className="text-right px-4 py-3 font-medium text-text-muted">USD/Day</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {burnRates.map((b) => (
                    <tr key={b.chain} className="hover:bg-surface/50 transition-colors">
                      <td className="px-4 py-3 font-medium text-text-primary">{b.chain}</td>
                      <td className="px-4 py-3 text-right text-text-muted">{b.nativePerDay.toFixed(4)}</td>
                      <td className="px-4 py-3 text-right text-text-primary">{usd(b.usdPerDay)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
