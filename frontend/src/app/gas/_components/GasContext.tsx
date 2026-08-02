'use client'
import { createContext, useContext } from 'react'
import type {
  GasChain, GasToken, GasTokensResponse, GasOrder,
  GasPkrMethods, GasCryptoMethods, GasNetworkFee,
} from '@/lib/api'
import type { AuthUser } from '@/store/auth.store'

export const PHASE = {
  CHAINS:         0,
  TOKEN:          1,
  AMOUNT:         2,
  ADDRESS:        3,
  PAY_METHOD:     4,
  PKR_METHOD:     5,
  PKR_DETAILS:    6,
  PKR_PROOF:      7,
  PKR_REVIEW:     8,
  CRYPTO_NETWORK: 9,
  CRYPTO_QR:      10,
  PROCESSING:     11,
  COMPLETE:       12,
} as const

export type Phase = typeof PHASE[keyof typeof PHASE]

export const PKR_METHOD_META = {
  bank_transfer: { abbr: 'BK', label: 'Bank Transfer', desc: 'Direct bank account transfer' },
  easypaisa:     { abbr: 'EP', label: 'Easypaisa',     desc: 'Pay via Easypaisa mobile wallet' },
  jazzcash:      { abbr: 'JC', label: 'JazzCash',      desc: 'Pay via JazzCash mobile wallet' },
  nayapay:       { abbr: 'NP', label: 'NayaPay',       desc: 'Pay via NayaPay digital bank' },
  sadapay:       { abbr: 'SP', label: 'SadaPay',       desc: 'Pay via SadaPay digital bank' },
} as const

export type PkrMethodKey = keyof typeof PKR_METHOD_META

export interface GasFlowCtx {
  user: AuthUser | null

  // Phase
  phase: Phase
  setPhase: (p: Phase) => void
  resetFlow: () => void

  // Step 0: Chains
  chains: GasChain[]
  chainsLoading: boolean
  chainsError: string
  setChainsError: (e: string) => void
  setChainsLoading: (v: boolean) => void
  setChains: (c: GasChain[]) => void
  selectedChain: GasChain | null
  handleSelectChain: (chain: GasChain) => void

  // Step 1: Tokens
  tokenData: GasTokensResponse | null
  tokensLoading: boolean
  tokensError: string
  selectedToken: GasToken | null
  setSelectedToken: (t: GasToken | null) => void
  fetchTokens: (chain: GasChain) => Promise<void>

  // Step 2: Amount
  amount: string
  setAmount: (a: string) => void
  amountError: string
  setAmountError: (e: string) => void
  validateAmountField: (v: string) => boolean

  // Step 3: Address
  address: string
  setAddress: (a: string) => void
  addressError: string
  setAddressError: (e: string) => void
  validateAddressField: (v: string) => boolean
  networkFee: GasNetworkFee | null

  // Step 4: Payment methods
  pkrMethods: GasPkrMethods | null
  cryptoMethods: GasCryptoMethods | null
  methodsLoading: boolean

  // PKR flow
  selectedPkrMethod: PkrMethodKey | null
  setSelectedPkrMethod: (m: PkrMethodKey | null) => void
  creatingPkr: boolean
  pkrError: string
  proofUrl: string
  submittingProof: boolean
  proofError: string
  uploading: boolean
  uploadProgress: import('@/hooks/useFileUpload').UploadProgress | null
  uploadError: string | null
  handleCreatePkrOrder: () => Promise<void>
  handleUploadFile: (file: File) => Promise<void>
  handleSubmitProof: () => Promise<void>

  // Crypto flow
  selectedCryptoNetwork: 'BEP20' | 'APTOS' | null
  setSelectedCryptoNetwork: (n: 'BEP20' | 'APTOS' | null) => void
  creatingCrypto: boolean
  cryptoError: string
  qrFailed: boolean
  setQrFailed: (v: boolean) => void
  paymentSent: boolean
  setPaymentSent: (v: boolean) => void
  verifyOpen: boolean
  setVerifyOpen: (v: boolean) => void
  verifyTxHash: string
  setVerifyTxHash: (v: string) => void
  verifying: boolean
  verifyError: string
  verifySuccess: string
  handleCreateCryptoOrder: () => Promise<void>
  handleVerifyPayment: () => Promise<void>
  pollOrder: () => Promise<void>

  // Cancellation
  cancelling: boolean
  cancelError: string
  cancelPreview: { cancellable: boolean; priorCancels: number; thisCancelNumber: number; cooldownMs: number; cooldownLabel: string | null } | null
  cancelResult: { cooldownLabel: string | null } | null
  loadCancelPreview: () => Promise<void>
  handleCancelOrder: () => Promise<void>

  // Refund request (paid-but-stuck orders)
  requestingRefund: boolean
  refundReqError: string
  handleRequestRefund: () => Promise<void>

  // Order
  order: GasOrder | null
  setOrder: (o: GasOrder | ((prev: GasOrder | null) => GasOrder | null)) => void
  pollErrCount: number
  setPollErrCount: (n: number | ((prev: number) => number)) => void

  // Computed
  priceUsd: number
  pricePkr: number
  platformFeeUsdt: number
  amountNum: number
  gasValueUsd: number
  usdPkrRate: number
  totalUsd: number
  computedUsd: number
  computedPkr: number
  effectiveUsd: number
  effectivePkr: number
  promoDiscountUsd: number
  affiliateDiscountUsd: number
  affiliateQuote: { discountUsdt: number; discountPct: number; referrerLabel: string } | null
  maxUsd: number
  minAmount: number
  usdExceeded: boolean
  isPkrOrder: boolean
  explorerBase: string | null

  // Promo code (gas marketing — margin-only discount)
  promoEnabled: boolean
  promoCode: string
  setPromoCode: (v: string) => void
  promoApplied: { code: string; discountUsdt: number; discountPct: number; slotsLeft: number | null; message: string } | null
  promoError: string
  promoChecking: boolean
  applyPromo: () => Promise<void>
  clearPromo: () => void

  // KOL free-gas code (100% free — base + margin, self-serve, slot + budget capped)
  freeCodeEnabled: boolean
  freeCode: string
  setFreeCode: (v: string) => void
  freeCodeApplied: { code: string; kolLabel: string; amountNative: number; slotsLeft: number; budgetLeftUsdt: number; message: string } | null
  freeCodeError: string
  freeCodeChecking: boolean
  applyFreeCode: () => Promise<void>
  clearFreeCode: () => void

  // Helpers
  getPkrDetails: () => { label: string; value: string | null | undefined }[] | null
}

const GasFlowContext = createContext<GasFlowCtx | null>(null)

export function GasFlowProvider({ children, value }: { children: React.ReactNode; value: GasFlowCtx }) {
  return <GasFlowContext.Provider value={value}>{children}</GasFlowContext.Provider>
}

export function useGasCtx(): GasFlowCtx {
  const ctx = useContext(GasFlowContext)
  if (!ctx) throw new Error('useGasCtx must be used inside GasFlowProvider')
  return ctx
}
