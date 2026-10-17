'use client'
import { useEffect, useState } from 'react'
import Navbar from '@/components/layout/Navbar'
import BottomNav from '@/components/layout/BottomNav'
import Link from 'next/link'
import { Headphones } from 'lucide-react'

// Wraps the /gas section with the same unified site header (Navbar), Footer, and
// mobile BottomNav used across the rest of the platform, so the Crypto Gas Fees
// tab is visually consistent with USDT Marketplace / Community Tokens / Dashboard
// on desktop, mobile, and inside Telegram. (No Web3Provider here — the gas flow
// pays via deposit QR, not wallet-connect, and wrapping it would spin up
// WalletConnect unnecessarily.)
export default function GasChrome({ children }: { children: React.ReactNode }) {
  // The support shortcut steps aside while someone is typing (on-screen keyboard open), so it can never
  // sit on top of an input or the Submit/Verify button next to it.
  const [typing, setTyping] = useState(false)
  useEffect(() => {
    const isField = (t: EventTarget | null) => t instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)
    const on = (e: FocusEvent) => { if (isField(e.target)) setTyping(true) }
    const off = () => setTyping(false)
    document.addEventListener('focusin', on)
    document.addEventListener('focusout', off)
    return () => { document.removeEventListener('focusin', on); document.removeEventListener('focusout', off) }
  }, [])

  return (
    <div className="flex flex-col min-h-screen">
      <Navbar />
      <main className="flex-1 overflow-x-clip pb-[calc(8.5rem+env(safe-area-inset-bottom))] lg:pb-0">
        {children}
      </main>
      {/* Support shortcut: a slim edge tab just above the bottom bar (page padding clears it at the end of
          every screen), so it does not cover the main button or inputs. */}
      <Link
        href="/messages/support"
        aria-label="Chat with support"
        title="Chat with support"
        className={`fixed right-0 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] lg:bottom-6 lg:right-4 z-40 flex h-11 w-9 items-center justify-center rounded-l-2xl bg-primary text-white shadow-lg transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 lg:h-11 lg:w-11 lg:rounded-full ${typing ? 'pointer-events-none opacity-0' : 'opacity-90'}`}
      >
        <Headphones className="h-5 w-5" />
      </Link>
      <BottomNav />
    </div>
  )
}
