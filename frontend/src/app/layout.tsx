import type { Metadata, Viewport } from 'next'
import Script from 'next/script'
import './globals.css'
import Providers from '@/components/providers/Providers'
import Toaster from '@/components/providers/Toaster'

export const metadata: Metadata = {
  title: 'RupChain — Pakistan P2P Crypto Marketplace',
  description: 'Buy and sell crypto peer-to-peer using JazzCash, Easypaisa, and bank transfer. Fast, safe, and local.',
  manifest: '/manifest.json',
  icons: { icon: '/brand/logo-icon.png', apple: '/brand/logo-icon-white.png' },
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
