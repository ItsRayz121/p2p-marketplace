'use client'
import Navbar from '@/components/layout/Navbar'
import Footer from '@/components/layout/Footer'
import BottomNav from '@/components/layout/BottomNav'

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
      <Footer />
      <BottomNav />
    </div>
  )
}
