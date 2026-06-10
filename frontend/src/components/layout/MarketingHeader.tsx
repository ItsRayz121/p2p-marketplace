'use client'
import Link from 'next/link'
import { BrandLogo } from '@/components/ui/BrandLogo'
import { useAuthStore } from '@/store/auth.store'

// Lightweight header for public marketing pages (homepage). Unlike the
// platform Navbar it has no notification polling or Web3 context, so it can
// render outside the (platform) layout. Guests get Login / Get Started CTAs;
// authenticated users get a single Dashboard link.
const NAV_LINKS = [
  { href: '/marketplace', label: 'Marketplace' },
  { href: '/ctm', label: 'Tokens' },
  { href: '/gas', label: 'Gas Fees' },
  { href: '/fees', label: 'Fees' },
  { href: '/help', label: 'Help' },
]

export function MarketingHeader() {
  const { user, isLoading } = useAuthStore()

  return (
    <header className="sticky top-0 z-40 bg-slate-900/90 backdrop-blur border-b border-slate-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2 flex-shrink-0" aria-label="RupChain home">
          <BrandLogo size={32} className="w-8 h-8" />
          <span className="font-black text-lg text-white">RupChain</span>
        </Link>

        <nav className="hidden md:flex items-center gap-6" aria-label="Main">
          {NAV_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-sm font-medium text-slate-300 hover:text-white transition-colors"
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2 flex-shrink-0">
          {/* While auth hydrates, reserve space without flashing the wrong CTA */}
          {isLoading ? (
            <div className="w-36 h-9" aria-hidden />
          ) : user ? (
            <Link
              href="/dashboard"
              className="px-4 py-2 bg-primary text-white text-sm font-bold rounded-lg hover:bg-primary-hover transition-colors"
            >
              Go to Dashboard
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                className="px-4 py-2 text-sm font-semibold text-slate-200 hover:text-white transition-colors"
              >
                Log In
              </Link>
              <Link
                href="/register"
                className="px-4 py-2 bg-primary text-white text-sm font-bold rounded-lg hover:bg-primary-hover transition-colors shadow-lg shadow-primary/30"
              >
                Get Started
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  )
}
