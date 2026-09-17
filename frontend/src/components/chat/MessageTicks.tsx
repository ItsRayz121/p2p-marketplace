import { Check, CheckCheck, Clock, AlertCircle } from 'lucide-react'

/** `bubble` = ticks sitting on a solid-color chat bubble (light-on-dark: white
 *  for sent/delivered, sky for read) — the original Messages-thread look.
 *  `muted` = ticks sitting on the page background next to a muted timestamp
 *  (used by the trade-room chats, where the tick isn't inside a colored
 *  bubble) — sent/delivered match the timestamp's muted color, read gets a
 *  primary accent so it still stands out. */
const COLORS = {
  bubble: { sent: 'text-white/70', delivered: 'text-white/70', read: 'text-sky-300', failed: 'text-red-200' },
  muted: { sent: 'text-text-muted', delivered: 'text-text-muted', read: 'text-primary', failed: 'text-danger' },
}

/** WhatsApp-style delivery ticks for a message the viewer sent themselves.
 *  Shared across the 1:1 Messages thread and both trade-room chats (USDT +
 *  CTM) so all three surfaces render receipts identically. `pending`/`failed`
 *  take priority over `status` — they describe a message not yet confirmed by
 *  the server, which has no real id to carry a receipt status yet. */
export function MessageTicks({
  status,
  pending,
  failed,
  variant = 'bubble',
  className = 'w-3.5 h-3.5',
}: {
  status: 'sent' | 'delivered' | 'read' | null
  pending?: boolean
  failed?: boolean
  variant?: 'bubble' | 'muted'
  className?: string
}) {
  const c = COLORS[variant]
  if (pending) return <Clock className={`${className} ${variant === 'bubble' ? 'text-white/70' : 'text-text-muted'}`} aria-label="Sending" />
  if (failed) return <AlertCircle className={`${className} ${c.failed}`} aria-label="Failed to send — tap to retry" />
  if (status === 'read') return <CheckCheck className={`${className} ${c.read}`} aria-label="Read" />
  if (status === 'delivered') return <CheckCheck className={`${className} ${c.delivered}`} aria-label="Delivered" />
  if (status === 'sent') return <Check className={`${className} ${c.sent}`} aria-label="Sent" />
  return null
}
