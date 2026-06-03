import type { Metadata, Viewport } from 'next'
import './globals.css'
import Providers from '@/components/providers/Providers'
import Toaster from '@/components/providers/Toaster'
import SupportChatWidget from '@/components/support/SupportChatWidget'
import { THEME_SCRIPT } from '@/lib/theme'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://rupchain.pk'

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: 'RupChain — Buy & Sell Crypto in Pakistan',
    template: '%s | RupChain',
  },
  description:
    'RupChain is Pakistan\'s trusted P2P crypto marketplace. Buy and sell USDT with JazzCash, Easypaisa, and bank transfer. Escrow-protected trades, KYC-verified traders.',
  keywords: [
    'buy USDT Pakistan', 'sell USDT Pakistan', 'P2P crypto Pakistan',
    'JazzCash crypto', 'Easypaisa USDT', 'crypto exchange Pakistan',
    'rupchain', 'Pakistan crypto marketplace', 'P2P USDT PKR',
  ],
  authors: [{ name: 'RupChain' }],
  creator: 'RupChain',
  publisher: 'RupChain',
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
  openGraph: {
    type: 'website',
    locale: 'en_PK',
    url: BASE_URL,
    siteName: 'RupChain',
    title: 'RupChain — Buy & Sell Crypto in Pakistan',
    description:
      'Pakistan\'s trusted P2P crypto marketplace. Trade USDT safely with JazzCash, Easypaisa, and bank transfer. Escrow-protected, KYC-verified.',
    images: [
      {
        url: '/opengraph-image',
        width: 1200,
        height: 630,
        alt: 'RupChain — Pakistan P2P Crypto Marketplace',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'RupChain — Buy & Sell Crypto in Pakistan',
    description: 'Pakistan\'s trusted P2P crypto marketplace. Trade USDT with JazzCash & Easypaisa.',
    images: ['/opengraph-image'],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large' },
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  minimumScale: 1,
  themeColor: '#0D1B2A',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the anti-FOUC script adds/removes .dark on
    // <html> before React hydrates, which would otherwise cause a mismatch.
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-canvas antialiased">
        {/* Anti-FOUC theme script — must be the very first child of <body>
            so it runs synchronously before any paint or React hydration.
            Not wrapped in <head> because Next.js App Router owns <head>
            via the metadata export; using a manual <head> causes a build error. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <Providers>
          {children}
          <Toaster />
          <SupportChatWidget />
        </Providers>
      </body>
    </html>
  )
}
