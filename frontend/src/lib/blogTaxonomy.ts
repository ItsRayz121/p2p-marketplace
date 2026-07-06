// Blog category taxonomy — a curated two-level list (category → subcategory).
//
// This is the single source of truth for the dropdowns in the admin blog editor.
// To add a new CTM token, gas chain, or topic, edit the arrays below and deploy.
// For anything not yet listed, admins pick "Others" in either dropdown and type a
// custom value — so the free-text escape hatch means the list never blocks a post.
//
// Categories/subcategories are stored on BlogPost as plain strings (the label
// shown here), so filtering by ?category=…&subcategory=… keeps working.

export const OTHER_OPTION = 'Others (type your own)'

export interface BlogCategory {
  /** Stored + displayed label. */
  label: string
  /** Subcategories offered when this category is selected. */
  subcategories: string[]
}

export const BLOG_CATEGORIES: BlogCategory[] = [
  {
    label: 'CTM Token',
    // Each Community Token Market token gets its own subcategory. Add new tokens here.
    subcategories: ['InterLink (ITL)', 'Sidra', 'Sidrachain'],
  },
  {
    label: 'USDT Marketplace',
    subcategories: ['Buying USDT', 'Selling USDT', 'Payment Methods', 'Trade Safety'],
  },
  {
    label: 'Crypto Gas',
    // Gas fee top-ups per chain / token standard. Add new chains here.
    subcategories: ['BEP20 (BSC)', 'ERC20 (Ethereum)', 'TRC20 (Tron)', 'Aptos', 'opBNB', 'Solana', 'TON', 'SUI'],
  },
  {
    label: 'Learn & Tutorials',
    subcategories: ['Beginner Basics', 'Security & Scam Safety', 'How-To Guides', 'Product Updates'],
  },
]

/** Category labels for the top-level dropdown (excludes the Others sentinel). */
export const BLOG_CATEGORY_LABELS = BLOG_CATEGORIES.map((c) => c.label)

/** Subcategories for a given category label; empty array for unknown/Others. */
export function subcategoriesFor(categoryLabel: string): string[] {
  return BLOG_CATEGORIES.find((c) => c.label === categoryLabel)?.subcategories ?? []
}
