// Shared Pakistani payment method constants used across create-ad, CTM, and payment-method forms.

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
