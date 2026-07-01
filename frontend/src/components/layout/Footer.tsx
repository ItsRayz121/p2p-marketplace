import Link from 'next/link'
import { BrandLogo } from '@/components/ui/BrandLogo'
import { CommunityIconLinks } from '@/components/layout/CommunityChannels'
import { SUPPORT_EMAIL } from '@/lib/contact'

export default function Footer() {
  return (
    <footer className="bg-surface border-t border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-8 mb-8">

          {/* Brand */}
          <div className="col-span-2 sm:col-span-1">
            <Link href="/" className="flex items-center gap-2 mb-3">
              <BrandLogo size={32} className="w-8 h-8" />
              <span className="font-black text-lg text-text-primary">RupChain</span>
            </Link>
            <p className="text-xs text-text-muted leading-relaxed">
              Pakistan&apos;s trusted P2P crypto marketplace. Buy and sell USDT safely with built-in trade protection.
            </p>
            <p className="text-xs text-text-muted mt-3">
              Proudly built in Pakistan · {SUPPORT_EMAIL}
            </p>
            <CommunityIconLinks className="mt-4" />
          </div>

          {/* Products */}
          <div>
            <h3 className="text-xs font-bold text-text-primary uppercase tracking-wide mb-3">Products</h3>
            <nav className="space-y-2">
              <FooterLink href="/marketplace">USDT Marketplace</FooterLink>
              <FooterLink href="/ctm">Community Tokens</FooterLink>
              <FooterLink href="/gas">Crypto Gas Fees</FooterLink>
              <FooterLink href="/fees">Fee Schedule</FooterLink>
            </nav>
          </div>

          {/* Account */}
          <div>
            <h3 className="text-xs font-bold text-text-primary uppercase tracking-wide mb-3">Account</h3>
            <nav className="space-y-2">
              <FooterLink href="/register">Create Account</FooterLink>
              <FooterLink href="/login">Sign In</FooterLink>
              <FooterLink href="/kyc">KYC Verification</FooterLink>
              <FooterLink href="/referral">Referral Program</FooterLink>
              <FooterLink href="/leaderboard">Leaderboard</FooterLink>
              <FooterLink href="/levels">Trader Levels & Badges</FooterLink>
            </nav>
          </div>

          {/* Company */}
          <div>
            <h3 className="text-xs font-bold text-text-primary uppercase tracking-wide mb-3">Company</h3>
            <nav className="space-y-2">
              <FooterLink href="/about">About Us</FooterLink>
              <FooterLink href="/community">Community</FooterLink>
              <FooterLink href="/help">Help Center</FooterLink>
              <FooterLink href="/terms">Terms of Service</FooterLink>
              <FooterLink href="/privacy">Privacy Policy</FooterLink>
            </nav>
          </div>
        </div>

        <div className="border-t border-border pt-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-xs text-text-muted">
            &copy; {new Date().getFullYear()} RupChain. All rights reserved.
          </p>
          <p className="text-xs text-text-muted text-center">
            Crypto trading involves risk. Only trade what you can afford to lose.
            RupChain does not provide financial advice.
          </p>
        </div>
      </div>
    </footer>
  )
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="block text-sm text-text-muted hover:text-text-primary transition-colors">
      {children}
    </Link>
  )
}
