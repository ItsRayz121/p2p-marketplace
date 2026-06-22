import { db } from './prisma'
import { Prisma } from '@prisma/client'

// The marketplace / CTM filter dropdowns send a human-readable payment-method
// LABEL (e.g. "JazzCash", "SadaPay", "HBL"), while listings persist an array of
// PaymentMethod *IDs* (cuids) and PaymentMethod.type is a lowercase enum
// (jazzcash | easypaisa | sadapay | nayapay | bank_transfer). Filtering the
// label directly against either the enum (USDT path) or the ID array (CTM path)
// silently fails — the enum cast throws ("database error") and the array `has`
// never matches. This helper bridges the gap: given a UI label it returns every
// PaymentMethod ID across all sellers that the label should match.

// Map a mobile-wallet label to its enum type. Banks are handled separately via
// a bankName substring match because the dropdown uses short names ("HBL") while
// the stored bankName is the full label ("HBL — Habib Bank Limited").
const MOBILE_LABEL_TO_TYPE: Record<string, string> = {
  jazzcash: 'jazzcash',
  easypaisa: 'easypaisa',
  sadapay: 'sadapay',
  nayapay: 'nayapay',
}

/**
 * Resolves a UI payment-method label to the set of matching PaymentMethod IDs.
 * Returns an empty array when nothing matches (caller should then yield no
 * listings rather than ignoring the filter).
 */
export async function resolvePaymentMethodIdsByLabel(label: string): Promise<string[]> {
  const normalized = label.trim().toLowerCase()
  if (!normalized) return []

  const mobileType = MOBILE_LABEL_TO_TYPE[normalized]

  const where: Prisma.PaymentMethodWhereInput = mobileType
    ? { type: mobileType as never }
    : {
        // Treat anything that isn't a known mobile wallet as a bank: match the
        // short pill label as a case-insensitive substring of the stored bankName.
        type: 'bank_transfer',
        bankName: { contains: label.trim(), mode: 'insensitive' },
      }

  const methods = await db.paymentMethod.findMany({ where, select: { id: true } })
  return methods.map((m) => m.id)
}
