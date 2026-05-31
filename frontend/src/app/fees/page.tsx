'use client'
import { useState, useEffect } from 'react'
import { walletApi, marketplaceApi } from '@/lib/api'
import { LoadingState } from '@/components/ui/LoadingState'
import { Gift } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface FeeSchedule {
  withdrawalFees?: Record<string, Record<string, string>>
  instantBuyFees?: Record<string, string>
}

interface PlatformConfig {
  p2pMakerFee?: string
  p2pTakerFee?: string
  instantBuyFee?: Record<string, string>
  kycLimits?: { basic?: number; enhanced?: number }
  referralReward?: string
  [key: string]: unknown
}

// ─── Table ────────────────────────────────────────────────────────────────────

function Table({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full">
        <thead className="bg-surface border-b border-border">
          <tr>
            {headers.map((h) => (
              <th key={h} className="text-left text-xs font-semibold text-text-muted px-4 py-3 whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="bg-surface divide-y divide-border">
          {rows.map((row, i) => (
            <tr key={i} className="hover:bg-surface/50 transition-colors">
              {row.map((cell, j) => (
                <td key={j} className="px-4 py-3 text-sm text-text-primary">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function FeesPage() {
  const [feeSchedule, setFeeSchedule] = useState<FeeSchedule | null>(null)
  const [config, setConfig] = useState<PlatformConfig | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.allSettled([
      walletApi.getTransactions({ limit: 1 }).catch(() => null),
      marketplaceApi.getConfig(),
    ]).then(([, cfgRes]) => {
      if (cfgRes.status === 'fulfilled') setConfig(cfgRes.value as PlatformConfig)
    }).finally(() => setLoading(false))

    // Try to get fee schedule
    fetch('/api/v1/wallet/fee-schedule', { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) setFeeSchedule(d as FeeSchedule) })
      .catch(() => {})
  }, [])

  if (loading) return <LoadingState message="Loading fee schedule..." />

  const makerFee = config?.p2pMakerFee ?? '0%'
  const takerFee = config?.p2pTakerFee ?? '0%'
  const referralReward = config?.referralReward ?? 'PKR 100'
  const kycLimits = config?.kycLimits ?? { basic: 50000, enhanced: 500000 }

  const withdrawalFees = feeSchedule?.withdrawalFees ?? {
    USDT: { TRC20: '1 USDT', ERC20: '5 USDT', BEP20: '0.5 USDT' },
    BTC: { Bitcoin: '0.0001 BTC' },
    ETH: { ERC20: '0.003 ETH' },
    BNB: { BEP20: '0.001 BNB' },
    TRX: { TRC20: '1 TRX' },
  }

  const instantBuyFees: Record<string, string> = (config?.instantBuyFee as Record<string, string>) ?? {
    USDT: '1%', BTC: '1.5%', ETH: '1.5%', BNB: '1.5%', TRX: '1%',
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 pb-12 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Fee Schedule</h1>
        <p className="text-sm text-text-muted mt-1">Transparent pricing with no hidden fees</p>
      </div>

      {/* P2P Trading */}
      <section>
        <h2 className="text-lg font-bold text-text-primary mb-3">P2P Trading Fees</h2>
        <div className="bg-success/10 border border-success/30 rounded-xl p-5 text-center mb-4">
          <p className="text-2xl font-black text-success">FREE</p>
          <p className="text-sm text-text-muted mt-1">0% maker fee, 0% taker fee on all P2P trades</p>
        </div>
        <Table
          headers={['Fee Type', 'Amount']}
          rows={[
            ['Maker Fee (Ad Creator)', makerFee === '0' || makerFee === '0%' ? '0% — Free' : makerFee],
            ['Taker Fee (Trade Initiator)', takerFee === '0' || takerFee === '0%' ? '0% — Free' : takerFee],
          ]}
        />
      </section>

      {/* Instant Buy */}
      <section>
        <h2 className="text-lg font-bold text-text-primary mb-3">Instant Buy Fees</h2>
        <Table
          headers={['Coin', 'Fee']}
          rows={Object.entries(instantBuyFees).map(([coin, fee]) => [coin, fee])}
        />
      </section>

      {/* Withdrawal Fees */}
      <section>
        <h2 className="text-lg font-bold text-text-primary mb-3">Withdrawal Fees</h2>
        <Table
          headers={['Coin', 'Network', 'Fee']}
          rows={Object.entries(withdrawalFees).flatMap(([coin, networks]) =>
            Object.entries(networks).map(([network, fee]) => [coin, network, fee])
          )}
        />
        <p className="text-xs text-text-muted mt-2">Withdrawal fees cover blockchain network costs and may vary based on network congestion.</p>
      </section>

      {/* KYC Limits */}
      <section>
        <h2 className="text-lg font-bold text-text-primary mb-3">Daily Transaction Limits</h2>
        <Table
          headers={['KYC Level', 'Daily Buy Limit', 'Daily Withdrawal Limit']}
          rows={[
            ['Unverified', 'PKR 0', 'Not allowed'],
            ['Basic KYC', `PKR ${(kycLimits.basic ?? 50000).toLocaleString()}`, `PKR ${(kycLimits.basic ?? 50000).toLocaleString()}`],
            ['Enhanced KYC', `PKR ${(kycLimits.enhanced ?? 500000).toLocaleString()}`, `PKR ${(kycLimits.enhanced ?? 500000).toLocaleString()}`],
          ]}
        />
      </section>

      {/* Referral */}
      <section>
        <h2 className="text-lg font-bold text-text-primary mb-3">Referral Rewards</h2>
        <div className="bg-surface shadow-card border border-border rounded-xl p-5">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
              <Gift size={20} className="text-primary" />
            </div>
            <div>
              <p className="text-base font-bold text-text-primary">
                Earn {referralReward} per referral
              </p>
              <p className="text-sm text-text-muted">Paid when your referral completes their first trade.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Gas Refill */}
      <section>
        <h2 className="text-lg font-bold text-text-primary mb-3">Gas Refill Service (TRX)</h2>
        <Table
          headers={['Tier', 'TRX Amount', 'Price (USDT)']}
          rows={[
            ['SMALL', '10 TRX', '~1.00 USDT'],
            ['MEDIUM', '50 TRX', '~4.50 USDT'],
            ['LARGE', '100 TRX', '~8.50 USDT'],
          ]}
        />
        <p className="text-xs text-text-muted mt-2">Prices update in real-time based on TRX/USDT market rate.</p>
      </section>

      <p className="text-xs text-text-muted text-center">
        Fees are subject to change. Last updated: {new Date().toLocaleDateString()}
      </p>
    </div>
  )
}
