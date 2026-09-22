'use client'
import Navbar from '@/components/layout/Navbar'
import Footer from '@/components/layout/Footer'
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
      </main>
      <div className="hidden lg:block">
        <Footer />
      </div>
      <BottomNav />
    </div>
  )
}
