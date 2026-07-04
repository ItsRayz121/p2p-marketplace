'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import { walletApi, marketplaceApi, userPaymentMethodsApi, ctmApi } from '@/lib/api'
import type { WalletBalance, Transaction, TrustedAddress, UserPaymentMethod, SavedDeliveryAddress } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { usePolling } from '@/hooks/usePolling'
import { QRCodeSVG } from 'qrcode.react'
import { CopyButton } from '@/components/ui/CopyButton'
import { Modal } from '@/components/ui/Modal'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { ConfirmRemoveModal } from '@/components/ui/ConfirmRemoveModal'
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
import { COIN_NETWORKS, networksFor } from '@/lib/wallet/coinNetworks'
import { fmtPakDateTime } from '@/lib/fmt'
import { PK_BANKS, getPaymentMethodColor } from '@/lib/pkPaymentMethods'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { BankSelect } from '@/components/ui/BankSelect'
import { validateAddressForNetwork } from '@/lib/addressValidation'
import { useAccount } from 'wagmi'
import { ArrowUpDown, Lock, Clock, AlertTriangle, Pencil, Eye, EyeOff, Trash2 } from 'lucide-react'
import { toast } from '@/lib/toast'

// ─── Types ────────────────────────────────────────────────────────────────────

interface DepositInfo {
  address: string
  network: string
  chainName?: string
  minConfirmations?: number
  memo?: string
}

function DisconnectedHint() {
  const { isConnected } = useAccount()
  if (isConnected) return null
  return (
    <p className="text-sm text-text-muted">
      Connect MetaMask, WalletConnect, or Coinbase Wallet to see your on-chain balances. Your RupChain balance below works without a connection.
    </p>
  )
}

interface WithdrawState {
  address: string
  amount: string
  network: string
  fee: string       // total fee = gasFee + platformFee
  gasFee: string
  platformFee: string
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

function fmtTxDateTime(dateStr: string): string {
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return timeAgo(dateStr)
  return d.toLocaleString('en-PK', {
    timeZone: 'Asia/Karachi',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const SUPPORTED_PLATFORM_NETWORKS = new Set(['BEP20', 'APTOS', 'Aptos'])

// EVM-style networks share the 0x…40-hex address format.
const EVM_WITHDRAW_NETWORKS = new Set(['BEP20', 'POLYGON', 'ARBITRUM', 'OPTIMISM', 'BASE', 'ERC20'])

// Non-blocking client-side sanity check for the recipient address. The backend
// validates authoritatively; this only catches the dangerous obvious mistakes
// (e.g. pasting a TRON address while BEP20 is selected) before funds are sent.
function withdrawAddressWarning(address: string, network: string): string | null {
  const a = address.trim()
  if (!a) return null
  if (EVM_WITHDRAW_NETWORKS.has(network)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return `This doesn't look like a valid ${network} address — it should start with 0x and be 42 characters. Double-check the network.`
  } else if (network === 'Aptos') {
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(a)) return `This doesn't look like a valid Aptos address — it should start with 0x.`
  } else if (network === 'TRC20') {
    if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return `This doesn't look like a valid TRC20 address — it should start with T and be 34 characters.`
  }
  // Bitcoin / unrecognised networks: formats vary too much to safely flag.
  return null
}

// ─── WithdrawModal ────────────────────────────────────────────────────────────

function WithdrawModal({
  isOpen, onClose, coin, twoFaEnabled, onSuccess, availableBalance, defaultNetwork,
}: {
  isOpen: boolean
  onClose: () => void
  coin: string
  twoFaEnabled: boolean
  onSuccess?: () => void
  availableBalance?: number
  defaultNetwork?: string
}) {
  const [state, setState] = useState<WithdrawState>({
    address: '',
    amount: '',
    network: defaultNetwork ?? networksFor(coin)[0] ?? 'TRC20',
    fee: '0',
    gasFee: '0',
    platformFee: '0',
    feePkr: '0',
    loadingFee: false,
    feeError: null,
  })
  const [totpCode, setTotpCode] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [autoSent, setAutoSent] = useState(false)
  const [requiresEmailConfirm, setRequiresEmailConfirm] = useState(false)
  const [pendingWithdrawalId, setPendingWithdrawalId] = useState<string | null>(null)
  const [resending, setResending] = useState(false)
  const [resendMsg, setResendMsg] = useState<string | null>(null)

  // Generate idempotency key on open
  const idempotencyKey = useRef(crypto.randomUUID())
  useEffect(() => {
    if (isOpen) {
      idempotencyKey.current = crypto.randomUUID()
      setState((s) => ({ ...s, address: '', amount: '', fee: '0', gasFee: '0', platformFee: '0', feePkr: '0', network: defaultNetwork ?? networksFor(coin)[0] ?? 'TRC20' }))
      setTotpCode('')
      setSuccess(false)
      setAutoSent(false)
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
      const gasFee = liveFee?.gasFee ?? liveFee?.networkFee ?? '0'
      const platformFee = liveFee?.platformFee ?? '0'
      const totalFee = (parseFloat(gasFee) + parseFloat(platformFee)).toFixed(6).replace(/\.?0+$/, '') || '0'

      // Best-effort PKR conversion — if the rate call fails we still show
      // the fee in coin units instead of breaking the modal.
      let feePkr = '0'
      try {
        const rate = await marketplaceApi.getRate(coin)
        const feeNum = parseFloat(totalFee)
        if (Number.isFinite(feeNum) && Number.isFinite(rate?.rate)) {
          feePkr = (feeNum * rate.rate).toFixed(2)
        }
      } catch { /* leave feePkr as '0' */ }

      setState((s) => ({ ...s, fee: totalFee, gasFee, platformFee, feePkr, loadingFee: false, feeError: null }))
    } catch {
      setState((s) => ({ ...s, fee: '0', gasFee: '0', platformFee: '0', feePkr: '0', feeError: 'Fee unavailable', loadingFee: false }))
    }
  }, [coin, state.network])

  useEffect(() => { if (isOpen) fetchFee() }, [isOpen, fetchFee])
  usePolling(fetchFee, 30_000, isOpen)

  const amountNum = parseFloat(state.amount)
  const feeNum = parseFloat(state.fee || '0')
  const total = state.amount && Number.isFinite(amountNum)
    ? (amountNum + (Number.isFinite(feeNum) ? feeNum : 0)).toFixed(6)
    : '—'
  const totalNum = Number.isFinite(amountNum) && Number.isFinite(feeNum) ? amountNum + feeNum : 0
  const insufficientBalance =
    availableBalance !== undefined &&
    Number.isFinite(totalNum) &&
    totalNum > 0 &&
    totalNum > availableBalance

  // Max withdrawable = balance minus the live fee (which is added on top of the
  // amount). Lets the user empty their balance in one tap without hitting the
  // insufficient-balance error from typing the gross balance.
  const maxWithdrawable =
    availableBalance !== undefined && Number.isFinite(feeNum)
      ? Math.max(0, availableBalance - feeNum)
      : undefined
  const canFillMax = maxWithdrawable !== undefined && maxWithdrawable > 0 && !state.loadingFee && !state.feeError
  const fillMax = () => {
    if (maxWithdrawable === undefined) return
    setState((s) => ({ ...s, amount: maxWithdrawable.toFixed(6).replace(/\.?0+$/, '') }))
  }

  const addrWarn = withdrawAddressWarning(state.address, state.network)

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
        setAutoSent(result.status === 'auto_approved')
        setSuccess(true)
        onSuccess?.()
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

  const networks = networksFor(coin)

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} title={`Withdraw ${coin}`}>
        {requiresEmailConfirm ? (
          <div className="text-center py-6 space-y-3">
            <div className="w-12 h-12 bg-blue-500/15 rounded-full flex items-center justify-center mx-auto text-blue-600 text-2xl">✉</div>
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
            {autoSent ? (
              <>
                <div className="w-12 h-12 bg-success/10 rounded-full flex items-center justify-center mx-auto text-success text-2xl">✓</div>
                <p className="text-sm font-medium text-text-primary">Withdrawal sent</p>
                <p className="text-xs text-text-muted">Your funds are being sent on-chain automatically. No admin approval needed.</p>
                <div className="bg-surface rounded-lg px-3 py-2 text-xs text-text-secondary space-y-1 text-left">
                  <p>• The transaction will appear in your history within seconds.</p>
                  <p>• On-chain confirmation typically takes 1–2 minutes.</p>
                  <p>• If the send fails, you will be notified and your balance refunded.</p>
                </div>
              </>
            ) : (
              <>
                <div className="w-12 h-12 bg-warning/10 rounded-full flex items-center justify-center mx-auto">
                    <Clock size={22} className="text-warning" />
                  </div>
                <p className="text-sm font-medium text-text-primary">Withdrawal request submitted</p>
                <p className="text-xs text-text-muted">Your request is pending admin review. Funds have not been sent on-chain yet.</p>
                <div className="bg-surface rounded-lg px-3 py-2 text-xs text-text-secondary space-y-1 text-left">
                  <p>• Funds are held securely while your request is reviewed.</p>
                  <p>• You will be notified once approved and sent.</p>
                  <p>• If rejected, your balance will be refunded automatically.</p>
                </div>
              </>
            )}
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
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
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
              {addrWarn && (
                <p className="mt-1 flex items-start gap-1.5 text-xs text-warning bg-warning/10 rounded-lg px-2.5 py-1.5">
                  <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" aria-hidden />
                  <span>{addrWarn}</span>
                </p>
              )}
            </div>

            {/* Amount */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-medium text-text-muted">Amount ({coin})</label>
                {availableBalance !== undefined && (
                  <button
                    type="button"
                    onClick={fillMax}
                    disabled={!canFillMax}
                    className="text-xs font-semibold text-primary hover:underline disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed"
                  >
                    Max: {maxWithdrawable?.toFixed(6).replace(/\.?0+$/, '') ?? '0'}
                  </button>
                )}
              </div>
              <input
                type="number"
                value={state.amount}
                onChange={(e) => setState((s) => ({ ...s, amount: e.target.value }))}
                placeholder="0.00"
                className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
              />
              {availableBalance !== undefined && (
                <p className="text-xs text-text-muted mt-1">Available: {availableBalance.toFixed(6).replace(/\.?0+$/, '')} {coin}{!state.loadingFee && !state.feeError && feeNum > 0 ? ' · fee deducted on top' : ''}</p>
              )}
            </div>

            {/* Fee display */}
            <div className="bg-surface rounded-lg p-3 space-y-2 text-sm">
              {state.loadingFee ? (
                <div className="flex items-center gap-2 text-text-muted">
                  <span className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                  <span className="text-xs">Loading fees…</span>
                </div>
              ) : state.feeError ? (
                <div className="flex justify-between items-center">
                  <span className="text-text-muted">Fees</span>
                  <button type="button" onClick={fetchFee} className="text-xs text-warning hover:underline">
                    Fee unavailable — retry
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex justify-between items-center">
                    <span className="text-text-muted">Gas Fee</span>
                    <span className="font-medium text-text-primary">{state.gasFee} {coin}</span>
                  </div>
                  {parseFloat(state.platformFee) > 0 && (
                    <div className="flex justify-between items-center">
                      <span className="text-text-muted">Platform Fee</span>
                      <span className="font-medium text-text-primary">{state.platformFee} {coin}</span>
                    </div>
                  )}
                  {parseFloat(state.feePkr) > 0 && (
                    <div className="flex justify-between items-center text-xs text-text-muted">
                      <span>Total fees (PKR)</span>
                      <span>≈ PKR {parseFloat(state.feePkr).toLocaleString()}</span>
                    </div>
                  )}
                </>
              )}
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
                  autoComplete="one-time-code"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary font-mono tracking-widest text-center"
                />
                <p className="text-xs text-text-muted mt-1">Enter the 6-digit code from your authenticator app.</p>
              </div>
            )}

            {insufficientBalance && (
              <p className="text-sm text-danger bg-danger/10 rounded-lg px-3 py-2">
                Insufficient balance. You need <strong>{totalNum.toFixed(6)} {coin}</strong> (amount + fee) but only have <strong>{availableBalance!.toFixed(6)} {coin}</strong>.
              </p>
            )}

            {submitError && (
              <p className="text-sm text-danger bg-danger/10 rounded-lg px-3 py-2">{submitError}</p>
            )}

            <Button
              fullWidth
              disabled={!state.address || !state.amount || state.loadingFee || !!state.feeError || insufficientBalance || (twoFaEnabled && totpCode.length !== 6)}
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
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
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
              <div className="w-36 h-36 bg-white border border-border rounded-lg flex items-center justify-center mx-auto mb-3 p-2" style={{ backgroundColor: '#ffffff' }}>
                {/* Encode only the address — there's no universal URI scheme
                    for memo/destination tags across wallets, so embedding
                    `?memo=` would make Trust/Binance scan as a malformed
                    address. Memo (if any) is shown separately below. */}
                <QRCodeSVG
                  value={info.address}
                  size={128}
                  level="M"
                  includeMargin={false}
                />
              </div>
              <p className="font-mono text-xs text-text-primary break-all">{info.address}</p>
            </div>

            <div className="flex items-center gap-2">
              <input
                readOnly
                value={info.address}
                className="flex-1 px-3 py-2 text-xs font-mono border border-border rounded-lg bg-surface"
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
                Waiting for {info.minConfirmations} blockchain confirmations before your RupChain balance is credited. Pending deposits appear in your transaction history.
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
  const [form, setForm] = useState({ coin: 'USDT', network: networksFor('USDT')[0], address: '', label: '' })
  const [totpCode, setTotpCode] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<TrustedAddress | null>(null)

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
      setForm({ coin: 'USDT', network: networksFor('USDT')[0], address: '', label: '' })
      setTotpCode('')
      await load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to add address')
    } finally { setAdding(false) }
  }

  const handleRemove = async (id: string) => {
    setRemoveError(null)
    try {
      await walletApi.removeTrustedAddress(id)
      await load()
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : 'Failed to remove address')
    } finally {
      setRemoveTarget(null)
    }
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
      <div>
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold text-text-primary">Trusted Withdrawal Addresses</h2>
          <Button size="sm" className="flex-shrink-0 whitespace-nowrap" onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : '+ Add'}</Button>
        </div>
        <p className="text-xs text-text-muted mt-1">Whitelisted addresses skip the NEW_WALLET risk flag. New addresses have a 24h activation delay.</p>
      </div>

      {showForm && (
        <div className="bg-surface shadow-card rounded-xl border border-border p-4 space-y-3">
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
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
              >
                {Object.keys(COIN_NETWORKS).map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Network</label>
              <select
                value={form.network}
                onChange={(e) => setForm((f) => ({ ...f, network: e.target.value }))}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
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
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-xs text-amber-700">
            This address will have a 24-hour activation delay before it can be used for withdrawals.
          </div>
          <Button fullWidth loading={adding} onClick={handleAdd}>Add Trusted Address</Button>
        </div>
      )}

      {removeError && (
        <p className="text-sm text-danger bg-danger/10 rounded-lg px-3 py-2">{removeError}</p>
      )}

      {addresses.length === 0 ? (
        <div className="bg-surface shadow-card rounded-xl border border-border p-4 text-center text-sm text-text-muted">
          No trusted addresses yet. Add one to reduce friction on future withdrawals.
        </div>
      ) : (
        <div className="bg-surface shadow-card rounded-xl border border-border divide-y divide-border overflow-hidden">
          {addresses.map((a) => {
            const active = isActive(a)
            const wait = hoursLeft(a)
            return (
              <div key={a.id} className="flex items-center gap-3 px-4 py-3">
                <EntityLogo type="token" slug={a.coin} size="sm" className="flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-primary">{a.label}</span>
                    <span className="text-xs text-text-muted">{a.coin} · {a.network}</span>
                    {active ? (
                      <span className="px-1.5 py-0.5 bg-emerald-500/15 text-emerald-700 text-xs rounded-full">Active</span>
                    ) : (
                      <span className="px-1.5 py-0.5 bg-amber-500/15 text-amber-700 text-xs rounded-full">Activates in {wait}</span>
                    )}
                  </div>
                  <p className="font-mono text-xs text-text-muted truncate">{a.address}</p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setRemoveTarget(a)} className="text-danger hover:text-danger flex-shrink-0">
                  Remove
                </Button>
              </div>
            )
          })}
        </div>
      )}

      {removeTarget && (
        <ConfirmRemoveModal
          isOpen
          title="Remove trusted address?"
          itemLabel={`${removeTarget.label} (${removeTarget.coin} · ${removeTarget.network})`}
          confirmValue={removeTarget.address}
          warning="Withdrawals to this address will lose their whitelisted status and a re-added address restarts the 24h activation delay."
          confirmLabel="Remove address"
          onConfirm={() => handleRemove(removeTarget.id)}
          onClose={() => setRemoveTarget(null)}
        />
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
  const [removeTarget, setRemoveTarget] = useState<UserPaymentMethod | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  // Inline edit of an existing method
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editNumber, setEditNumber] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  // Step 1: category, Step 2: selected method within category, Step 3: fields
  const [category, setCategory] = useState<PmCategory | null>(null)
  const [selectedMethod, setSelectedMethod] = useState<string | null>(null)
  const [accountName, setAccountName] = useState('')
  const [mobileNumber, setMobileNumber] = useState('')
  const [ibanNumber, setIbanNumber] = useState('')
  const [accountNumber, setAccountNumber] = useState('')

  const isBankCategory = category === 'banks'
  const pmType = selectedMethod
    ? (MOBILE_TYPE_MAP[selectedMethod] ?? 'bank_transfer')
    : null

  useEffect(() => {
    // includeHidden: this is the management surface, so show hidden methods too
    // (with a badge) so the user can un-hide them.
    userPaymentMethodsApi.getAll(true)
      .then(setMethods)
      .catch(() => {})
      .finally(() => setPmLoading(false))
  }, [])

  const resetForm = () => {
    setCategory(null)
    setSelectedMethod(null)
    setAccountName('')
    setMobileNumber('')
    setIbanNumber('')
    setAccountNumber('')
    setFormError(null)
    setShowForm(false)
  }

  const handleAdd = async () => {
    if (!pmType || !selectedMethod) { setFormError('Select a payment method'); return }
    if (!accountName.trim()) {
      setFormError('Account name is required')
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
    const autoDisplayName = `${selectedMethod} — ${accountName.trim()}`
    try {
      const method = await userPaymentMethodsApi.add({
        type: pmType as UserPaymentMethod['type'],
        displayName: autoDisplayName,
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

  const startEdit = (m: UserPaymentMethod) => {
    setEditId(m.id)
    setEditName(m.accountName)
    // Bank methods edit the IBAN; wallet methods edit the mobile/account number.
    setEditNumber((m.type === 'bank_transfer' ? m.ibanNumber : m.mobileNumber) ?? m.accountNumber ?? '')
    setFormError(null)
  }

  const saveEdit = async (m: UserPaymentMethod) => {
    if (!editName.trim()) { toast.error('Account name is required'); return }
    setEditSaving(true)
    try {
      const patch = m.type === 'bank_transfer'
        ? { accountName: editName.trim(), ibanNumber: editNumber.trim() }
        : { accountName: editName.trim(), mobileNumber: editNumber.trim() }
      const updated = await userPaymentMethodsApi.edit(m.id, patch)
      setMethods((prev) => prev.map((x) => (x.id === m.id ? updated : x)))
      setEditId(null)
      toast.success('Payment method updated')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update payment method')
    } finally {
      setEditSaving(false)
    }
  }

  const toggleHidden = async (m: UserPaymentMethod) => {
    setBusyId(m.id)
    try {
      const updated = await userPaymentMethodsApi.setHidden(m.id, !m.hidden)
      setMethods((prev) => prev.map((x) => (x.id === m.id ? updated : x)))
      toast.success(updated.hidden ? 'Hidden from your listings' : 'Visible again')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update visibility')
    } finally {
      setBusyId(null)
    }
  }

  const handleRemove = async (id: string) => {
    try {
      await userPaymentMethodsApi.remove(id)
      setMethods((prev) => prev.filter((m) => m.id !== id))
      toast.success('Payment method removed')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove payment method')
    } finally {
      setRemoveTarget(null)
    }
  }

  return (
    <section>
      <div className="mb-3">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold text-text-primary">PKR Payment Methods</h2>
          {!showForm && (
            <Button size="sm" variant="secondary" className="flex-shrink-0 whitespace-nowrap" onClick={() => setShowForm(true)}>
              + Add Method
            </Button>
          )}
        </div>
        <p className="text-xs text-text-muted mt-1">Saved accounts used when receiving PKR in trades</p>
      </div>

      {showForm && (
        <div className="bg-surface shadow-card border border-border rounded-xl p-4 mb-4 space-y-4">
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
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {PM_CATEGORIES.map((cat) => (
                <button
                  key={cat.key}
                  onClick={() => { setCategory(cat.key as PmCategory); setSelectedMethod(null) }}
                  className={`text-left px-3 py-2.5 rounded-lg border text-sm transition-colors ${
                    category === cat.key
                      ? 'border-primary bg-primary/5 text-primary font-medium'
                      : 'border-border bg-surface text-text-primary hover:border-primary/50'
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
                <BankSelect
                  banks={PK_BANKS}
                  value={selectedMethod}
                  onChange={(b) => setSelectedMethod(b)}
                />
              ) : (
                <div className="flex flex-wrap gap-2">
                  {PM_CATEGORIES.find((c) => c.key === category)!.methods.map((m) => (
                    <button
                      key={m}
                      onClick={() => setSelectedMethod(m)}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
                        selectedMethod === m
                          ? 'border-primary bg-primary text-white'
                          : `border-border ${getPaymentMethodColor(m)} hover:border-primary/50`
                      }`}
                    >
                      <EntityLogo type="payment_method" slug={m} size="xs" className="flex-shrink-0" />
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
                <EntityLogo
                  type={isBankCategory ? 'bank' : 'payment_method'}
                  slug={selectedMethod}
                  size="sm"
                  className="flex-shrink-0"
                />
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${getPaymentMethodColor(isBankCategory ? '' : selectedMethod)}`}>
                  {selectedMethod}
                </span>
                <span className="text-xs text-text-muted">account details</span>
              </div>

              <div>
                <label className="block text-xs text-text-muted mb-1">Account Name</label>
                <input
                  type="text"
                  placeholder="Full name on the account"
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>

              {!isBankCategory && (
                <div>
                  <label className="block text-xs text-text-muted mb-1">Account / Payment Number</label>
                  <input
                    type="tel"
                    placeholder="03xx-xxxxxxx"
                    value={mobileNumber}
                    onChange={(e) => setMobileNumber(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
              )}

              {isBankCategory && (
                <div className="grid grid-cols-2 gap-3 items-end">
                  <div>
                    <label className="block text-xs text-text-muted mb-1">IBAN</label>
                    <input
                      type="text"
                      placeholder="PK00XXXX..."
                      value={ibanNumber}
                      onChange={(e) => setIbanNumber(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-text-muted mb-1">Account Number <span className="text-text-muted">(optional)</span></label>
                    <input
                      type="text"
                      placeholder="Account number"
                      value={accountNumber}
                      onChange={(e) => setAccountNumber(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
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
        <div className="bg-surface shadow-card border border-border rounded-xl px-4 py-8 text-center">
          <p className="text-sm text-text-muted">No payment methods saved yet.</p>
          <p className="text-xs text-text-muted mt-1">Add your JazzCash, Easypaisa, or bank account so buyers know how to pay you.</p>
        </div>
      ) : (
        <div className="bg-surface shadow-card rounded-xl border border-border divide-y divide-border overflow-hidden">
          {methods.map((m) => (
            <div key={m.id} className={`px-4 py-3 ${m.hidden ? 'opacity-60' : ''}`}>
              {editId === m.id ? (
                /* Inline edit */
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <EntityLogo type={m.type === 'bank_transfer' ? 'bank' : 'payment_method'} slug={m.type === 'bank_transfer' ? (m.bankName ?? 'bank') : pmTypeLabel(m.type)} size="sm" className="flex-shrink-0" />
                    <span className="text-xs font-medium text-text-primary">{pmTypeLabel(m.type, m.bankName)}</span>
                  </div>
                  <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Account name" className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary" />
                  <input value={editNumber} onChange={(e) => setEditNumber(e.target.value)} placeholder={m.type === 'bank_transfer' ? 'IBAN' : 'Account / mobile number'} className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary" />
                  <div className="flex gap-2">
                    <Button size="sm" loading={editSaving} onClick={() => saveEdit(m)}>Save</Button>
                    <Button size="sm" variant="secondary" onClick={() => setEditId(null)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <EntityLogo
                    type={m.type === 'bank_transfer' ? 'bank' : 'payment_method'}
                    slug={m.type === 'bank_transfer' ? (m.bankName ?? 'bank') : pmTypeLabel(m.type)}
                    size="sm"
                    className="flex-shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-text-primary">{m.accountName}</span>
                      <span className={`px-1.5 py-0.5 text-xs rounded-full ${getPaymentMethodColor(pmTypeLabel(m.type))}`}>
                        {pmTypeLabel(m.type, m.bankName)}
                      </span>
                      {m.hidden && <span className="px-1.5 py-0.5 text-xs rounded-full bg-surface-alt text-text-muted border border-border">Hidden</span>}
                    </div>
                    <p className="text-xs text-text-muted mt-0.5">
                      {m.mobileNumber ?? m.ibanNumber ?? m.accountNumber ?? ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-0.5 flex-shrink-0">
                    <button onClick={() => startEdit(m)} title="Edit" aria-label="Edit" className="p-2 rounded-lg text-text-muted hover:text-primary hover:bg-surface-alt transition-colors">
                      <Pencil size={16} />
                    </button>
                    <button onClick={() => toggleHidden(m)} disabled={busyId === m.id} title={m.hidden ? 'Un-hide' : 'Hide from listings'} aria-label={m.hidden ? 'Un-hide' : 'Hide'} className="p-2 rounded-lg text-text-muted hover:text-primary hover:bg-surface-alt transition-colors disabled:opacity-50">
                      {m.hidden ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                    <button onClick={() => setRemoveTarget(m)} title="Remove" aria-label="Remove" className="p-2 rounded-lg text-text-muted hover:text-danger hover:bg-danger/10 transition-colors">
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {removeTarget && (
        <ConfirmRemoveModal
          isOpen
          title="Remove payment method?"
          itemLabel={`${pmTypeLabel(removeTarget.type, removeTarget.bankName)} — ${removeTarget.accountName}`}
          confirmValue={removeTarget.mobileNumber ?? removeTarget.ibanNumber ?? removeTarget.accountNumber ?? removeTarget.accountName}
          warning="It will be removed from your profile. Active trades using it are unaffected."
          confirmLabel="Remove method"
          onConfirm={() => handleRemove(removeTarget.id)}
          onClose={() => setRemoveTarget(null)}
        />
      )}
    </section>
  )
}

// ─── Saved Delivery Addresses Section ────────────────────────────────────────

const DELIVERY_NETWORKS = [
  { value: 'BEP20',   kind: 'wallet',   label: 'USDT BEP20',  placeholder: '0x… wallet address' },
  { value: 'Aptos',   kind: 'wallet',   label: 'USDT Aptos',  placeholder: '0x… Aptos address' },
  { value: 'Binance', kind: 'exchange', label: 'Binance UID', placeholder: 'Your Binance UID (8 digits)' },
  { value: 'OKX',     kind: 'exchange', label: 'OKX UID',     placeholder: 'Your OKX UID' },
  { value: 'Bitget',  kind: 'exchange', label: 'Bitget UID',  placeholder: 'Your Bitget UID' },
  { value: 'Gate',    kind: 'exchange', label: 'Gate UID',    placeholder: 'Your Gate.io UID' },
  { value: 'MEXC',    kind: 'exchange', label: 'MEXC UID',    placeholder: 'Your MEXC UID' },
  { value: 'Other',   kind: 'exchange', label: 'Other UID',   placeholder: 'Your account ID / UID' },
] as const

type DeliveryKind = 'wallet' | 'exchange'

// Networks that are on-chain wallets (show a chain logo); anything else that
// isn't CTM is treated as an exchange venue (show an exchange logo).
const WALLET_NETWORKS_UPPER = ['BEP20', 'APTOS', 'ERC20', 'TRC20', 'POLYGON', 'ARBITRUM', 'OPTIMISM', 'BASE']

// Network value used to tag CTM-token delivery addresses; the token symbol is
// stored in `coin` so each token's address is distinct.
const CTM_NETWORK = 'CTM'

interface CtmTokenOption { symbol: string; name: string }

function SavedDeliveryAddressesSection() {
  const [addresses, setAddresses] = useState<SavedDeliveryAddress[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [adding, setAdding] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // category: 'crypto' (wallets / exchange UIDs) | 'ctm' (community tokens)
  const [category, setCategory] = useState<'crypto' | 'ctm'>('crypto')
  // Within 'crypto', split delivery into on-chain wallet vs off-chain exchange UID
  // (mirrors the ad-creation Token Delivery Method grouping).
  const [deliveryKind, setDeliveryKind] = useState<DeliveryKind>('wallet')
  const [form, setForm] = useState({ network: 'BEP20', tokenSymbol: '', address: '', label: '' })
  // Free-form venue name when the "Other UID" exchange option is selected.
  const [customExchange, setCustomExchange] = useState('')
  // Track whether the user has hand-edited the label so auto-fill never clobbers it.
  const [labelTouched, setLabelTouched] = useState(false)
  const [ctmTokens, setCtmTokens] = useState<CtmTokenOption[]>([])
  const [removeTarget, setRemoveTarget] = useState<SavedDeliveryAddress | null>(null)
  // Inline edit + per-row busy state for saved addresses
  const [editId, setEditId] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [editAddress, setEditAddress] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      // Management surface → include hidden so they can be un-hidden.
      const res = await walletApi.getSavedAddresses(true)
      setAddresses(Array.isArray(res) ? res : [])
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [])

  // Load active CTM tokens so the CTM category dropdown is data-driven (not
  // hardcoded to a single token).
  const loadCtmTokens = useCallback(async () => {
    try {
      const res = await ctmApi.getTokens({ limit: 100 }) as { tokens?: Array<{ symbol?: string; name?: string }> }
      const opts = (res.tokens ?? [])
        .filter((t) => t.symbol && t.name)
        .map((t) => ({ symbol: t.symbol as string, name: t.name as string }))
      setCtmTokens(opts)
    } catch { /* ignore — CTM category just shows empty */ }
  }, [])

  useEffect(() => { load(); loadCtmTokens() }, [load, loadCtmTokens])

  const resetForm = () => {
    setForm({ network: 'BEP20', tokenSymbol: ctmTokens[0]?.symbol ?? '', address: '', label: '' })
    setCategory('crypto')
    setDeliveryKind('wallet')
    setCustomExchange('')
    setLabelTouched(false)
    setFormError(null)
    setShowForm(false)
  }

  // Auto-fill the Label to match the picked network/exchange/token unless the user
  // has already typed their own. Selecting "MEXC UID" pre-fills "MEXC UID"; they can
  // still append their name (e.g. "MEXC UID Fazal").
  const applyAutoLabel = (label: string) => {
    if (!labelTouched) setForm((f) => ({ ...f, label }))
  }

  // Switch the wallet/exchange sub-group and default to its first option.
  const selectDeliveryKind = (kind: DeliveryKind) => {
    setDeliveryKind(kind)
    const first = DELIVERY_NETWORKS.find((n) => n.kind === kind)
    if (first) {
      setForm((f) => ({ ...f, network: first.value }))
      applyAutoLabel(first.value === 'Other' ? '' : first.label)
    }
    setCustomExchange('')
    setFormError(null)
  }

  // Pick a specific network / exchange chip and auto-fill its label.
  const selectNetwork = (value: string, label: string) => {
    setForm((f) => ({ ...f, network: value }))
    if (value !== 'Other') { setCustomExchange(''); applyAutoLabel(label) }
    else applyAutoLabel('')
    setFormError(null)
  }

  const handleAdd = async () => {
    if (category === 'ctm' && !form.tokenSymbol) { setFormError('Select a token'); return }
    const isOther = category === 'crypto' && deliveryKind === 'exchange' && form.network === 'Other'
    if (isOther && !customExchange.trim()) { setFormError('Enter the exchange name'); return }
    if (!form.address.trim()) { setFormError('Address / UID is required'); return }
    // Only blockchain (wallet) addresses are format-checked. Exchange UIDs have no
    // canonical format (numeric id / email / phone) — accept as entered.
    if (category === 'crypto' && deliveryKind === 'wallet') {
      const r = validateAddressForNetwork(form.address.trim(), form.network)
      if (!r.valid) { setFormError(r.reason ?? 'Invalid address for this network'); return }
    }
    if (!form.label.trim()) { setFormError('Label is required'); return }
    setAdding(true)
    setFormError(null)
    try {
      // For "Other", persist the venue the user typed as the network so the saved
      // chip shows the real exchange name.
      const exchangeNetwork = isOther ? (customExchange.trim() || 'Other') : form.network
      const payload = category === 'ctm'
        ? { coin: form.tokenSymbol, network: CTM_NETWORK, address: form.address.trim(), label: form.label.trim() }
        : { coin: 'USDT', network: exchangeNetwork, address: form.address.trim(), label: form.label.trim() }
      const saved = await walletApi.addSavedAddress(payload)
      setAddresses((prev) => [saved, ...prev])
      resetForm()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save address')
    } finally { setAdding(false) }
  }

  const handleRemove = async (id: string) => {
    try {
      await walletApi.deleteSavedAddress(id)
      setAddresses((prev) => prev.filter((a) => a.id !== id))
      toast.success('Address removed')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove address')
    } finally {
      setRemoveTarget(null)
    }
  }

  const selectedNetwork = DELIVERY_NETWORKS.find((n) => n.value === form.network)
  const cryptoAddrs = addresses.filter((a) => a.network !== CTM_NETWORK)
  const ctmAddrs = addresses.filter((a) => a.network === CTM_NETWORK)

  const startEdit = (a: SavedDeliveryAddress) => {
    setEditId(a.id); setEditLabel(a.label); setEditAddress(a.address); setFormError(null)
  }
  const saveEdit = async (a: SavedDeliveryAddress) => {
    if (!editLabel.trim() || !editAddress.trim()) { toast.error('Label and address are required'); return }
    setEditSaving(true)
    try {
      const updated = await walletApi.updateSavedAddress(a.id, { label: editLabel.trim(), address: editAddress.trim() })
      setAddresses((prev) => prev.map((x) => (x.id === a.id ? updated : x)))
      setEditId(null)
      toast.success('Address updated')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update address')
    } finally { setEditSaving(false) }
  }
  const toggleHidden = async (a: SavedDeliveryAddress) => {
    setBusyId(a.id)
    try {
      const updated = await walletApi.setSavedAddressHidden(a.id, !a.hidden)
      setAddresses((prev) => prev.map((x) => (x.id === a.id ? updated : x)))
      toast.success(updated.hidden ? 'Hidden from trade auto-fill' : 'Visible again')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update visibility')
    } finally { setBusyId(null) }
  }

  const renderList = (list: SavedDeliveryAddress[]) => (
    <div className="bg-surface shadow-card rounded-xl border border-border divide-y divide-border overflow-hidden">
      {list.map((a) => (
        <div key={a.id} className={`px-4 py-3 ${a.hidden ? 'opacity-60' : ''}`}>
          {editId === a.id ? (
            <div className="space-y-2">
              <input value={editLabel} onChange={(e) => setEditLabel(e.target.value)} placeholder="Label" className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary" />
              <input value={editAddress} onChange={(e) => setEditAddress(e.target.value)} placeholder="Address / UID" className="w-full px-3 py-2 text-sm font-mono border border-border rounded-lg bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary" />
              <div className="flex gap-2">
                <Button size="sm" loading={editSaving} onClick={() => saveEdit(a)}>Save</Button>
                <Button size="sm" variant="secondary" onClick={() => setEditId(null)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              {a.network === CTM_NETWORK ? (
                <EntityLogo type="token" slug={a.coin} size="sm" className="flex-shrink-0" />
              ) : WALLET_NETWORKS_UPPER.includes(a.network.toUpperCase()) ? (
                <EntityLogo type="chain" slug={a.network} size="sm" className="flex-shrink-0" />
              ) : (
                <EntityLogo type="exchange" slug={a.network} size="sm" className="flex-shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-text-primary">{a.label}</span>
                  <span className="px-1.5 py-0.5 bg-primary/10 text-primary text-xs rounded-full font-medium">
                    {a.network === CTM_NETWORK ? a.coin : a.network}
                  </span>
                  {a.hidden && <span className="px-1.5 py-0.5 text-xs rounded-full bg-surface-alt text-text-muted border border-border">Hidden</span>}
                </div>
                <p className="font-mono text-xs text-text-muted truncate mt-0.5">{a.address}</p>
              </div>
              <div className="flex items-center gap-0.5 flex-shrink-0">
                <button onClick={() => startEdit(a)} title="Edit" aria-label="Edit" className="p-2 rounded-lg text-text-muted hover:text-primary hover:bg-surface-alt transition-colors">
                  <Pencil size={16} />
                </button>
                <button onClick={() => toggleHidden(a)} disabled={busyId === a.id} title={a.hidden ? 'Un-hide' : 'Hide from auto-fill'} aria-label={a.hidden ? 'Un-hide' : 'Hide'} className="p-2 rounded-lg text-text-muted hover:text-primary hover:bg-surface-alt transition-colors disabled:opacity-50">
                  {a.hidden ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
                <button onClick={() => setRemoveTarget(a)} title="Remove" aria-label="Remove" className="p-2 rounded-lg text-text-muted hover:text-danger hover:bg-danger/10 transition-colors">
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )

  return (
    <section>
      <div className="mb-3">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold text-text-primary">Saved Delivery Addresses</h2>
          {!showForm && (
            <Button size="sm" variant="secondary" className="flex-shrink-0 whitespace-nowrap" onClick={() => { setForm((f) => ({ ...f, tokenSymbol: ctmTokens[0]?.symbol ?? '' })); setShowForm(true) }}>+ Add Address</Button>
          )}
        </div>
        <p className="text-xs text-text-muted mt-1">Your wallet addresses, exchange UIDs and community-token accounts — auto-fill when starting a trade</p>
      </div>

      {showForm && (
        <div className="bg-surface shadow-card border border-border rounded-xl p-4 mb-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-text-primary">Add Delivery Address</h3>
            <button onClick={resetForm} className="text-xs text-text-muted hover:text-text-primary">Cancel</button>
          </div>

          {formError && <p className="text-xs text-danger bg-danger/10 border border-danger/20 rounded-lg px-3 py-2">{formError}</p>}

          {/* Category */}
          <div>
            <label className="block text-xs font-medium text-text-muted mb-2">Category</label>
            <div className="grid grid-cols-2 gap-2">
              {([
                { key: 'crypto', label: 'Crypto (Wallet / Exchange UID)' },
                { key: 'ctm', label: 'CTM Token' },
              ] as const).map((c) => (
                <button
                  key={c.key}
                  onClick={() => {
                    setCategory(c.key); setFormError(null)
                    if (c.key === 'ctm') {
                      const tok = ctmTokens.find((t) => t.symbol === form.tokenSymbol) ?? ctmTokens[0]
                      if (tok) applyAutoLabel(`${tok.name} (${tok.symbol})`)
                    } else {
                      const n = DELIVERY_NETWORKS.find((x) => x.value === form.network)
                      if (n && n.value !== 'Other') applyAutoLabel(n.label)
                    }
                  }}
                  className={`px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                    category === c.key ? 'border-primary bg-primary/5 text-primary' : 'border-border bg-surface text-text-primary hover:border-primary/50'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          {category === 'crypto' ? (
            <>
              {/* Delivery kind: on-chain wallet vs off-chain exchange transfer */}
              <div>
                <label className="block text-xs font-medium text-text-muted mb-2">Delivery method</label>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { key: 'wallet', label: 'Wallet / Blockchain' },
                    { key: 'exchange', label: 'Internal / Exchange Transfer' },
                  ] as const).map((k) => (
                    <button
                      key={k.key}
                      onClick={() => selectDeliveryKind(k.key)}
                      className={`px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                        deliveryKind === k.key ? 'border-primary bg-primary/5 text-primary' : 'border-border bg-surface text-text-primary hover:border-primary/50'
                      }`}
                    >
                      {k.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-text-muted mb-2">{deliveryKind === 'wallet' ? 'Network' : 'Exchange'}</label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {DELIVERY_NETWORKS.filter((n) => n.kind === deliveryKind).map((n) => (
                    <button
                      key={n.value}
                      onClick={() => selectNetwork(n.value, n.label)}
                      className={`inline-flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg border text-xs font-medium transition-colors ${
                        form.network === n.value
                          ? 'border-primary bg-primary/5 text-primary'
                          : 'border-border bg-surface text-text-primary hover:border-primary/50'
                      }`}
                    >
                      {n.kind === 'exchange' && n.value !== 'Other' && (
                        <EntityLogo type="exchange" slug={n.value} size="xs" className="flex-shrink-0" />
                      )}
                      {n.kind === 'wallet' && (
                        <EntityLogo type="chain" slug={n.value} size="xs" className="flex-shrink-0" />
                      )}
                      {n.label}
                    </button>
                  ))}
                </div>
              </div>
              {/* Free-form exchange name when "Other UID" is selected. */}
              {deliveryKind === 'exchange' && form.network === 'Other' && (
                <div>
                  <label className="block text-xs font-medium text-text-muted mb-1">Exchange name</label>
                  <input
                    type="text"
                    value={customExchange}
                    onChange={(e) => {
                      const name = e.target.value
                      setCustomExchange(name)
                      applyAutoLabel(name.trim() ? `${name.trim()} UID` : '')
                    }}
                    placeholder="e.g. KuCoin, Bybit, HTX…"
                    className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
              )}
            </>
          ) : (
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Token</label>
              {ctmTokens.length === 0 ? (
                <p className="text-xs text-text-muted bg-surface-alt rounded-lg px-3 py-2">No community tokens are active yet. Check back once tokens are listed.</p>
              ) : (
                <select
                  value={form.tokenSymbol}
                  onChange={(e) => {
                    const sym = e.target.value
                    setForm((f) => ({ ...f, tokenSymbol: sym }))
                    const tok = ctmTokens.find((t) => t.symbol === sym)
                    applyAutoLabel(tok ? `${tok.name} (${tok.symbol})` : sym)
                  }}
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  {ctmTokens.map((t) => (
                    <option key={t.symbol} value={t.symbol}>{t.name} ({t.symbol})</option>
                  ))}
                </select>
              )}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">
              {category === 'ctm' ? `${form.tokenSymbol || 'Token'} deposit address / account` : (selectedNetwork?.label ?? 'Address / UID')}
            </label>
            <input
              type="text"
              value={form.address}
              onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
              placeholder={category === 'ctm' ? 'Your deposit address or account ID for this token' : (selectedNetwork?.placeholder ?? 'Address or UID')}
              className="w-full px-3 py-2 text-sm font-mono border border-border rounded-lg bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
            />
            {/* Format feedback only for blockchain wallets; exchange UIDs aren't enforced. */}
            {category === 'crypto' && deliveryKind === 'wallet' && form.address.trim() && (() => {
              const r = validateAddressForNetwork(form.address.trim(), form.network)
              return r.valid
                ? <p className="text-xs text-green-600 dark:text-green-400 mt-1 flex items-center gap-1"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>Valid {selectedNetwork?.label ?? form.network}</p>
                : <p className="text-xs text-danger mt-1">{r.reason}</p>
            })()}
          </div>

          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Label</label>
            <input
              type="text"
              value={form.label}
              onChange={(e) => { setLabelTouched(true); setForm((f) => ({ ...f, label: e.target.value })) }}
              placeholder='e.g. "My Main Binance" or "Sidra wallet"'
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          <Button fullWidth size="sm" loading={adding} onClick={handleAdd} disabled={category === 'ctm' && ctmTokens.length === 0}>Save Address</Button>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-text-muted py-4 text-center">Loading...</div>
      ) : addresses.length === 0 ? (
        <div className="bg-surface shadow-card border border-border rounded-xl px-4 py-8 text-center">
          <p className="text-sm text-text-muted">No saved addresses yet.</p>
          <p className="text-xs text-text-muted mt-1">Save your wallet addresses, exchange UIDs and community-token accounts once — select them instantly in every trade.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">Crypto Addresses</p>
            {cryptoAddrs.length ? renderList(cryptoAddrs) : (
              <p className="text-xs text-text-muted bg-surface border border-border rounded-xl px-4 py-3">No crypto wallet or exchange UID saved.</p>
            )}
          </div>
          <div>
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">CTM Token Addresses</p>
            {ctmAddrs.length ? renderList(ctmAddrs) : (
              <p className="text-xs text-text-muted bg-surface border border-border rounded-xl px-4 py-3">No community-token delivery address saved.</p>
            )}
          </div>
        </div>
      )}

      {removeTarget && (
        <ConfirmRemoveModal
          isOpen
          title="Remove saved address?"
          itemLabel={`${removeTarget.label} (${removeTarget.network === CTM_NETWORK ? removeTarget.coin : removeTarget.network})`}
          confirmValue={removeTarget.address}
          warning="It will no longer auto-fill when you start a trade."
          confirmLabel="Remove address"
          onConfirm={() => handleRemove(removeTarget.id)}
          onClose={() => setRemoveTarget(null)}
        />
      )}
    </section>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const EXPLORER_TX_BASE: Record<string, string> = {
  BEP20:    'https://bscscan.com/tx',
  ERC20:    'https://etherscan.io/tx',
  TRC20:    'https://tronscan.org/#/transaction',
  POLYGON:  'https://polygonscan.com/tx',
  ARBITRUM: 'https://arbiscan.io/tx',
  OPTIMISM: 'https://optimistic.etherscan.io/tx',
  BASE:     'https://basescan.org/tx',
}

const NETWORK_DISPLAY_NAMES: Record<string, string> = {
  BEP20:    'BNB Smart Chain',
  ERC20:    'Ethereum',
  TRC20:    'Tron',
  POLYGON:  'Polygon',
  ARBITRUM: 'Arbitrum',
  OPTIMISM: 'Optimism',
  BASE:     'Base',
}

function shortTxHash(h: string): string {
  return h.slice(0, 10) + '…' + h.slice(-6)
}

function exportTransactionsCsv(txs: Transaction[]) {
  const headers = ['Date (PKT)', 'Type', 'Coin', 'Network', 'Amount', 'Status', 'TX Hash']
  const rows = txs.map((tx) => {
    const date = new Date(tx.createdAt).toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })
    const sign = (tx.type === 'withdrawal' || tx.type === 'fee') ? '-' : '+'
    return [
      date,
      tx.type,
      tx.coin,
      tx.network ?? '',
      `${sign}${parseFloat(tx.amount).toFixed(6)}`,
      tx.status,
      tx.txHash ?? '',
    ]
  })
  const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `rupchain-transactions-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

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
  const [withdrawWallet, setWithdrawWallet] = useState<{ coin: string; network: string } | null>(null)

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
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load transactions')
    } finally {
      setTxLoading(false)
    }
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
    if (tx.type === 'withdrawal' && tx.status === 'pending') {
      // Tier-1 auto-approved withdrawals are being sent automatically
      return tx.metadata?.tier === 1 ? 'Sending' : 'Pending Review'
    }
    if (tx.type === 'withdrawal' && tx.status === 'completed') return 'Sent'
    if (tx.status === 'failed') return 'Failed / Refunded'
    return tx.status.charAt(0).toUpperCase() + tx.status.slice(1)
  }

  if (loading) return <LoadingState message="Loading wallet..." />
  if (error) return <ErrorState title={error} onRetry={fetchBalances} />

  // Compute withdrawal lock state from the user object
  const wdLockActive = user?.withdrawalLockedUntil
    ? new Date(user.withdrawalLockedUntil) > new Date()
    : false
  const wdLockUntil = user?.withdrawalLockedUntil
    ? fmtPakDateTime(user.withdrawalLockedUntil)
    : null

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-8">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold text-text-primary">Wallet</h1>
        <ConnectButton />
      </div>

      {/* ── Withdrawal security lock banner ── */}
      {wdLockActive && (
        <div className="bg-amber-500/10 border border-amber-500/40 rounded-xl px-4 py-3 flex items-start gap-3">
          <Lock size={18} className="text-amber-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-800">Withdrawals Temporarily Locked</p>
            <p className="text-xs text-amber-700 mt-0.5">
              Due to a recent {user?.withdrawalLockReason ?? 'security change'}, withdrawals are locked until <strong>{wdLockUntil}</strong>. Deposits and trading are unaffected.
            </p>
          </div>
        </div>
      )}

      {/* ── Connected wallet ── */}
      <section className="space-y-4 bg-surface shadow-card rounded-xl border border-border p-5">
        <h2 className="text-base font-semibold text-text-primary">Connected wallet</h2>
        <ChainSwitcher />
        <ConnectedBalances />
        <DisconnectedHint />
      </section>

      {/* ── RupChain internal balances ── */}
      <section>
        <h2 className="text-base font-semibold text-text-primary mb-1">RupChain balance</h2>
        <p className="text-xs text-text-muted mb-3">Held in your RupChain account. Used for withdrawals, listings, and merchant collateral. Deposit on-chain to top up; small withdrawals send instantly, larger ones require admin review.</p>
        {(() => {
          const displayBalances = balances.filter((b) => SUPPORTED_PLATFORM_NETWORKS.has(b.network ?? ''))
          // Always show at least the primary USDT wallet, even at zero balance, so
          // the wallet never looks broken/missing. Users see their wallet exists,
          // the balance is empty, and they can deposit right away.
          const DEFAULT_BALANCE: WalletBalance = { coin: 'USDT', network: 'BEP20', available: '0', locked: '0', total: '0' }
          const cards = displayBalances.length === 0 ? [DEFAULT_BALANCE] : displayBalances
          return (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {cards.map((b) => {
                const coinColor: Record<string, { bg: string; text: string }> = {
                  USDT: { bg: 'bg-emerald-500/10', text: 'text-emerald-600' },
                  BNB:  { bg: 'bg-yellow-500/10',  text: 'text-yellow-600'  },
                  ETH:  { bg: 'bg-slate-500/10',   text: 'text-slate-600 dark:text-slate-300' },
                  BTC:  { bg: 'bg-orange-500/10',  text: 'text-orange-600'  },
                  SOL:  { bg: 'bg-violet-500/10',  text: 'text-violet-600'  },
                  APT:  { bg: 'bg-cyan-500/10',    text: 'text-cyan-600'    },
                }
                const cc = coinColor[b.coin] ?? { bg: 'bg-primary/10', text: 'text-primary' }
                return (
                <div key={`${b.coin}-${b.network}`} className="bg-surface shadow-card rounded-xl border border-border p-5">
                  <div className="flex items-center gap-2 mb-3">
                    <EntityLogo type="token" slug={b.coin} size="md" className="flex-shrink-0" />
                    <span className="font-semibold text-text-primary">{b.coin}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded-full font-semibold ${cc.bg} ${cc.text}`}>{b.network}</span>
                  </div>
                  <div className="space-y-1 mb-4">
                    <div className="flex justify-between text-sm">
                      <span className="text-text-muted">Available</span>
                      <span className="font-bold text-text-primary">{parseFloat(b.available).toFixed(6)}</span>
                    </div>
                    {parseFloat(b.locked) > 0 && (
                      <div className="flex justify-between text-sm">
                        <span className="text-text-muted">Locked collateral</span>
                        <span className="text-text-secondary">{parseFloat(b.locked).toFixed(6)}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-sm border-t border-border pt-1 mt-1">
                      <span className="text-text-muted">Total</span>
                      <span className="text-text-secondary">{(parseFloat(b.available) + parseFloat(b.locked)).toFixed(6)}</span>
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
                      onClick={() => setWithdrawWallet({ coin: b.coin, network: b.network })}
                    >
                      Withdraw
                    </Button>
                  </div>
                </div>
              )})}
            </div>
          )
        })()}
      </section>

      {/* ── PKR Payment Methods ── */}
      <div id="payment-methods">
        <PaymentMethodsSection />
      </div>

      {/* ── Saved Delivery Addresses ── */}
      <div id="saved-addresses">
        <SavedDeliveryAddressesSection />
      </div>

      {/* ── Trusted addresses ── */}
      <TrustedAddressesSection twoFaEnabled={user?.twoFaEnabled ?? false} />

      <RecentDeposits />

      {/* ── Transaction history ── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-text-primary">Transactions</h2>
          {transactions.length > 0 && (
            <button
              onClick={() => exportTransactionsCsv(transactions)}
              className="flex items-center gap-1.5 text-xs text-primary font-medium hover:underline"
              aria-label="Download transactions as CSV"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Download CSV
            </button>
          )}
        </div>
        {transactions.length === 0 ? (
          <EmptyState icon={ArrowUpDown} title="No transactions" description="Your transaction history will appear here" />
        ) : (
          <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
            <div className="divide-y divide-border">
              {transactions.map((tx) => {
                const explorerBase = EXPLORER_TX_BASE[tx.network?.toUpperCase() ?? '']
                const explorerUrl = tx.txHash && explorerBase ? `${explorerBase}/${tx.txHash}` : null
                const networkLabel = NETWORK_DISPLAY_NAMES[tx.network?.toUpperCase() ?? ''] ?? tx.network
                const isDebit = tx.type === 'withdrawal' || tx.type === 'fee'
                const statusIcon = tx.status === 'completed' ? '✓' : tx.status === 'failed' ? '✗' : '⏳'
                const statusColor = tx.status === 'completed' ? 'text-success' : tx.status === 'failed' ? 'text-danger' : 'text-warning'
                return (
                  <div key={tx.id} className="px-4 py-3.5 space-y-1.5">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span className={`font-bold text-sm ${isDebit ? 'text-danger' : 'text-success'}`}>
                          {isDebit ? '-' : '+'}{parseFloat(tx.amount).toFixed(4)} {tx.coin}
                        </span>
                        <Badge variant={txStatusVariant(tx.status)} size="sm">{txStatusLabel(tx)}</Badge>
                      </div>
                      <div className="text-xs text-text-muted text-right">
                        {networkLabel && <span className="font-medium text-text-secondary">{networkLabel}</span>}
                        <span className="text-text-muted"> · {fmtTxDateTime(tx.createdAt)}</span>
                      </div>
                    </div>
                    <div className={`flex items-center gap-1.5 text-xs ${statusColor}`}>
                      <span>{statusIcon}</span>
                      <span className="capitalize">{txStatusLabel(tx)} {fmtTxDateTime(tx.createdAt)}</span>
                    </div>
                    {explorerUrl && (
                      <div className="text-xs">
                        <a
                          href={explorerUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline font-mono"
                        >
                          {shortTxHash(tx.txHash!)} ↗
                        </a>
                      </div>
                    )}
                  </div>
                )
              })}
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
      {withdrawWallet && (
        <WithdrawModal
          isOpen={!!withdrawWallet}
          onClose={() => setWithdrawWallet(null)}
          coin={withdrawWallet.coin}
          defaultNetwork={withdrawWallet.network}
          twoFaEnabled={user?.twoFaEnabled ?? false}
          onSuccess={() => { fetchBalances(); fetchTransactions(1) }}
          availableBalance={parseFloat(
            balances.find((b) => b.coin === withdrawWallet.coin && b.network === withdrawWallet.network)?.available ?? '0'
          )}
        />
      )}
    </div>
  )
}
