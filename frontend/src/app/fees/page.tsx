'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { marketplaceApi, apiRequest } from '@/lib/api'
import { LoadingState } from '@/components/ui/LoadingState'
import { Gift } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

type WithdrawalFeeMap = Record<string, Record<string, string>>

// Backend /wallet/fee-schedule returns a flat config array. Withdrawal (escrow)
// fees live under keys shaped `network_fee_<COIN>_<NETWORK>` with the fee amount
// (in that coin) as the value. Transform them into a coin → network → label map.
function buildWithdrawalFees(configs: Array<{ key: string; value: string }>): WithdrawalFeeMap | null {
  const map: WithdrawalFeeMap = {}
  for (const { key, value } of configs) {
    if (!key.startsWith('network_fee_')) continue
    const rest = key.slice('network_fee_'.length)
    const sep = rest.indexOf('_')
    if (sep <= 0) continue
    const coin = rest.slice(0, sep)
    const network = rest.slice(sep + 1)
    if (!coin || !network || !value) continue
    map[coin] = map[coin] ?? {}
    map[coin][network] = `${value} ${coin}`
  }
  return Object.keys(map).length > 0 ? map : null
}

interface PlatformConfig {
  p2pMakerFee?: string
  p2pTakerFee?: string
  kycLimitBasicDaily?: number
  kycLimitEnhancedDaily?: number
  [key: string]: unknown
}

interface GasChain {
  slug: string
  name: string
  symbol: string
  networkLabel: string
  platformFeeUsdt: number
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
  const [withdrawalFeesCfg, setWithdrawalFeesCfg] = useState<WithdrawalFeeMap | null>(null)
  const [config, setConfig] = useState<PlatformConfig | null>(null)
  const [gasChains, setGasChains] = useState<GasChain[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    marketplaceApi.getConfig()
      .then((cfg) => setConfig(cfg as PlatformConfig))
      .catch(() => {})
      .finally(() => setLoading(false))

    // Real escrow withdrawal fees from platform config (network_fee_* keys)
    apiRequest<Array<{ key: string; value: string }>>('/wallet/fee-schedule')
      .then((configs) => { if (Array.isArray(configs)) setWithdrawalFeesCfg(buildWithdrawalFees(configs)) })
      .catch(() => {})

    // Per-network gas platform service fees (real config)
    apiRequest<{ chains: GasChain[] }>('/gas-fee/chains')
      .then((d) => { if (d?.chains) setGasChains(d.chains) })
      .catch(() => {})
  }, [])

  if (loading) return <LoadingState message="Loading fee schedule..." />

  const makerFee = config?.p2pMakerFee ?? '0%'
  const takerFee = config?.p2pTakerFee ?? '0%'
  const kycLimits = {
    basic: config?.kycLimitBasicDaily ?? 50000,
    enhanced: config?.kycLimitEnhancedDaily ?? 200000,
  }

  const withdrawalFees = withdrawalFeesCfg ?? {
    USDT: { TRC20: '1 USDT', ERC20: '5 USDT', BEP20: '0.5 USDT' },
    BTC: { Bitcoin: '0.0001 BTC' },
    ETH: { ERC20: '0.003 ETH' },
    BNB: { BEP20: '0.001 BNB' },
    TRX: { TRC20: '1 TRX' },
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

      {/* Escrow Wallet Withdrawal Fees */}
      <section>
        <h2 className="text-lg font-bold text-text-primary mb-3">Escrow Wallet Withdrawal Fees</h2>
        <Table
          headers={['Coin', 'Network', 'Withdrawal Fee']}
          rows={Object.entries(withdrawalFees).flatMap(([coin, networks]) =>
            Object.entries(networks).map(([network, fee]) => [coin, network, fee])
          )}
        />
        <p className="text-xs text-text-muted mt-2">These fees cover blockchain network withdrawal costs from the RupChain escrow wallet and may vary based on network conditions.</p>
      </section>

      {/* Crypto Gas Fees */}
      <section>
        <h2 className="text-lg font-bold text-text-primary mb-3">Crypto Gas Fees (Instant Gas Buy)</h2>
        <p className="text-sm text-text-muted mb-3">
          When you buy gas instantly you pay the live on-chain value of the gas tokens plus a flat
          platform service fee that depends on the network. The exact total is always shown before you confirm.
        </p>
        {gasChains.length > 0 ? (
          <Table
            headers={['Network', 'Token', 'Platform Service Fee']}
            rows={gasChains.map((c) => [
              c.name,
              c.symbol,
              `${c.platformFeeUsdt} USDT`,
            ])}
          />
        ) : (
          <Table
            headers={['Charge', 'Amount']}
            rows={[
              ['On-chain gas value', 'At live market rate'],
              ['Platform service fee', 'Varies by network (shown before you confirm)'],
            ]}
          />
        )}
        <p className="text-xs text-text-muted mt-2">
          On-chain gas value is charged at the live market rate. See the{' '}
          <Link href="/gas" className="text-primary hover:underline">Crypto Gas Fees</Link> page for the live total.
        </p>
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
                Referral rewards — coming soon
              </p>
              <p className="text-sm text-text-muted">
                Rewards are reviewed and approved by our team based on your referrals&apos; completed
                trading activity. There are no automatic cash payouts.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Account Limits */}
      <section>
        <h2 className="text-lg font-bold text-text-primary mb-3">Account Limits</h2>
        <p className="text-sm text-text-muted mb-3">These are account transaction limits based on your KYC level — not fees.</p>
        <Table
          headers={['KYC Level', 'Daily Buy Limit', 'Daily Withdrawal Limit']}
          rows={[
            ['Unverified', 'PKR 0', 'Not allowed'],
            ['Basic KYC', `PKR ${(kycLimits.basic ?? 50000).toLocaleString()}`, `PKR ${(kycLimits.basic ?? 50000).toLocaleString()}`],
            ['Enhanced KYC', `PKR ${(kycLimits.enhanced ?? 200000).toLocaleString()}`, `PKR ${(kycLimits.enhanced ?? 200000).toLocaleString()}`],
          ]}
        />
      </section>
    </div>
  )
}
