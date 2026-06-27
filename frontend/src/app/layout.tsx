import type { Metadata, Viewport } from 'next'
import Script from 'next/script'
import './globals.css'
import Providers from '@/components/providers/Providers'
import Toaster from '@/components/providers/Toaster'
import SupportChatWidget from '@/components/support/SupportChatWidget'
import TelegramPolish from '@/components/providers/TelegramPolish'
import { THEME_SCRIPT } from '@/lib/theme'
import { TELEGRAM_DETECT_SCRIPT } from '@/lib/telegram'

const GA_ID = 'G-8RBC5X1N38'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://rupchain.com'

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
    // Chain-badge PNGs only — the old simplified-R favicon.svg is retired so the
    // unified RupChain mark shows in the browser tab too.
    icon: [
      // /favicon.ico (new chain-badge mark) is what default favicon crawlers
      // and password managers fetch from the site root — kept in sync with the
      // PNGs so no stale "R" art can surface anywhere.
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon-48x48.png', sizes: '48x48', type: 'image/png' },
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
  // viewport-fit=cover lets content extend under the notch/home indicator so
  // safe-area-inset-* env() values are non-zero in the Telegram WebView.
  viewportFit: 'cover',
  themeColor: '#0D1B2A',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the anti-FOUC script adds/removes .dark on
    // <html> before React hydrates, which would otherwise cause a mismatch.
    <html lang="en" suppressHydrationWarning>
      {/* overflow-x-clip on <body> is the app-wide horizontal-overflow backstop:
          it covers EVERY route — including standalone ones outside the platform
          shell (/gas, /leaderboard, /admin, auth) — so no page can ever scroll
          sideways on a phone. `clip` (not `hidden`) is deliberate: it doesn't
          create a scroll container, so sticky navbars/headers keep working, and
          it's ignored gracefully on older WebViews (no regression). */}
      <body className="min-h-screen bg-canvas antialiased overflow-x-clip">
        {/* Anti-FOUC theme script — must be the very first child of <body>
            so it runs synchronously before any paint or React hydration.
            Not wrapped in <head> because Next.js App Router owns <head>
            via the metadata export; using a manual <head> causes a build error. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* Telegram detection — must run synchronously BEFORE any other script
            so window.__IS_TELEGRAM__ / __TG_INIT_DATA__ are set from the launch
            hash before React hydrates or any guard runs. Auth never depends on
            the async telegram-web-app.js SDK loading. */}
        <script dangerouslySetInnerHTML={{ __html: TELEGRAM_DETECT_SCRIPT }} />
        <Providers>
          {children}
          <Toaster />
          <SupportChatWidget />
          <TelegramPolish />
        </Providers>
        <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`} strategy="afterInteractive" />
        <Script id="gtag-init" strategy="afterInteractive">{`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${GA_ID}');
        `}</Script>
      </body>
    </html>
  )
}
