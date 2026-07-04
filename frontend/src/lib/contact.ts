// Central contact configuration — single source of truth for support channels.
// IMPORTANT: Use SUPPORT_EMAIL everywhere instead of hardcoding addresses.

export const SUPPORT_EMAIL = 'support@rupchain.com'

/** Build a mailto link with an optional subject. */
export function supportMailto(subject?: string): string {
  return subject
    ? `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}`
    : `mailto:${SUPPORT_EMAIL}`
}

/**
 * Open a support email robustly across every surface.
 *
 * A bare `mailto:` link throws `ERR_UNKNOWN_URL_SCHEME` (and shows a broken
 * error page) inside an Android WebView / installed-app wrapper / Telegram Mini
 * App, because those webviews have no mail-client handler. In those contexts we
 * instead copy the address to the clipboard and toast it, so the user always
 * has a working path. In a normal browser we open the mail client as usual.
 */
export function openSupportEmail(subject?: string): void {
  if (typeof window === 'undefined') return
  const w = window as unknown as {
    Telegram?: { WebApp?: unknown }
    matchMedia?: (q: string) => { matches: boolean }
    navigator?: { standalone?: boolean }
  }
  const inTelegram = Boolean(w.Telegram?.WebApp)
  const isStandalone =
    Boolean(w.matchMedia?.('(display-mode: standalone)')?.matches) ||
    w.navigator?.standalone === true

  // Copy the address as a universal fallback that works even where mailto can't.
  try { void navigator.clipboard?.writeText(SUPPORT_EMAIL) } catch { /* clipboard may be blocked */ }

  if (inTelegram || isStandalone) {
    // Lazy import to keep this module free of UI deps on the server.
    import('./toast').then(({ toast }) => {
      toast.info(`Email us at ${SUPPORT_EMAIL}`, 'Address copied to your clipboard')
    }).catch(() => { /* toast unavailable — clipboard copy still happened */ })
    return
  }
  window.location.href = supportMailto(subject)
}

// Social / messaging support channels.
// `available: false` channels are shown as "Coming soon" placeholders.
export interface SupportChannel {
  id: string
  label: string
  href: string | null
  available: boolean
}

export const SUPPORT_CHANNELS: SupportChannel[] = [
  { id: 'email',     label: 'Email Support',    href: supportMailto('RupChain Support'), available: true },
  { id: 'telegram',  label: 'Telegram',         href: 'https://t.me/rupchain_community', available: true },
  { id: 'whatsapp',  label: 'WhatsApp',         href: 'https://whatsapp.com/channel/0029Vb8QwYmEquiI04YSzP3q', available: true },
  { id: 'facebook',  label: 'Facebook',         href: null, available: false },
  { id: 'twitter',   label: 'X (Twitter)',      href: null, available: false },
  { id: 'instagram', label: 'Instagram',        href: null, available: false },
]

// ─── Community & social channels ────────────────────────────────────────────
// Single source of truth for RupChain's public community channels. Surfaced in
// the footer, Help Centre, the /community page and the header. Update links
// here only — every surface reads from this list.
export type CommunityBrand = 'telegram' | 'whatsapp'

export interface CommunityChannel {
  id: string
  brand: CommunityBrand
  /** Short name shown as the card/link title. */
  label: string
  href: string
  /** One-line explanation of what the channel is for. */
  purpose: string
  /** Button/link call-to-action text. */
  cta: string
}

export const COMMUNITY_CHANNELS: CommunityChannel[] = [
  {
    id: 'telegram-community',
    brand: 'telegram',
    label: 'Telegram Community',
    href: 'https://t.me/rupchain_community',
    purpose: 'Chat with fellow traders and get quick answers from the community.',
    cta: 'Join group',
  },
  {
    id: 'telegram-announcements',
    brand: 'telegram',
    label: 'Telegram Announcements',
    href: 'https://t.me/rupchain',
    purpose: 'Official updates — new features, maintenance and important notices.',
    cta: 'Follow channel',
  },
  {
    id: 'whatsapp-channel',
    brand: 'whatsapp',
    label: 'WhatsApp Channel',
    href: 'https://whatsapp.com/channel/0029Vb8QwYmEquiI04YSzP3q',
    purpose: 'Announcement broadcasts on WhatsApp — news only, no group chat.',
    cta: 'Follow channel',
  },
]
