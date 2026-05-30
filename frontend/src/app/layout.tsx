import type { Metadata, Viewport } from 'next'
import Script from 'next/script'
import './globals.css'
import Providers from '@/components/providers/Providers'
import Toaster from '@/components/providers/Toaster'

export const metadata: Metadata = {
  title: 'RupChain — Pakistan P2P Crypto Marketplace',
  description: 'Buy and sell crypto peer-to-peer using JazzCash, Easypaisa, and bank transfer. Fast, safe, and local.',
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  minimumScale: 1,
  themeColor: '#0D1B2A',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const crispId = process.env.NEXT_PUBLIC_CRISP_WEBSITE_ID

  return (
    <html lang="en">
      <body className="min-h-screen bg-canvas antialiased">
        <Providers>
          {children}
          <Toaster />
        </Providers>
        {crispId && (
          <Script id="crisp-widget" strategy="afterInteractive">
            {`window.$crisp=[];window.CRISP_WEBSITE_ID="${crispId}";(function(){var d=document;var s=d.createElement("script");s.src="https://client.crisp.chat/l.js";s.async=1;d.getElementsByTagName("head")[0].appendChild(s);})();`}
          </Script>
        )}
      </body>
    </html>
  )
}
