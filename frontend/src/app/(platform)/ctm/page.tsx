'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ctmApi } from '@/lib/api'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'

const RISK_COLORS: Record<string, string> = {
  low: 'bg-green-100 text-green-800',
  medium: 'bg-yellow-100 text-yellow-800',
  high: 'bg-orange-100 text-orange-800',
  extreme: 'bg-red-100 text-red-800',
}

interface CtmToken {
  id: string
  slug: string
  name: string
  symbol: string
  logoUrl?: string
  riskTier: string
  settlementType: string
  totalTrades: number
  totalVolumePkr: string
  _count?: { listings: number; requests: number }
}

function TokenCard({ token }: { token: CtmToken }) {
  return (
    <Link href={`/ctm/tokens/${token.slug}`} className="block bg-white border border-border rounded-xl p-4 hover:shadow-md transition-shadow">
      <div className="flex items-center gap-3 mb-3">
        {token.logoUrl ? (
          <img src={token.logoUrl} alt={token.name} className="w-10 h-10 rounded-full object-cover" />
        ) : (
          <div className="w-10 h-10 rounded-full bg-primary/10 text-primary font-bold text-sm flex items-center justify-center flex-shrink-0">
            {token.symbol.charAt(0)}
          </div>
        )}
        <div className="min-w-0">
          <p className="font-semibold text-text-primary truncate">{token.name}</p>
          <p className="text-xs text-text-muted">{token.symbol}</p>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${RISK_COLORS[token.riskTier] ?? 'bg-gray-100 text-gray-700'}`}>
          {token.riskTier} risk
        </span>
        <Badge variant="default" size="sm">{token.settlementType}</Badge>
      </div>
      <div className="text-xs text-text-muted">
        {token.totalTrades.toLocaleString()} trades · Vol PKR {Number(token.totalVolumePkr).toLocaleString()}
      </div>
    </Link>
  )
}

export default function CtmHomePage() {
  const [tokens, setTokens] = useState<CtmToken[]>([])
  const [loading, setLoading] = useState(true)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    ctmApi.getTokens({ limit: 6 })
      .then((d) => setTokens(d.tokens as CtmToken[]))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">
      {/* Risk disclaimer */}
      {!dismissed && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex gap-3">
          <svg className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-amber-800">Community Token Market — High Risk</p>
            <p className="text-xs text-amber-700 mt-0.5">
              These tokens are community-requested and not exchange-listed. All trades are manual proof-based. PakSwap does not guarantee token value or delivery. Trade with caution.
            </p>
          </div>
          <button onClick={() => setDismissed(true)} className="text-amber-500 hover:text-amber-700 flex-shrink-0">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Hero */}
      <div className="text-center space-y-3">
        <h1 className="text-3xl font-bold text-text-primary">Community Token Market</h1>
        <p className="text-text-muted max-w-xl mx-auto">
          Trade Pi Network, Sidra, VeriChat and other community tokens peer-to-peer with PKR — verified sellers, proof-based settlement.
        </p>
        <div className="flex justify-center gap-3 flex-wrap">
          <Link href="/ctm/listings">
            <Button size="lg">Browse Listings</Button>
          </Link>
          <Link href="/ctm/requests">
            <Button size="lg" variant="secondary">Post a Request</Button>
          </Link>
        </div>
      </div>

      {/* Quick links */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { href: '/ctm/tokens', label: 'Token Directory', icon: '🪙' },
          { href: '/ctm/listings', label: 'Buy/Sell Listings', icon: '📋' },
          { href: '/ctm/requests', label: 'Bid Board', icon: '🤝' },
          { href: '/ctm/merchant-setup', label: 'Become Merchant', icon: '🏪' },
        ].map((item) => (
          <Link key={item.href} href={item.href} className="bg-white border border-border rounded-xl p-4 text-center hover:shadow-md transition-shadow">
            <div className="text-2xl mb-1">{item.icon}</div>
            <p className="text-sm font-medium text-text-primary">{item.label}</p>
          </Link>
        ))}
      </div>

      {/* Featured tokens */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-text-primary">Featured Tokens</h2>
          <Link href="/ctm/tokens" className="text-sm text-primary hover:underline">View all</Link>
        </div>
        {loading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {tokens.map((t) => <TokenCard key={t.id} token={t} />)}
          </div>
        )}
      </div>
    </div>
  )
}
