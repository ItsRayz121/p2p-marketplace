// Shared Pakistani payment method constants used across create-ad, CTM, and payment-method forms.

export interface PaymentMethodGroup {
  label: string
  methods: string[]
}

export const PAYMENT_METHOD_GROUPS: PaymentMethodGroup[] = [
  { label: 'Branchless Wallets', methods: ['JazzCash', 'Easypaisa'] },
  { label: 'Fintech / EMIs', methods: ['SadaPay', 'NayaPay'] },
  {
    label: 'Commercial Banks',
    methods: [
      'HBL', 'MCB', 'UBL', 'Allied Bank', 'Bank Alfalah', 'Meezan Bank',
      'NBP', 'Standard Chartered', 'Askari Bank', 'Faysal Bank', 'JS Bank',
      'Bank of Punjab', 'Silk Bank', 'Soneri Bank',
    ],
  },
]

export const PK_BANKS = [
  'HBL — Habib Bank Limited',
  'MCB — Muslim Commercial Bank',
  'UBL — United Bank Limited',
  'Allied Bank',
  'Bank Alfalah',
  'Meezan Bank (Islamic)',
  'National Bank of Pakistan (NBP)',
  'Standard Chartered Pakistan',
  'Askari Bank',
  'Faysal Bank',
  'JS Bank',
  'Bank of Punjab',
  'Silk Bank',
  'Soneri Bank',
  'Summit Bank',
  'Other / Not Listed',
]

// Mobile-money methods shown as quick-select pills
export const PK_MOBILE_METHODS = ['JazzCash', 'Easypaisa', 'SadaPay', 'NayaPay']

// Full flat list used for pill selectors on create-ad / CTM forms
// Banks appear with short names for the pill label, full name stored in DB
export const PK_BANK_PILLS = [
  'HBL',
  'MCB',
  'UBL',
  'Allied Bank',
  'Bank Alfalah',
  'Meezan Bank',
  'NBP',
  'Standard Chartered',
  'Askari Bank',
  'Faysal Bank',
  'JS Bank',
  'Bank of Punjab',
  'Silk Bank',
  'Soneri Bank',
]

export const ALL_PAYMENT_METHODS = [...PK_MOBILE_METHODS, ...PK_BANK_PILLS]

// Detects opaque internal identifiers (e.g. Prisma CUIDs like
// "cmpjsaw550046b7ohzs6fkfvl") that must never be shown to users in listing
// cards. These look like a long lowercase-alphanumeric run with no spaces.
export function isOpaqueId(value: string): boolean {
  const v = value.trim()
  if (v.includes(' ')) return false
  // CUID / CUID2 style: starts with a letter, 20+ chars, only [a-z0-9]
  return /^[a-z][a-z0-9]{19,}$/.test(v)
}

// Filters a list of payment-method labels down to human-readable names,
// dropping any opaque IDs so raw identifiers never leak into the UI.
export function cleanPaymentLabels<T extends { label: string }>(methods: T[]): T[] {
  return methods.filter((m) => m.label && !isOpaqueId(m.label))
}

// Returns a Tailwind className string for a payment method badge chip
export function getPaymentMethodColor(method: string): string {
  if (method === 'JazzCash') return 'bg-orange-100 text-orange-700'
  if (method === 'Easypaisa') return 'bg-green-100 text-green-700'
  if (method === 'SadaPay') return 'bg-teal-100 text-teal-700'
  if (method === 'NayaPay') return 'bg-indigo-100 text-indigo-700'
  return 'bg-blue-50 text-blue-700' // banks
}
