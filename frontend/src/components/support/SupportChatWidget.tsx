'use client'
import { useState, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { X, BadgeCheck } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { SUPPORT_CHAT_OPEN_EVENT } from '@/lib/supportChat'
import { SupportChatThread } from '@/components/support/SupportChatThread'

/**
 * Floating support-chat popup — the quick launcher used from the Help Centre
 * "Live Chat" button and support bell notifications. The Messages inbox instead
 * opens the full-page thread at /messages/support (alongside the trader threads).
 * Both surfaces render the same <SupportChatThread/> so they stay in sync.
 */
export default function SupportChatWidget() {
  const { isAuthenticated } = useAuth()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  // Open via global event (Help page "Live Chat" button, support notifications)
  useEffect(() => {
    const handler = () => setOpen(true)
    window.addEventListener(SUPPORT_CHAT_OPEN_EVENT, handler)
    return () => window.removeEventListener(SUPPORT_CHAT_OPEN_EVENT, handler)
  }, [])

  // Hidden for guests, inside the admin panel (admins reply from the inbox page),
  // and on the dedicated full-page support thread (avoid a popup over the page).
  if (!isAuthenticated || pathname?.startsWith('/admin') || pathname === '/messages/support') return null

  // No floating launcher — chat opens via openSupportChat() (Help Centre
  // "Live Chat" button and support bell notifications)
  return (
    <>
      {open && (
        <div className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] lg:bottom-5 right-5 z-50 w-[calc(100vw-2.5rem)] sm:w-96 h-[32rem] max-h-[calc(100dvh-7rem)] lg:max-h-[calc(100dvh-2.5rem)] bg-surface border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-primary text-white flex-shrink-0">
            <div>
              <p className="font-semibold text-sm flex items-center gap-1">
                RupChain Official
                <BadgeCheck className="w-4 h-4 text-sky-300" aria-label="Verified" />
              </p>
              <p className="text-xs text-white/70">We typically reply within a few hours</p>
            </div>
            <button onClick={() => setOpen(false)} aria-label="Close chat" className="p-1 hover:bg-white/10 rounded-lg">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Shared chat body (messages + composer) */}
          <div className="flex-1 min-h-0">
            <SupportChatThread />
          </div>
        </div>
      )}
    </>
  )
}
