import { BrandLogo } from '@/components/ui/BrandLogo'
import Link from 'next/link'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md bg-surface rounded-2xl shadow-card-lg border border-border p-8">
        <div className="flex flex-col items-center mb-8">
          <Link href="/" className="flex items-center gap-2.5">
            <BrandLogo size={40} className="w-10 h-10" />
            <span className="font-black text-2xl text-text-primary tracking-tight">RupChain</span>
          </Link>
          <p className="text-text-muted text-sm mt-2">Pakistan&apos;s P2P Crypto Marketplace</p>
        </div>
        {children}
      </div>
    </div>
  )
}
