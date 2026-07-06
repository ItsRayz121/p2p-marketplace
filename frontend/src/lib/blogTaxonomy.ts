// Blog category taxonomy — a curated two-level list (category → subcategory).
//
// This is the single source of truth for the dropdowns in the admin blog editor.
//
// Subcategories come from two places:
//   • CTM Token  → auto-pulled from the live CTM token list (ctmApi.getTokens)
//   • Crypto Gas → auto-pulled from the live gas chain list (gasApi.getChains)
//     so a newly-added token/chain shows up as a subcategory automatically.
//   • USDT / Learn → the static lists below.
// The arrays below double as the fallback seeds if a live fetch fails.
//
// Either dropdown also offers "Others → type your own", so anything not yet in a
// list never blocks a post. Categories/subcategories are stored on BlogPost as
// plain strings (the label shown here), so filtering by
// ?category=…&subcategory=… keeps working.

export const OTHER_OPTION = 'Others (type your own)'

// Canonical category labels. The two dynamic categories are referenced by the
// admin editor to decide which live list feeds the subcategory dropdown.
export const CATEGORY = {
  CTM: 'CTM Token',
  USDT: 'USDT Marketplace',
  GAS: 'Crypto Gas',
  LEARN: 'Learn & Tutorials',
} as const

export interface BlogCategory {
  /** Stored + displayed label. */
  label: string
  /** Subcategories offered when this category is selected (static / fallback). */
  subcategories: string[]
}

export const BLOG_CATEGORIES: BlogCategory[] = [
  {
    label: CATEGORY.CTM,
    // Auto-pulled from live CTM tokens; these are the fallback seeds.
    subcategories: ['InterLink (ITL)', 'Sidra Chain (SDA)'],
  },
  {
    label: CATEGORY.USDT,
    subcategories: ['Buying USDT', 'Selling USDT', 'Payment Methods', 'Trade Safety'],
  },
  {
    label: CATEGORY.GAS,
    // Auto-pulled from live gas chains; these are the fallback seeds.
    subcategories: ['BNB Smart Chain', 'Ethereum', 'TRON'],
  },
  {
    label: CATEGORY.LEARN,
    subcategories: ['Beginner Basics', 'Security & Scam Safety', 'How-To Guides', 'Product Updates'],
  },
]

/** Category labels for the top-level dropdown (excludes the Others sentinel). */
export const BLOG_CATEGORY_LABELS = BLOG_CATEGORIES.map((c) => c.label)

/** Static subcategories for a given category label; empty for unknown/Others. */
export function subcategoriesFor(categoryLabel: string): string[] {
  return BLOG_CATEGORIES.find((c) => c.label === categoryLabel)?.subcategories ?? []
}
