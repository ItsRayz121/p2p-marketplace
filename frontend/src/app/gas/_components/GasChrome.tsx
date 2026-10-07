'use client'
import Navbar from '@/components/layout/Navbar'
import Footer from '@/components/layout/Footer'
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
  return (
    <div className="flex flex-col min-h-screen">
      <Navbar />
      <main className="flex-1 overflow-x-clip pb-[calc(6rem+env(safe-area-inset-bottom))] lg:pb-0">
        {children}
      </main>
      {/* Gas is never the Home tab, so the marketing footer stays off mobile
          (content is the end of the page) and shows on desktop only. */}
      <div className="hidden lg:block">
        <Footer />
      </div>
      {/* Small support shortcut: opens the RupChain Official support thread in Messages. */}
      <Link
        href="/messages/support"
        aria-label="Chat with support"
        title="Chat with support"
        className="fixed right-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] lg:bottom-6 z-40 flex h-11 w-11 items-center justify-center rounded-full bg-primary text-white shadow-lg hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        <Headphones className="h-5 w-5" />
      </Link>
      <BottomNav />
    </div>
  )
}
