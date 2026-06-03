// Canonical display-name resolution for traders.
// Priority: fullName > merchant/business name > username > email prefix > "Trader".
// Never surfaces raw generated IDs (long random usernames) as a display name.

interface NameParts {
  fullName?: string | null
  merchantName?: string | null
  businessName?: string | null
  username?: string | null
  email?: string | null
}

// Heuristic: a "username" that is a long opaque id (e.g. cwf_... hashes, or all
// digits / 16+ random chars) shouldn't be shown as a human name.
function looksLikeGeneratedId(s: string): boolean {
  if (/^\d{6,}$/.test(s)) return true
  if (s.length >= 16 && !s.includes(' ')) return true
  return false
}

export function traderDisplayName(parts: NameParts): string {
  const full = parts.fullName?.trim()
  if (full) return full

  const merchant = (parts.merchantName ?? parts.businessName)?.trim()
  if (merchant) return merchant

  const username = parts.username?.trim()
  if (username && !looksLikeGeneratedId(username)) return username

  const email = parts.email?.trim()
  if (email && email.includes('@')) return email.split('@')[0]

  return username || 'Trader'
}
