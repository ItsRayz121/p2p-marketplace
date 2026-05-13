import Link from 'next/link'

export default function Footer() {
  return (
    <footer className="bg-surface border-t border-border py-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-sm text-text-muted">
            &copy; {new Date().getFullYear()} PakSwap. All rights reserved.
          </p>
          <nav className="flex items-center gap-4 flex-wrap justify-center">
            <FooterLink href="/about">About</FooterLink>
            <FooterLink href="/terms">Terms</FooterLink>
            <FooterLink href="/privacy">Privacy</FooterLink>
            <FooterLink href="/fees">Fees</FooterLink>
          </nav>
        </div>
      </div>
    </footer>
  )
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="text-sm text-text-muted hover:text-text-primary transition-colors"
    >
      {children}
    </Link>
  )
}
