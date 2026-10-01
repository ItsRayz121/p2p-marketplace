import { randomBytes } from 'crypto'

/**
 * Pure helpers for the shareable payment page. Kept I/O-free so the privacy rules
 * (what a public visitor may see) are unit-testable.
 */

const TYPE_LABELS: Record<string, string> = {
  jazzcash: 'JazzCash',
  easypaisa: 'Easypaisa',
  sadapay: 'SadaPay',
  nayapay: 'NayaPay',
  bank_transfer: 'Bank transfer',
}

/** Unguessable public identifier: 96 random bits, URL-safe (16 chars). */
export function generatePaymentSlug(): string {
  return randomBytes(12).toString('base64url')
}

export const PAYMENT_SLUG_RE = /^[A-Za-z0-9_-]{12,40}$/

export function isValidPaymentSlug(v: unknown): v is string {
  return typeof v === 'string' && PAYMENT_SLUG_RE.test(v)
}

/** Usernames are accepted as vanity links (/pay/<username>) alongside the random slug. */
export const PAYMENT_USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/

export function isValidPaymentUsername(v: unknown): v is string {
  return typeof v === 'string' && PAYMENT_USERNAME_RE.test(v)
}

export interface SharableAddressRow {
  coin: string
  network: string
  address: string
  label: string
}

export interface PublicPaymentAddress {
  coin: string
  network: string
  address: string
  label: string
}

/** Map a stored saved address to the minimal public DTO. Never spreads the DB row. */
export function toPublicPaymentAddress(a: SharableAddressRow): PublicPaymentAddress {
  return { coin: clean(a.coin), network: clean(a.network), address: clean(a.address), label: clean(a.label) }
}

export interface SharableMethodRow {
  type: string
  accountName: string
  mobileNumber: string | null
  bankName: string | null
  ibanNumber: string | null
  accountNumber: string | null
}

export interface PublicPaymentMethod {
  type: string
  /** Institution shown to the payer (bank name or wallet brand). */
  label: string
  bankName: string | null
  accountName: string
  /** Each value the payer may copy — only what is needed to send money. */
  numbers: Array<{ label: string; value: string }>
}

// eslint-disable-next-line no-control-regex
const clean = (v: string | null | undefined) => (v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()

/** Map a stored method to the minimal public DTO. Never spreads the DB row. */
export function toPublicPaymentMethod(m: SharableMethodRow): PublicPaymentMethod {
  const bank = clean(m.bankName) || null
  const numbers: PublicPaymentMethod['numbers'] = []
  if (m.type === 'bank_transfer') {
    if (clean(m.ibanNumber)) numbers.push({ label: 'IBAN', value: clean(m.ibanNumber) })
    if (clean(m.accountNumber)) numbers.push({ label: 'Account number', value: clean(m.accountNumber) })
  } else {
    const n = clean(m.mobileNumber) || clean(m.accountNumber)
    if (n) numbers.push({ label: 'Account number', value: n })
  }
  return {
    type: m.type,
    label: m.type === 'bank_transfer' ? (bank ?? TYPE_LABELS.bank_transfer!) : (TYPE_LABELS[m.type] ?? m.type),
    bankName: m.type === 'bank_transfer' ? bank : null,
    accountName: clean(m.accountName),
    numbers,
  }
}
