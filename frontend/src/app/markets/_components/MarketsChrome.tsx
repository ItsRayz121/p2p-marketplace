'use client'
import Navbar from '@/components/layout/Navbar'
import BottomNav from '@/components/layout/BottomNav'

// Wraps /markets with the same unified Navbar/Footer/BottomNav used across the
// rest of the platform (mirrors GasChrome). Markets sits outside the
// client-only (platform) route group so its pages can be server-rendered for
// SEO (generateMetadata + JSON-LD per token) while still looking identical to
// every other section.
export default function MarketsChrome({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col min-h-screen">
      <Navbar />
      <main className="flex-1 overflow-x-clip pb-[calc(6rem+env(safe-area-inset-bottom))] lg:pb-0">
        {children}
        <p className="mx-auto max-w-6xl px-4 py-6 text-center text-xs text-text-muted">
          Global reference prices and 24h/7d changes powered by{' '}
          <a href="https://www.coingecko.com/?utm_source=rupchain&utm_medium=referral" target="_blank" rel="noopener noreferrer" className="underline hover:text-text-primary">
            CoinGecko
          </a>
          . P2P prices on RupChain are set by traders.
        </p>
      </main>
      <BottomNav />
    </div>
  )
}
