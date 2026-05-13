import type { Metadata, Viewport } from 'next'
import './globals.css'
import Providers from '@/components/providers/Providers'
import Toaster from '@/components/providers/Toaster'

export const metadata: Metadata = {
  title: 'PakSwap — Pakistan P2P Crypto Exchange',
  description: 'Buy and sell crypto peer-to-peer using JazzCash, Easypaisa, and bank transfer. Fast, safe, and local.',
  manifest: '/manifest.json',
  icons: { icon: '/favicon.svg', apple: '/favicon.svg' },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  minimumScale: 1,
  themeColor: '#2563eb',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-surface antialiased">
        <Providers>
          {children}
          <Toaster />
        </Providers>
      </body>
    </html>
  )
}
