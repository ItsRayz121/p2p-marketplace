// Central contact configuration — single source of truth for support channels.
// IMPORTANT: Use SUPPORT_EMAIL everywhere instead of hardcoding addresses.

export const SUPPORT_EMAIL = 'support@rupchain.com'

/** Build a mailto link with an optional subject. */
export function supportMailto(subject?: string): string {
  return subject
    ? `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}`
    : `mailto:${SUPPORT_EMAIL}`
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
  { id: 'telegram',  label: 'Telegram',         href: null, available: false },
  { id: 'whatsapp',  label: 'WhatsApp',         href: null, available: false },
  { id: 'facebook',  label: 'Facebook',         href: null, available: false },
  { id: 'twitter',   label: 'X (Twitter)',      href: null, available: false },
  { id: 'instagram', label: 'Instagram',        href: null, available: false },
]
