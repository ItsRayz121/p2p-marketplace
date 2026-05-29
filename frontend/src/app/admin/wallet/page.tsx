'use client'
import { useState, useCallback, useEffect } from 'react'
import { adminApi } from '@/lib/api'
import { fmtDateTime } from '@/lib/fmt'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'

type WalletStatus = Awaited<ReturnType<typeof adminApi.getWalletStatus>>

const ORDER_STATUS_LABELS: Record<string, { label: string; variant: 'success' | 'warning' | 'danger' | 'outline' | 'default' }> = {
  created:          { label: 'Created',          variant: 'outline' },
  payment_pending:  { label: 'Payment Pending',  variant: 'warning' },
  payment_uploaded: { label: 'Proof Uploaded',   variant: 'warning' },
  payment_detected: { label: 'Payment Detected', variant: 'warning' },
  sending:          { label: 'Sending Gas',       variant: 'warning' },
  delivered:        { label: 'Delivered',         variant: 'success' },
  expired:          { label: 'Expired',           variant: 'outline' },
  failed:           { label: 'Failed',            variant: 'danger' },
  refund_pending:   { label: 'Refund Pending',    variant: 'danger' },
  refunded:         { label: 'Refunded',          variant: 'outline' },
}

const WALLET_STATUS_VARIANT: Record<string, 'success' | 'warning' | 'danger' | 'outline'> = {
  healthy:     'success',
  low:         'warning',
  paused:      'outline',
  unavailable: 'outline',
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <button
      onClick={copy}
      className="ml-2 px-2 py-0.5 text-xs rounded border border-border text-text-muted hover:text-text-primary hover:border-primary transition-colors"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  )
}

export default function WalletPage() {
  const [data, setData] = useState<WalletStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({})
  const [refreshErrors, setRefreshErrors] = useState<Record<string, string | null>>({})

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const result = await adminApi.getWalletStatus()
      setData(result)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load wallet status')
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshWalletBalance = useCallback(async (chain: string) => {
    setRefreshing((prev) => ({ ...prev, [chain]: true }))
    setRefreshErrors((prev) => ({ ...prev, [chain]: null }))
    try {
      const updated = await adminApi.refreshGasWalletBalance(chain)
      setData((prev) => prev ? {
        ...prev,
        hotWallets: prev.hotWallets.map((w) =>
          w.chain === chain ? { ...w, ...updated, lastFetchError: null } : w
        ),
      } : null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Refresh failed'
      setRefreshErrors((prev) => ({ ...prev, [chain]: msg }))
    } finally {
      setRefreshing((prev) => ({ ...prev, [chain]: false }))
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  if (loading) return <LoadingState message="Loading wallet status..." />
  if (error) return <ErrorState title={error} onRetry={fetchData} />
  if (!data) return null

  const { depositAddresses, hotWallets, orderSummary, configWarnings, mnemonicConfigured, evmHotWallet } = data
  const criticalWarnings = configWarnings.filter((w) => w.required)
  const totalOrders = Object.values(orderSummary).reduce((a, b) => a + b, 0)

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Platform Wallet Status</h1>
          <p className="text-text-muted text-sm mt-0.5">Deposit addresses, hot wallet health, and gas order summary</p>
        </div>
        <Button variant="secondary" size="sm" onClick={fetchData}>Refresh</Button>
      </div>

      {/* Mnemonic System Status */}
      {mnemonicConfigured ? (
        <div className="rounded-xl border border-success/20 bg-success/5 px-5 py-4 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-success font-semibold text-sm">Mnemonic wallet system active</span>
            <Badge variant="success" size="sm">HD Wallet</Badge>
          </div>
          <p className="text-xs text-text-muted">
            All private keys are derived from the encrypted BIP39 seed. Manual key env vars are not required.
          </p>
          {evmHotWallet && (
            <div className="pt-1 space-y-1">
              <p className="text-xs text-text-secondary font-medium">EVM hot wallet (ETH / BSC / Base / ARB / OP / Polygon / Avalanche):</p>
              <div className="flex items-center gap-1">
                <span className="font-mono text-xs text-text-secondary break-all">{evmHotWallet}</span>
                <CopyButton text={evmHotWallet} />
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-warning/20 bg-warning/5 px-5 py-4">
          <p className="text-warning font-semibold text-sm">Mnemonic wallet system not configured</p>
          <p className="text-xs text-text-muted mt-1">
            Running in legacy mode — using GAS_WALLET_PRIVATE_KEY_* env vars.
            Set GAS_MASTER_KEY + GAS_SEED_CIPHERTEXT in Railway to enable the mnemonic system.
          </p>
        </div>
      )}

      {/* Configuration Warnings */}
      {configWarnings.length > 0 && (
        <div className={`rounded-xl border p-4 space-y-2 ${criticalWarnings.length > 0 ? 'bg-danger/5 border-danger/20' : 'bg-warning/5 border-warning/20'}`}>
          <p className={`text-sm font-semibold ${criticalWarnings.length > 0 ? 'text-danger' : 'text-warning'}`}>
            {criticalWarnings.length > 0 ? `${criticalWarnings.length} required environment variable(s) missing` : 'Optional environment variables not configured'}
          </p>
          <ul className="space-y-1">
            {configWarnings.map((w) => (
              <li key={w.key} className="flex items-center gap-2 text-xs text-text-secondary">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${w.required ? 'bg-danger' : 'bg-warning'}`} />
                <code className="font-mono">{w.key}</code>
                <span className="text-text-muted">— {w.label}</span>
                {w.required && <Badge variant="danger" size="sm">Required</Badge>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Section 1: Deposit Addresses */}
      <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-semibold text-text-primary">Deposit Addresses</h2>
          <span className="text-text-muted text-sm">{depositAddresses.filter((a) => a.configured).length} / {depositAddresses.length} configured</span>
        </div>
        <div className="divide-y divide-border">
          {depositAddresses.map((addr) => (
            <div key={`${addr.coin}_${addr.network}`} className="px-5 py-4 flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="font-semibold text-text-primary">{addr.coin}</span>
                  <Badge variant="outline" size="sm">{addr.network}</Badge>
                  <Badge variant="outline" size="sm">{addr.chain}</Badge>
                  {addr.source && (
                    <Badge
                      variant={addr.source === 'db' ? 'default' : addr.source === 'mnemonic' ? 'success' : 'outline'}
                      size="sm"
                    >
                      {addr.source === 'db' ? 'DB' : addr.source === 'mnemonic' ? 'MNEMONIC' : 'ENV'}
                    </Badge>
                  )}
                </div>
                {addr.configured && addr.address ? (
                  <div className="flex items-center">
                    <p className="font-mono text-xs text-text-secondary break-all">{addr.address}</p>
                    <CopyButton text={addr.address} />
                  </div>
                ) : (
                  <p className="text-xs text-text-muted italic">Not configured — set env var or add via Config page</p>
                )}
                {addr.updatedAt && (
                  <p className="text-xs text-text-muted mt-1">DB updated {fmtDateTime(addr.updatedAt)}</p>
                )}
              </div>
              <Badge variant={addr.configured ? 'success' : 'danger'} size="sm">
                {addr.configured ? 'Configured' : 'Missing'}
              </Badge>
            </div>
          ))}
        </div>
      </div>

      {/* Section 2: Hot Wallet Status */}
      <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-semibold text-text-primary">Hot Wallet Status</h2>
          <span className="text-text-muted text-sm">{hotWallets.length} wallet(s)</span>
        </div>
        {hotWallets.length === 0 ? (
          <div className="px-5 py-8 text-center text-text-muted text-sm">
            No hot wallets configured. Add crypto gas fee chains via the Gas Fee page.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {hotWallets.map((w) => {
              const isRefreshing = refreshing[w.chain] ?? false
              const refreshError = refreshErrors[w.chain] ?? null
              const fetchError = w.lastFetchError ?? null
              return (
                <div key={w.chain} className="px-5 py-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="font-semibold text-text-primary">{w.chain}</span>
                        <Badge variant={WALLET_STATUS_VARIANT[w.status] ?? 'outline'} size="sm">
                          {w.status.charAt(0).toUpperCase() + w.status.slice(1)}
                        </Badge>
                        {!w.isActive && <Badge variant="outline" size="sm">Inactive</Badge>}
                      </div>
                      <div className="flex items-center gap-1 mb-1">
                        <p className="font-mono text-xs text-text-secondary">{w.address}</p>
                        <CopyButton text={w.address} />
                      </div>
                      <div className="flex items-center gap-4 text-xs text-text-muted">
                        <span>
                          Balance: {w.balance !== null ? `${w.balance.toLocaleString()} ${w.nativeSymbol}` : 'Not fetched'}
                          {w.balanceUsd != null && <span className="ml-1 text-text-muted">(${w.balanceUsd.toFixed(2)})</span>}
                        </span>
                        {w.alertThresholdUsd != null && <span>Alert at: ${w.alertThresholdUsd}</span>}
                        {w.pauseThresholdUsd != null && <span>Pause at: ${w.pauseThresholdUsd}</span>}
                      </div>
                      {w.balanceUsd != null && w.alertThresholdUsd != null && w.balanceUsd <= w.alertThresholdUsd && (
                        <p className={`text-xs mt-1 font-medium ${w.pauseThresholdUsd != null && w.balanceUsd <= w.pauseThresholdUsd ? 'text-danger' : 'text-warning'}`}>
                          {w.pauseThresholdUsd != null && w.balanceUsd <= w.pauseThresholdUsd
                            ? 'CRITICAL: Balance below pause threshold — gas delivery paused'
                            : 'WARNING: Balance below alert threshold — top up soon'}
                        </p>
                      )}
                      {fetchError && !refreshError && (
                        <p className="text-xs mt-1 text-danger font-mono break-all">
                          RPC error: {fetchError}
                        </p>
                      )}
                      {refreshError && (
                        <p className="text-xs mt-1 text-danger font-mono break-all">
                          Refresh failed: {refreshError}
                        </p>
                      )}
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => refreshWalletBalance(w.chain)}
                      disabled={isRefreshing}
                    >
                      {isRefreshing ? 'Refreshing…' : 'Refresh Balance'}
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Section 3: Gas Order Summary */}
      <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-semibold text-text-primary">Gas Order Summary</h2>
          <span className="text-text-muted text-sm">{totalOrders} total orders</span>
        </div>
        {totalOrders === 0 ? (
          <div className="px-5 py-8 text-center text-text-muted text-sm">No gas orders yet.</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 divide-x divide-y divide-border">
            {Object.entries(ORDER_STATUS_LABELS).map(([status, { label, variant }]) => {
              const count = orderSummary[status] ?? 0
              return (
                <div key={status} className="px-5 py-4 text-center">
                  <p className="text-2xl font-bold text-text-primary">{count}</p>
                  <Badge variant={variant} size="sm" className="mt-1">{label}</Badge>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Section 4: Info panel */}
      <div className="bg-surface rounded-xl border border-border px-5 py-4 text-xs text-text-muted space-y-1">
        <p className="font-semibold text-text-secondary text-sm mb-2">Notes</p>
        <p>• Deposit addresses shown here are what users send payment to. Private keys are never shown.</p>
        <p>• Hot wallet balances are cached from the last blockchain check (up to 30 min stale).</p>
        <p>• When the mnemonic system is active, EVM deposit addresses are derived automatically. No env var required for BSC / ETH.</p>
        <p>• To override a derived address, set the corresponding ENV var in Railway or add a DB entry via the Config page.</p>
        <p>• Gas order counts refresh on page load. Click Refresh to get the latest.</p>
      </div>
    </div>
  )
}
