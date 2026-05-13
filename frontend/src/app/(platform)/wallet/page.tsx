'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import { walletApi, marketplaceApi } from '@/lib/api'
import type { WalletBalance, Transaction } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { CopyButton } from '@/components/ui/CopyButton'
import { Modal } from '@/components/ui/Modal'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'

// ─── Types ────────────────────────────────────────────────────────────────────

interface DepositInfo {
  address: string
  network: string
  memo?: string
}

interface WithdrawState {
  address: string
  amount: string
  network: string
  fee: string
  feePkr: string
  loadingFee: boolean
  feeError: string | null
}

interface PaymentMethod {
  id: string
  type: string
  details: string
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return new Date(dateStr).toLocaleDateString()
}

// ─── WithdrawModal ────────────────────────────────────────────────────────────

function WithdrawModal({
  isOpen, onClose, coin,
}: {
  isOpen: boolean
  onClose: () => void
  coin: string
}) {
  const [state, setState] = useState<WithdrawState>({
    address: '',
    amount: '',
    network: coin === 'USDT' ? 'TRC20' : coin === 'BTC' ? 'Bitcoin' : coin === 'ETH' ? 'Ethereum' : 'BEP20',
    fee: '0',
    feePkr: '0',
    loadingFee: false,
    feeError: null,
  })
  const [showConfirm, setShowConfirm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  // Generate idempotency key on open
  const idempotencyKey = useRef(crypto.randomUUID())
  useEffect(() => {
    if (isOpen) {
      idempotencyKey.current = crypto.randomUUID()
      setState((s) => ({ ...s, address: '', amount: '', fee: '0', feePkr: '0' }))
      setSuccess(false)
      setSubmitError(null)
    }
  }, [isOpen])

  // Refresh fee every 30s
  const fetchFee = useCallback(async () => {
    if (!state.network || !coin) return
    setState((s) => ({ ...s, loadingFee: true, feeError: null }))
    try {
      const liveFee = await walletApi.getLiveFee(coin, state.network)
      const networkFee = liveFee?.networkFee ?? '0'

      // Best-effort PKR conversion — if the rate call fails we still show
      // the fee in coin units instead of breaking the modal.
      let feePkr = '0'
      try {
        const rate = await marketplaceApi.getRate(coin)
        const feeNum = parseFloat(networkFee)
        if (Number.isFinite(feeNum) && Number.isFinite(rate?.rate)) {
          feePkr = (feeNum * rate.rate).toFixed(2)
        }
      } catch { /* leave feePkr as '0' */ }

      setState((s) => ({ ...s, fee: networkFee, feePkr, loadingFee: false, feeError: null }))
    } catch {
      setState((s) => ({ ...s, fee: '0', feePkr: '0', feeError: 'Fee unavailable', loadingFee: false }))
    }
  }, [coin, state.network])

  useEffect(() => { if (isOpen) fetchFee() }, [isOpen, fetchFee])
  usePolling(fetchFee, 30_000, isOpen)

  const amountNum = parseFloat(state.amount)
  const feeNum = parseFloat(state.fee || '0')
  const total = state.amount && Number.isFinite(amountNum)
    ? (amountNum + (Number.isFinite(feeNum) ? feeNum : 0)).toFixed(6)
    : '—'

  const handleSubmit = async () => {
    setSubmitting(true)
    setSubmitError(null)
    try {
      await walletApi.requestWithdrawal({
        coin,
        amount: state.amount,
        address: state.address,
        network: state.network,
      })
      setSuccess(true)
      setShowConfirm(false)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Withdrawal failed')
    } finally {
      setSubmitting(false)
    }
  }

  const NETWORKS: Record<string, string[]> = {
    USDT: ['TRC20', 'ERC20', 'BEP20'],
    BTC: ['Bitcoin'],
    ETH: ['Ethereum'],
    BNB: ['BEP20'],
    TRX: ['TRON'],
  }
  const networks = NETWORKS[coin] ?? ['Mainnet']

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} title={`Withdraw ${coin}`}>
        {success ? (
          <div className="text-center py-6 space-y-3">
            <div className="w-12 h-12 bg-success/10 rounded-full flex items-center justify-center mx-auto text-success text-2xl">✓</div>
            <p className="text-sm font-medium text-text-primary">Withdrawal requested!</p>
            <p className="text-xs text-text-muted">Your withdrawal is being processed. Check your transaction history for updates.</p>
            <Button fullWidth onClick={onClose}>Done</Button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Network */}
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Network</label>
              <select
                value={state.network}
                onChange={(e) => setState((s) => ({ ...s, network: e.target.value }))}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary"
              >
                {networks.map((n) => <option key={n}>{n}</option>)}
              </select>
              <p className="text-xs text-text-muted mt-1">Make sure the recipient address supports this network.</p>
            </div>

            {/* Address */}
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Recipient Address</label>
              <input
                type="text"
                value={state.address}
                onChange={(e) => setState((s) => ({ ...s, address: e.target.value }))}
                placeholder={`Enter ${state.network} address`}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary font-mono"
              />
            </div>

            {/* Amount */}
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Amount ({coin})</label>
              <input
                type="number"
                value={state.amount}
                onChange={(e) => setState((s) => ({ ...s, amount: e.target.value }))}
                placeholder="0.00"
                className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            {/* Fee display */}
            <div className="bg-surface rounded-lg p-3 space-y-2 text-sm">
              <div className="flex justify-between items-center">
                <span className="text-text-muted">Network Fee</span>
                <span className="font-medium text-text-primary flex items-center gap-2">
                  {state.loadingFee ? (
                    <>
                      <span className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                      <span className="text-xs text-text-muted">Loading…</span>
                    </>
                  ) : state.feeError ? (
                    <button
                      type="button"
                      onClick={fetchFee}
                      className="text-xs text-warning hover:underline"
                    >
                      Fee unavailable — retry
                    </button>
                  ) : (
                    <>
                      {state.fee} {coin}
                      {parseFloat(state.feePkr) > 0 && (
                        <span className="text-text-muted">
                          {' '}(≈ PKR {parseFloat(state.feePkr).toLocaleString()})
                        </span>
                      )}
                    </>
                  )}
                </span>
              </div>
              <div className="flex justify-between border-t border-border pt-2">
                <span className="text-text-muted font-medium">Total Deduction</span>
                <span className="font-bold text-text-primary">
                  {state.feeError || state.loadingFee ? '—' : total} {coin}
                </span>
              </div>
            </div>

            {submitError && (
              <p className="text-sm text-danger bg-danger/10 rounded-lg px-3 py-2">{submitError}</p>
            )}

            <Button
              fullWidth
              disabled={!state.address || !state.amount || state.loadingFee || !!state.feeError}
              onClick={() => setShowConfirm(true)}
            >
              {state.loadingFee ? 'Loading fee…' : state.feeError ? 'Fee unavailable' : 'Continue'}
            </Button>
          </div>
        )}
      </Modal>

      <ConfirmModal
        isOpen={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={handleSubmit}
        title="Confirm Withdrawal"
        description={`Send ${state.amount} ${coin} to ${state.address.slice(0, 12)}...${state.address.slice(-6)} on ${state.network} network. Total deduction: ${total} ${coin}.`}
        confirmLabel="Confirm Withdrawal"
        confirmVariant="danger"
      />
    </>
  )
}

// ─── Deposit Modal ────────────────────────────────────────────────────────────

function DepositModal({
  isOpen, onClose, coin,
}: {
  isOpen: boolean
  onClose: () => void
  coin: string
}) {
  const [info, setInfo] = useState<DepositInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    setLoading(true)
    walletApi.getDepositAddress(coin)
      .then(setInfo)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [isOpen, coin])

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Deposit ${coin}`}>
      {loading ? (
        <div className="flex justify-center py-6"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>
      ) : error ? (
        <p className="text-sm text-danger text-center py-4">{error}</p>
      ) : info ? (
        <div className="space-y-4">
          <div className="bg-surface rounded-xl p-4 text-center">
            <p className="text-xs text-text-muted mb-2">Network: {info.network}</p>
            <div className="w-32 h-32 bg-white border border-border rounded-lg flex items-center justify-center mx-auto mb-3">
              <span className="text-xs text-text-muted text-center px-2">QR code for<br />{coin} address</span>
            </div>
            <p className="font-mono text-xs text-text-primary break-all">{info.address}</p>
          </div>

          <div className="flex items-center gap-2">
            <input
              readOnly
              value={info.address}
              className="flex-1 px-3 py-2 text-xs font-mono border border-border rounded-lg bg-white"
            />
            <CopyButton text={info.address} />
          </div>

          {info.memo && (
            <div className="bg-warning/10 border border-warning/20 rounded-lg px-3 py-2">
              <p className="text-xs font-medium text-warning">Memo Required</p>
              <div className="flex items-center gap-2 mt-1">
                <p className="font-mono text-sm text-text-primary flex-1">{info.memo}</p>
                <CopyButton text={info.memo} />
              </div>
            </div>
          )}

          <p className="text-xs text-text-muted text-center">
            Only send {coin} on {info.network} network. Sending other tokens may result in permanent loss.
          </p>
        </div>
      ) : null}
    </Modal>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function WalletPage() {
  const [balances, setBalances] = useState<WalletBalance[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [txTotal, setTxTotal] = useState(0)
  const [txPage, setTxPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [txLoading, setTxLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [depositCoin, setDepositCoin] = useState<string | null>(null)
  const [withdrawCoin, setWithdrawCoin] = useState<string | null>(null)

  const fetchBalances = useCallback(async () => {
    try {
      const res = await walletApi.getBalances()
      setBalances(res.balances)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load balances')
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchTransactions = useCallback(async (p = 1) => {
    setTxLoading(true)
    try {
      const res = await walletApi.getTransactions({ page: p, limit: 20 })
      setTransactions((prev) => (p === 1 ? res.transactions : [...prev, ...res.transactions]))
      setTxTotal(res.total)
    } catch { /* silently fail */ }
    finally { setTxLoading(false) }
  }, [])

  useEffect(() => {
    fetchBalances()
    fetchTransactions(1)
  }, [fetchBalances, fetchTransactions])

  usePolling(fetchBalances, 30_000, !loading)

  const txStatusVariant = (s: string): 'success' | 'warning' | 'danger' | 'default' => {
    if (s === 'completed') return 'success'
    if (s === 'pending') return 'warning'
    if (s === 'failed') return 'danger'
    return 'default'
  }

  const txTypeIcon: Record<string, string> = {
    deposit: '↓',
    withdrawal: '↑',
    trade_lock: '🔒',
    trade_release: '🔓',
    fee: '💸',
    referral_bonus: '🎁',
  }

  if (loading) return <LoadingState message="Loading wallet..." />
  if (error) return <ErrorState title={error} onRetry={fetchBalances} />

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 pb-24 lg:pb-6 space-y-8">
      <h1 className="text-2xl font-bold text-text-primary">Wallet</h1>

      {/* ── Balances ── */}
      <section>
        <h2 className="text-base font-semibold text-text-primary mb-3">Balances</h2>
        {balances.length === 0 ? (
          <EmptyState title="No balances" description="Make a deposit to get started" />
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {balances.map((b) => (
              <div key={b.coin} className="bg-white rounded-xl border border-border p-5">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-9 h-9 rounded-full bg-primary/10 text-primary text-sm font-bold flex items-center justify-center">
                    {b.coin.slice(0, 2)}
                  </div>
                  <span className="font-semibold text-text-primary">{b.coin}</span>
                </div>
                <div className="space-y-1 mb-4">
                  <div className="flex justify-between text-sm">
                    <span className="text-text-muted">Available</span>
                    <span className="font-bold text-text-primary">{parseFloat(b.available).toFixed(6)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-text-muted">Locked</span>
                    <span className="text-text-secondary">{parseFloat(b.locked).toFixed(6)}</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    fullWidth
                    onClick={() => setDepositCoin(b.coin)}
                  >
                    Deposit
                  </Button>
                  <Button
                    size="sm"
                    fullWidth
                    onClick={() => setWithdrawCoin(b.coin)}
                  >
                    Withdraw
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Transaction history ── */}
      <section>
        <h2 className="text-base font-semibold text-text-primary mb-3">Transactions</h2>
        {transactions.length === 0 ? (
          <EmptyState title="No transactions" description="Your transaction history will appear here" />
        ) : (
          <div className="bg-white rounded-xl border border-border overflow-hidden">
            <div className="divide-y divide-border">
              {transactions.map((tx) => (
                <div key={tx.id} className="flex items-center gap-4 px-4 py-3">
                  <div className="w-8 h-8 rounded-full bg-surface flex items-center justify-center text-sm flex-shrink-0">
                    {txTypeIcon[tx.type] ?? '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary capitalize">
                      {tx.type.replace(/_/g, ' ')}
                    </p>
                    <p className="text-xs text-text-muted">{timeAgo(tx.createdAt)}</p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className={`text-sm font-bold ${tx.type === 'withdrawal' || tx.type === 'fee' ? 'text-danger' : 'text-success'}`}>
                      {tx.type === 'withdrawal' || tx.type === 'fee' ? '-' : '+'}{parseFloat(tx.amount).toFixed(4)} {tx.coin}
                    </p>
                    <Badge variant={txStatusVariant(tx.status)} size="sm">{tx.status}</Badge>
                  </div>
                </div>
              ))}
            </div>

            {transactions.length < txTotal && (
              <div className="px-4 py-3 border-t border-border text-center">
                <Button
                  variant="ghost"
                  size="sm"
                  loading={txLoading}
                  onClick={() => {
                    const next = txPage + 1
                    setTxPage(next)
                    fetchTransactions(next)
                  }}
                >
                  Load more
                </Button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Deposit modal */}
      {depositCoin && (
        <DepositModal
          isOpen={!!depositCoin}
          onClose={() => setDepositCoin(null)}
          coin={depositCoin}
        />
      )}

      {/* Withdraw modal */}
      {withdrawCoin && (
        <WithdrawModal
          isOpen={!!withdrawCoin}
          onClose={() => setWithdrawCoin(null)}
          coin={withdrawCoin}
        />
      )}
    </div>
  )
}
