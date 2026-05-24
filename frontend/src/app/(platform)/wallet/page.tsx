'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import { walletApi, marketplaceApi, userPaymentMethodsApi } from '@/lib/api'
import type { WalletBalance, Transaction, TrustedAddress, UserPaymentMethod } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { usePolling } from '@/hooks/usePolling'
import { CopyButton } from '@/components/ui/CopyButton'
import { Modal } from '@/components/ui/Modal'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { ConnectButton } from '@/components/wallet/ConnectButton'
import { ChainSwitcher } from '@/components/wallet/ChainSwitcher'
import { ConnectedBalances } from '@/components/wallet/ConnectedBalances'
import { RecentDeposits } from '@/components/wallet/RecentDeposits'
import { UI_CHAINS } from '@/lib/web3/chains'
import { PK_BANKS, getPaymentMethodColor } from '@/lib/pkPaymentMethods'
import { useAccount } from 'wagmi'

// ─── Types ────────────────────────────────────────────────────────────────────

interface DepositInfo {
  address: string
  network: string
  chainName?: string
  minConfirmations?: number
  memo?: string
}

// Networks PakSwap accepts for each coin. EVM networks share one HD-derived
// address per user; TRC20 uses the legacy shared platform address.
const COIN_NETWORKS: Record<string, string[]> = {
  USDT: ['ERC20', 'BEP20', 'POLYGON', 'ARBITRUM', 'OPTIMISM', 'TRC20'],
  USDC: ['ERC20', 'POLYGON', 'ARBITRUM', 'OPTIMISM', 'BASE'],
  ETH: ['ERC20', 'ARBITRUM', 'OPTIMISM', 'BASE'],
  BNB: ['BEP20'],
  POL: ['POLYGON'],
}

function networksFor(coin: string): string[] {
  return COIN_NETWORKS[coin.toUpperCase()] ?? ['TRC20']
}

function DisconnectedHint() {
  const { isConnected } = useAccount()
  if (isConnected) return null
  return (
    <p className="text-sm text-text-muted">
      Connect MetaMask, WalletConnect, or Coinbase Wallet to see your on-chain balances. Your PakSwap escrow balance below works without a connection.
    </p>
  )
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
  isOpen, onClose, coin, twoFaEnabled,
}: {
  isOpen: boolean
  onClose: () => void
  coin: string
  twoFaEnabled: boolean
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
  const [totpCode, setTotpCode] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [requiresEmailConfirm, setRequiresEmailConfirm] = useState(false)
  const [pendingWithdrawalId, setPendingWithdrawalId] = useState<string | null>(null)
  const [resending, setResending] = useState(false)
  const [resendMsg, setResendMsg] = useState<string | null>(null)

  // Generate idempotency key on open
  const idempotencyKey = useRef(crypto.randomUUID())
  useEffect(() => {
    if (isOpen) {
      idempotencyKey.current = crypto.randomUUID()
      setState((s) => ({ ...s, address: '', amount: '', fee: '0', feePkr: '0' }))
      setTotpCode('')
      setSuccess(false)
      setRequiresEmailConfirm(false)
      setPendingWithdrawalId(null)
      setResendMsg(null)
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
      const result = await walletApi.requestWithdrawal({
        coin,
        amount: state.amount,
        address: state.address,
        network: state.network,
        ...(twoFaEnabled ? { totpCode } : {}),
      })
      setShowConfirm(false)
      if (result.status === 'email_pending') {
        setRequiresEmailConfirm(true)
        setPendingWithdrawalId(result.id)
      } else {
        setSuccess(true)
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Withdrawal failed')
    } finally {
      setSubmitting(false)
    }
  }

  const handleResend = async () => {
    if (!pendingWithdrawalId) return
    setResending(true)
    setResendMsg(null)
    try {
      const r = await walletApi.resendWithdrawalConfirmation(pendingWithdrawalId)
      setResendMsg(`Confirmation email resent (${r.resendCount}/${r.maxResends}).`)
    } catch (err) {
      setResendMsg(err instanceof Error ? err.message : 'Resend failed')
    } finally {
      setResending(false)
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
        {requiresEmailConfirm ? (
          <div className="text-center py-6 space-y-3">
            <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center mx-auto text-blue-600 text-2xl">✉</div>
            <p className="text-sm font-medium text-text-primary">Check your email</p>
            <p className="text-xs text-text-muted">
              A confirmation email has been sent with Confirm and Cancel links. The link expires in 15 minutes.
            </p>
            <div className="bg-surface rounded-lg px-3 py-2 text-xs text-text-secondary space-y-1 text-left">
              <p>• Click <strong>Confirm</strong> in the email to proceed with your withdrawal.</p>
              <p>• Click <strong>Cancel</strong> to safely cancel it.</p>
              <p>• Do not share the link with anyone.</p>
            </div>
            {resendMsg && (
              <p className="text-xs text-text-muted">{resendMsg}</p>
            )}
            <div className="flex gap-2">
              <Button variant="secondary" fullWidth onClick={handleResend} disabled={resending}>
                {resending ? 'Sending…' : 'Resend Email'}
              </Button>
              <Button fullWidth onClick={onClose}>Done</Button>
            </div>
          </div>
        ) : success ? (
          <div className="text-center py-6 space-y-3">
            <div className="w-12 h-12 bg-warning/10 rounded-full flex items-center justify-center mx-auto text-warning text-2xl">⏳</div>
            <p className="text-sm font-medium text-text-primary">Withdrawal request submitted</p>
            <p className="text-xs text-text-muted">Your request is pending admin review. Funds have not been sent on-chain yet.</p>
            <div className="bg-surface rounded-lg px-3 py-2 text-xs text-text-secondary space-y-1 text-left">
              <p>• Funds are held securely while your request is reviewed.</p>
              <p>• You will be notified once approved and sent.</p>
              <p>• If rejected, your balance will be refunded automatically.</p>
            </div>
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

            {twoFaEnabled && (
              <div>
                <label className="block text-xs font-medium text-text-muted mb-1">2FA Code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary font-mono tracking-widest text-center"
                />
                <p className="text-xs text-text-muted mt-1">Enter the 6-digit code from your authenticator app.</p>
              </div>
            )}

            {submitError && (
              <p className="text-sm text-danger bg-danger/10 rounded-lg px-3 py-2">{submitError}</p>
            )}

            <Button
              fullWidth
              disabled={!state.address || !state.amount || state.loadingFee || !!state.feeError || (twoFaEnabled && totpCode.length !== 6)}
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
  const networks = networksFor(coin)
  const [network, setNetwork] = useState<string>(networks[0] ?? 'TRC20')
  const [info, setInfo] = useState<DepositInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Reset network when modal reopens with a different coin
  useEffect(() => {
    if (isOpen) setNetwork(networksFor(coin)[0] ?? 'TRC20')
  }, [isOpen, coin])

  const fetchAddress = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await walletApi.getDepositAddress(coin, network)
      setInfo({
        address: res.address,
        network: res.network,
        chainName: res.chainName,
        minConfirmations: res.minConfirmations,
        memo: res.memo,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load deposit address')
    } finally {
      setLoading(false)
    }
  }, [coin, network])

  useEffect(() => {
    if (!isOpen) return
    fetchAddress()
  }, [isOpen, fetchAddress])

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Deposit ${coin}`}>
      <div className="space-y-4">
        {/* Network selector */}
        <div>
          <label className="block text-xs font-medium text-text-muted mb-1">Network</label>
          <select
            value={network}
            onChange={(e) => setNetwork(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {networks.map((n) => <option key={n}>{n}</option>)}
          </select>
        </div>

        {loading ? (
          <div className="flex flex-col items-center py-8 gap-2">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <p className="text-xs text-text-muted">Loading deposit address…</p>
          </div>
        ) : error ? (
          <div className="bg-warning/10 border border-warning/20 rounded-lg px-3 py-3 text-center space-y-2">
            <p className="text-sm text-warning font-medium">{error}</p>
            <Button size="sm" variant="ghost" onClick={fetchAddress}>Retry</Button>
          </div>
        ) : info ? (
          <>
            <div className="bg-surface rounded-xl p-4 text-center">
              <p className="text-xs text-text-muted mb-2">
                Network: <span className="font-medium text-text-primary">{info.chainName ?? info.network}</span>
              </p>
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
              Only send {coin} on {info.chainName ?? info.network}. Sending other tokens or using a different chain may result in permanent loss.
            </p>
            {typeof info.minConfirmations === 'number' && (
              <div className="bg-primary/5 border border-primary/20 rounded-lg px-3 py-2 text-xs text-text-secondary text-center">
                Waiting for {info.minConfirmations} blockchain confirmations before your PakSwap balance is credited. Pending deposits appear in your transaction history.
              </div>
            )}
            {UI_CHAINS.some((c) => c.networkLabel === info.network) && (
              <p className="text-xs text-text-muted text-center">
                The same address is valid across every EVM network we support — pick the one you're sending from above.
              </p>
            )}
          </>
        ) : null}
      </div>
    </Modal>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

// ─── TrustedAddressesSection ──────────────────────────────────────────────────

function TrustedAddressesSection({ twoFaEnabled }: { twoFaEnabled: boolean }) {
  const [addresses, setAddresses] = useState<TrustedAddress[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ coin: 'USDT', network: 'ERC20', address: '', label: '' })
  const [totpCode, setTotpCode] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await walletApi.getTrustedAddresses()
      setAddresses(res)
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const handleAdd = async () => {
    if (!form.address || !form.label) { setFormError('Address and label are required'); return }
    if (twoFaEnabled && totpCode.length !== 6) { setFormError('Enter your 6-digit 2FA code'); return }
    setAdding(true)
    setFormError(null)
    try {
      await walletApi.addTrustedAddress({ ...form, ...(twoFaEnabled ? { totpCode } : {}) })
      setShowForm(false)
      setForm({ coin: 'USDT', network: 'ERC20', address: '', label: '' })
      setTotpCode('')
      await load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to add address')
    } finally { setAdding(false) }
  }

  const handleRemove = async (id: string) => {
    try {
      await walletApi.removeTrustedAddress(id)
      await load()
    } catch { /* ignore */ }
  }

  const isActive = (a: TrustedAddress) => new Date(a.activatesAt) <= new Date()
  const hoursLeft = (a: TrustedAddress) => {
    const ms = new Date(a.activatesAt).getTime() - Date.now()
    if (ms <= 0) return null
    const h = Math.ceil(ms / 3_600_000)
    return `${h}h`
  }

  if (loading) return null

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Trusted Withdrawal Addresses</h2>
          <p className="text-xs text-text-muted">Whitelisted addresses skip the NEW_WALLET risk flag. New addresses have a 24h activation delay.</p>
        </div>
        <Button size="sm" onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : '+ Add'}</Button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-border p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Coin</label>
              <select
                value={form.coin}
                onChange={(e) => {
                  const coin = e.target.value
                  const firstNetwork = networksFor(coin)[0] ?? 'ERC20'
                  setForm((f) => ({ ...f, coin, network: firstNetwork }))
                }}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary"
              >
                {Object.keys(COIN_NETWORKS).map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Network</label>
              <select
                value={form.network}
                onChange={(e) => setForm((f) => ({ ...f, network: e.target.value }))}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary"
              >
                {networksFor(form.coin).map((n) => <option key={n}>{n}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Address</label>
            <input value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} placeholder="Full wallet address" className="w-full px-3 py-2 text-sm font-mono border border-border rounded-lg" />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Label</label>
            <input value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} placeholder="e.g. My Binance Wallet" className="w-full px-3 py-2 text-sm border border-border rounded-lg" />
          </div>
          {twoFaEnabled && (
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">2FA Code</label>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary font-mono tracking-widest text-center"
              />
            </div>
          )}
          {formError && <p className="text-xs text-danger">{formError}</p>}
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">
            This address will have a 24-hour activation delay before it can be used for withdrawals.
          </div>
          <Button fullWidth loading={adding} onClick={handleAdd}>Add Trusted Address</Button>
        </div>
      )}

      {addresses.length === 0 ? (
        <div className="bg-white rounded-xl border border-border p-4 text-center text-sm text-text-muted">
          No trusted addresses yet. Add one to reduce friction on future withdrawals.
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-border divide-y divide-border overflow-hidden">
          {addresses.map((a) => {
            const active = isActive(a)
            const wait = hoursLeft(a)
            return (
              <div key={a.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-primary">{a.label}</span>
                    <span className="text-xs text-text-muted">{a.coin} · {a.network}</span>
                    {active ? (
                      <span className="px-1.5 py-0.5 bg-emerald-100 text-emerald-700 text-xs rounded-full">Active</span>
                    ) : (
                      <span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 text-xs rounded-full">Activates in {wait}</span>
                    )}
                  </div>
                  <p className="font-mono text-xs text-text-muted truncate">{a.address}</p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => handleRemove(a.id)} className="text-danger hover:text-danger flex-shrink-0">
                  Remove
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

// ─── Payment Methods Section ──────────────────────────────────────────────────

const MOBILE_TYPE_MAP: Record<string, string> = {
  JazzCash: 'jazzcash',
  Easypaisa: 'easypaisa',
  SadaPay: 'sadapay',
  NayaPay: 'nayapay',
}

const PM_CATEGORIES = [
  {
    key: 'branchless',
    label: 'Branchless Wallets',
    description: 'Mobile wallet accounts',
    methods: ['JazzCash', 'Easypaisa'],
  },
  {
    key: 'emis',
    label: 'EMIs / Fintechs',
    description: 'Digital banking apps',
    methods: ['SadaPay', 'NayaPay'],
  },
  {
    key: 'banks',
    label: 'Commercial Banks',
    description: 'Bank account & IBAN',
    methods: PK_BANKS,
  },
] as const

type PmCategory = typeof PM_CATEGORIES[number]['key']

function pmTypeLabel(type: string, bankName?: string | null): string {
  if (type === 'bank_transfer') return bankName ?? 'Bank Transfer'
  const entry = Object.entries(MOBILE_TYPE_MAP).find(([, v]) => v === type)
  return entry ? entry[0] : type
}

function PaymentMethodsSection() {
  const [methods, setMethods] = useState<UserPaymentMethod[]>([])
  const [pmLoading, setPmLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [removeId, setRemoveId] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  // Step 1: category, Step 2: selected method within category, Step 3: fields
  const [category, setCategory] = useState<PmCategory | null>(null)
  const [selectedMethod, setSelectedMethod] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [accountName, setAccountName] = useState('')
  const [mobileNumber, setMobileNumber] = useState('')
  const [ibanNumber, setIbanNumber] = useState('')
  const [accountNumber, setAccountNumber] = useState('')

  const isBankCategory = category === 'banks'
  const pmType = selectedMethod
    ? (MOBILE_TYPE_MAP[selectedMethod] ?? 'bank_transfer')
    : null

  useEffect(() => {
    userPaymentMethodsApi.getAll()
      .then(setMethods)
      .catch(() => {})
      .finally(() => setPmLoading(false))
  }, [])

  const resetForm = () => {
    setCategory(null)
    setSelectedMethod(null)
    setDisplayName('')
    setAccountName('')
    setMobileNumber('')
    setIbanNumber('')
    setAccountNumber('')
    setFormError(null)
    setShowForm(false)
  }

  const handleAdd = async () => {
    if (!pmType || !selectedMethod) { setFormError('Select a payment method'); return }
    if (!displayName.trim() || !accountName.trim()) {
      setFormError('Display name and account name are required')
      return
    }
    if (!isBankCategory && !mobileNumber.trim()) {
      setFormError('Mobile number is required')
      return
    }
    if (isBankCategory && !ibanNumber.trim()) {
      setFormError('IBAN is required for bank transfer')
      return
    }
    setAdding(true)
    setFormError(null)
    try {
      const method = await userPaymentMethodsApi.add({
        type: pmType as UserPaymentMethod['type'],
        displayName: displayName.trim(),
        accountName: accountName.trim(),
        ...(mobileNumber.trim() ? { mobileNumber: mobileNumber.trim() } : {}),
        ...(isBankCategory ? { bankName: selectedMethod } : {}),
        ...(ibanNumber.trim() ? { ibanNumber: ibanNumber.trim() } : {}),
        ...(accountNumber.trim() ? { accountNumber: accountNumber.trim() } : {}),
      })
      setMethods((prev) => [method, ...prev])
      resetForm()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to add payment method')
    } finally {
      setAdding(false)
    }
  }

  const handleRemove = async (id: string) => {
    try {
      await userPaymentMethodsApi.remove(id)
      setMethods((prev) => prev.filter((m) => m.id !== id))
    } catch { /* silently fail */ }
    finally { setRemoveId(null) }
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold text-text-primary">PKR Payment Methods</h2>
          <p className="text-xs text-text-muted mt-0.5">Saved accounts used when receiving PKR in trades</p>
        </div>
        {!showForm && (
          <Button size="sm" variant="secondary" onClick={() => setShowForm(true)}>
            + Add Method
          </Button>
        )}
      </div>

      {showForm && (
        <div className="bg-white border border-border rounded-xl p-4 mb-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-text-primary">Add Payment Method</h3>
            <button onClick={resetForm} className="text-xs text-text-muted hover:text-text-primary">Cancel</button>
          </div>

          {formError && (
            <div className="text-xs text-danger bg-danger/10 border border-danger/20 rounded-lg px-3 py-2">
              {formError}
            </div>
          )}

          {/* Step 1: Category */}
          <div>
            <p className="text-xs font-medium text-text-muted mb-2">Select category</p>
            <div className="grid grid-cols-3 gap-2">
              {PM_CATEGORIES.map((cat) => (
                <button
                  key={cat.key}
                  onClick={() => { setCategory(cat.key as PmCategory); setSelectedMethod(null) }}
                  className={`text-left px-3 py-2.5 rounded-lg border text-sm transition-colors ${
                    category === cat.key
                      ? 'border-primary bg-primary/5 text-primary font-medium'
                      : 'border-border bg-white text-text-primary hover:border-primary/50'
                  }`}
                >
                  <div className="font-medium text-xs leading-tight">{cat.label}</div>
                  <div className="text-xs text-text-muted mt-0.5 leading-tight">{cat.description}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Step 2: Method picker within category */}
          {category && (
            <div>
              <p className="text-xs font-medium text-text-muted mb-2">
                {isBankCategory ? 'Select bank' : 'Select method'}
              </p>
              {isBankCategory ? (
                <select
                  value={selectedMethod ?? ''}
                  onChange={(e) => setSelectedMethod(e.target.value || null)}
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="">— Choose a bank —</option>
                  {PK_BANKS.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {PM_CATEGORIES.find((c) => c.key === category)!.methods.map((m) => (
                    <button
                      key={m}
                      onClick={() => setSelectedMethod(m)}
                      className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
                        selectedMethod === m
                          ? 'border-primary bg-primary text-white'
                          : `border-border ${getPaymentMethodColor(m)} hover:border-primary/50`
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Step 3: Fields — shown once a method is selected */}
          {selectedMethod && (
            <div className="space-y-3 pt-1 border-t border-border">
              <div className="flex items-center gap-2">
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${getPaymentMethodColor(isBankCategory ? '' : selectedMethod)}`}>
                  {selectedMethod}
                </span>
                <span className="text-xs text-text-muted">account details</span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-text-muted mb-1">Display Name</label>
                  <input
                    type="text"
                    placeholder={`e.g. My ${selectedMethod}`}
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="block text-xs text-text-muted mb-1">Account Name</label>
                  <input
                    type="text"
                    placeholder="Name on the account"
                    value={accountName}
                    onChange={(e) => setAccountName(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
              </div>

              {!isBankCategory && (
                <div>
                  <label className="block text-xs text-text-muted mb-1">Mobile Number</label>
                  <input
                    type="tel"
                    placeholder="03xx-xxxxxxx"
                    value={mobileNumber}
                    onChange={(e) => setMobileNumber(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
              )}

              {isBankCategory && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-text-muted mb-1">IBAN</label>
                    <input
                      type="text"
                      placeholder="PK00XXXX..."
                      value={ibanNumber}
                      onChange={(e) => setIbanNumber(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-text-muted mb-1">Account Number <span className="text-text-muted">(optional)</span></label>
                    <input
                      type="text"
                      placeholder="Account number"
                      value={accountNumber}
                      onChange={(e) => setAccountNumber(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  </div>
                </div>
              )}

              <Button size="sm" loading={adding} onClick={handleAdd}>Save Payment Method</Button>
            </div>
          )}
        </div>
      )}

      {pmLoading ? (
        <div className="text-sm text-text-muted py-4 text-center">Loading...</div>
      ) : methods.length === 0 ? (
        <div className="bg-white border border-border rounded-xl px-4 py-8 text-center">
          <p className="text-sm text-text-muted">No payment methods saved yet.</p>
          <p className="text-xs text-text-muted mt-1">Add your JazzCash, Easypaisa, or bank account so buyers know how to pay you.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-border divide-y divide-border overflow-hidden">
          {methods.map((m) => (
            <div key={m.id} className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-text-primary">{m.displayName}</span>
                  <span className={`px-1.5 py-0.5 text-xs rounded-full ${getPaymentMethodColor(pmTypeLabel(m.type))}`}>
                    {pmTypeLabel(m.type, m.bankName)}
                  </span>
                </div>
                <p className="text-xs text-text-muted mt-0.5">
                  {m.accountName}
                  {m.mobileNumber ? ` · ${m.mobileNumber}` : ''}
                  {m.ibanNumber ? ` · ${m.ibanNumber}` : ''}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRemoveId(m.id)}
                className="text-danger hover:text-danger flex-shrink-0"
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}

      {removeId && (
        <ConfirmModal
          isOpen
          title="Remove payment method"
          description="This will remove the payment method from your profile. Active trades using it are unaffected."
          confirmLabel="Remove"
          confirmVariant="danger"
          onConfirm={() => handleRemove(removeId)}
          onClose={() => setRemoveId(null)}
        />
      )}
    </section>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function WalletPage() {
  const { user } = useAuth()
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

  // Show contextual status labels — withdrawal "pending" means admin review, not on-chain pending
  const txStatusLabel = (tx: Transaction): string => {
    if (tx.type === 'withdrawal' && tx.status === 'pending') return 'Pending Review'
    if (tx.type === 'withdrawal' && tx.status === 'completed') return 'Sent'
    if (tx.status === 'failed') return 'Failed / Refunded'
    return tx.status.charAt(0).toUpperCase() + tx.status.slice(1)
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

  // Compute withdrawal lock state from the user object
  const wdLockActive = user?.withdrawalLockedUntil
    ? new Date(user.withdrawalLockedUntil) > new Date()
    : false
  const wdLockUntil = user?.withdrawalLockedUntil
    ? new Date(user.withdrawalLockedUntil).toLocaleString()
    : null

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 pb-24 lg:pb-6 space-y-8">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold text-text-primary">Wallet</h1>
        <ConnectButton />
      </div>

      {/* ── Withdrawal security lock banner ── */}
      {wdLockActive && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl px-4 py-3 flex items-start gap-3">
          <span className="text-amber-500 text-xl mt-0.5">🔒</span>
          <div>
            <p className="text-sm font-semibold text-amber-800">Withdrawals Temporarily Locked</p>
            <p className="text-xs text-amber-700 mt-0.5">
              Due to a recent {user?.withdrawalLockReason ?? 'security change'}, withdrawals are locked until <strong>{wdLockUntil}</strong>. Deposits and trading are unaffected.
            </p>
          </div>
        </div>
      )}

      {/* ── Connected wallet ── */}
      <section className="space-y-4 bg-white rounded-xl border border-border p-5">
        <h2 className="text-base font-semibold text-text-primary">Connected wallet</h2>
        <ChainSwitcher />
        <ConnectedBalances />
        <DisconnectedHint />
      </section>

      {/* ── PakSwap internal balances ── */}
      <section>
        <h2 className="text-base font-semibold text-text-primary mb-1">PakSwap balance</h2>
        <p className="text-xs text-text-muted mb-3">Held in escrow on PakSwap — backs your P2P trades. Deposit on-chain to top up; withdrawals are reviewed by admins.</p>
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

      <RecentDeposits />

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
                    <Badge variant={txStatusVariant(tx.status)} size="sm">{txStatusLabel(tx)}</Badge>
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

      {/* ── Trusted addresses ── */}
      <TrustedAddressesSection twoFaEnabled={user?.twoFaEnabled ?? false} />

      {/* ── PKR Payment Methods ── */}
      <div id="payment-methods">
        <PaymentMethodsSection />
      </div>

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
          twoFaEnabled={user?.twoFaEnabled ?? false}
        />
      )}
    </div>
  )
}
