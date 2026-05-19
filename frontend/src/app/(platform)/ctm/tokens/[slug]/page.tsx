'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ctmApi } from '@/lib/api'
import { Badge } from '@/components/ui/Badge'
import { Spinner } from '@/components/ui/Spinner'
import { ErrorState } from '@/components/ui/ErrorState'

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
  bannerUrl?: string
  description: string
  riskTier: string
  riskNotes?: string
  riskLabels: string[]
  settlementType: string
  network?: string
  officialWebsite?: string
  officialTwitter?: string
  officialTelegram?: string
  totalTrades: number
  totalVolumePkr: string
  lastTradedAt?: string
  _count?: { listings: number; requests: number }
}

export default function CtmTokenDetailPage() {
  const { slug } = useParams<{ slug: string }>()
  const [token, setToken] = useState<CtmToken | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!slug) return
    ctmApi.getToken(slug)
      .then((d) => setToken(d as CtmToken))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [slug])

  if (loading) return <div className="flex justify-center py-24"><Spinner /></div>
  if (error || !token) return <ErrorState title="Token not found" description={error ?? 'This token does not exist or has been removed.'} />

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      <Link href="/ctm/tokens" className="text-sm text-primary hover:underline">← Back to Directory</Link>

      {/* Header */}
      <div className="bg-white border border-border rounded-xl p-6">
        <div className="flex items-start gap-4">
          {token.logoUrl ? (
            <img src={token.logoUrl} alt={token.name} className="w-16 h-16 rounded-full object-cover flex-shrink-0" />
          ) : (
            <div className="w-16 h-16 rounded-full bg-primary/10 text-primary text-2xl font-bold flex items-center justify-center flex-shrink-0">
              {token.symbol.charAt(0)}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold text-text-primary">{token.name}</h1>
            <p className="text-text-muted">{token.symbol}</p>
            <div className="flex items-center gap-2 flex-wrap mt-2">
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${RISK_COLORS[token.riskTier] ?? 'bg-gray-100 text-gray-700'}`}>
                {token.riskTier} risk
              </span>
              <Badge variant="default" size="sm">{token.settlementType}</Badge>
              {token.network && <Badge variant="default" size="sm">{token.network}</Badge>}
            </div>
          </div>
        </div>

        <p className="text-sm text-text-muted mt-4">{token.description}</p>

        {token.riskLabels.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {token.riskLabels.map((label) => (
              <span key={label} className="bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded-full">{label}</span>
            ))}
          </div>
        )}

        {token.riskNotes && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mt-3 text-xs text-amber-800">
            <strong>Risk note:</strong> {token.riskNotes}
          </div>
        )}

        {/* Official links */}
        {(token.officialWebsite || token.officialTwitter || token.officialTelegram) && (
          <div className="flex gap-3 mt-4 flex-wrap">
            {token.officialWebsite && (
              <a href={token.officialWebsite} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">Website ↗</a>
            )}
            {token.officialTwitter && (
              <a href={token.officialTwitter} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">Twitter ↗</a>
            )}
            {token.officialTelegram && (
              <a href={token.officialTelegram} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">Telegram ↗</a>
            )}
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Total Trades', value: token.totalTrades.toLocaleString() },
          { label: 'Volume (PKR)', value: `PKR ${Number(token.totalVolumePkr).toLocaleString()}` },
          { label: 'Active Listings', value: (token._count?.listings ?? 0).toString() },
        ].map((stat) => (
          <div key={stat.label} className="bg-white border border-border rounded-xl p-4 text-center">
            <p className="text-xl font-bold text-text-primary">{stat.value}</p>
            <p className="text-xs text-text-muted">{stat.label}</p>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex gap-3 flex-wrap">
        <Link href={`/ctm/listings?tokenId=${token.id}&side=sell`}>
          <button className="bg-primary text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors">
            Browse Sell Listings
          </button>
        </Link>
        <Link href={`/ctm/listings?tokenId=${token.id}&side=buy`}>
          <button className="border border-primary text-primary px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/5 transition-colors">
            Browse Buy Listings
          </button>
        </Link>
        <Link href={`/ctm/requests?tokenId=${token.id}`}>
          <button className="border border-border text-text-primary px-4 py-2 rounded-lg text-sm font-medium hover:bg-surface transition-colors">
            Open Requests
          </button>
        </Link>
        <Link href="/ctm/requests/create">
          <button className="border border-border text-text-primary px-4 py-2 rounded-lg text-sm font-medium hover:bg-surface transition-colors">
            Post a Request
          </button>
        </Link>
      </div>
    </div>
  )
}
