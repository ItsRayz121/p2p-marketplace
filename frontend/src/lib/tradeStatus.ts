import type { LucideIcon } from 'lucide-react'
import {
  Clock,
  Upload,
  CheckCheck,
  ArrowUpRight,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Timer,
  RefreshCw,
} from 'lucide-react'

export type TradeStatusVariant = 'success' | 'warning' | 'info' | 'danger' | 'default'

export interface StatusConfig {
  label: string
  variant: TradeStatusVariant
  icon: LucideIcon
}

// ─── Trade statuses ────────────────────────────────────────────────────────────

const TRADE_STATUS_MAP: Record<string, StatusConfig> = {
  payment_pending:   { label: 'Awaiting Payment',   variant: 'warning', icon: Clock          },
  payment_uploaded:  { label: 'Proof Uploaded',     variant: 'info',    icon: Upload         },
  payment_confirmed: { label: 'Payment Confirmed',  variant: 'info',    icon: CheckCheck     },
  crypto_sent:       { label: 'Crypto Sent',         variant: 'info',    icon: ArrowUpRight   },
  crypto_released:   { label: 'Completed',           variant: 'success', icon: CheckCircle2   },
  disputed:          { label: 'Disputed',            variant: 'danger',  icon: AlertTriangle  },
  dispute_resolved:  { label: 'Dispute Resolved',    variant: 'success', icon: CheckCircle2   },
  cancelled:         { label: 'Cancelled',           variant: 'default', icon: XCircle        },
  expired:           { label: 'Expired',             variant: 'danger',  icon: Timer          },
}

const FALLBACK_STATUS: StatusConfig = {
  label: 'Unknown',
  variant: 'default',
  icon: Clock,
}

export function getTradeStatus(status: string): StatusConfig {
  return TRADE_STATUS_MAP[status] ?? { ...FALLBACK_STATUS, label: status }
}

export function tradeStatusLabel(status: string): string {
  return TRADE_STATUS_MAP[status]?.label ?? status
}

export function tradeStatusVariant(status: string): TradeStatusVariant {
  return TRADE_STATUS_MAP[status]?.variant ?? 'default'
}

// ─── Gas statuses ──────────────────────────────────────────────────────────────

const GAS_STATUS_MAP: Record<string, StatusConfig> = {
  payment_pending:   { label: 'Awaiting Payment', variant: 'warning', icon: Clock         },
  payment_uploaded:  { label: 'Proof Sent',       variant: 'info',    icon: Upload        },
  payment_verified:  { label: 'Verified',         variant: 'info',    icon: CheckCheck    },
  payment_detected:  { label: 'Confirmed',        variant: 'info',    icon: CheckCheck    },
  sending:           { label: 'Sending',          variant: 'warning', icon: ArrowUpRight  },
  delivered:         { label: 'Delivered',        variant: 'success', icon: CheckCircle2  },
  failed:            { label: 'Failed',           variant: 'danger',  icon: XCircle       },
  expired:           { label: 'Expired',          variant: 'danger',  icon: Timer         },
  refund_pending:    { label: 'Refund Pending',   variant: 'warning', icon: RefreshCw     },
  refunded:          { label: 'Refunded',         variant: 'success', icon: CheckCircle2  },
}

export function getGasStatus(status: string): StatusConfig {
  return GAS_STATUS_MAP[status] ?? { ...FALLBACK_STATUS, label: status }
}

export function gasStatusLabel(status: string): string {
  return GAS_STATUS_MAP[status]?.label ?? status
}

export function gasStatusVariant(status: string): TradeStatusVariant {
  return GAS_STATUS_MAP[status]?.variant ?? 'default'
}

// ─── KYC statuses ─────────────────────────────────────────────────────────────

export function kycStatusVariant(status: string): TradeStatusVariant {
  if (status === 'approved') return 'success'
  if (status === 'pending')  return 'warning'
  if (status === 'rejected') return 'danger'
  return 'default'
}
