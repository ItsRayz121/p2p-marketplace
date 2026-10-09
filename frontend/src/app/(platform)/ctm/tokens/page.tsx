'use client'
import { useState, useCallback } from 'react'
import Link from 'next/link'
import { ctmApi } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { Badge } from '@/components/ui/Badge'
import { Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { toast } from '@/lib/toast'
import { Coins, Plus } from 'lucide-react'

const RISK_COLORS: Record<string, string> = {
  low: 'bg-green-500/15 text-green-800 dark:text-green-300',
  medium: 'bg-yellow-500/15 text-yellow-800 dark:text-yellow-300',
  high: 'bg-orange-500/15 text-orange-800 dark:text-orange-300',
  extreme: 'bg-red-500/15 text-red-800 dark:text-red-300',
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
  lastTradedAt?: string
  _count?: { listings: number; requests: number }
}

const blankRequest = { tokenName: '', tokenSymbol: '', description: '', officialWebsite: '', evidenceUrl: '' }

export default function CtmTokensPage() {
  const [showRequest, setShowRequest] = useState(false)
  const [req, setReq] = useState(blankRequest)
  const [sending, setSending] = useState(false)

  async function submitRequest() {
    const url = (v: string) => /^https?:\/\/\S+\.\S+/.test(v.trim())
    if (!req.tokenName.trim() || !req.tokenSymbol.trim()) { toast.error('Token name and symbol are required'); return }
    if (req.description.trim().length < 10) { toast.error('Please describe the token in at least 10 characters'); return }
    if (req.officialWebsite.trim() && !url(req.officialWebsite)) { toast.error('Website must start with https://'); return }
    if (req.evidenceUrl.trim() && !url(req.evidenceUrl)) { toast.error('Evidence link must start with https://'); return }
    setSending(true)
    try {
      await ctmApi.suggestToken({
        tokenName: req.tokenName.trim(),
        tokenSymbol: req.tokenSymbol.trim().toUpperCase(),
        description: req.description.trim(),
        ...(req.officialWebsite.trim() ? { officialWebsite: req.officialWebsite.trim() } : {}),
        ...(req.evidenceUrl.trim() ? { evidenceUrl: req.evidenceUrl.trim() } : {}),
      })
      toast.success('Request sent. We will review it and notify you.')
      setReq(blankRequest); setShowRequest(false)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not send request')
    } finally {
      setSending(false)
    }
  }
  const [search, setSearch] = useState('')
  const [settlementType, setSettlementType] = useState('')
  const [riskTier, setRiskTier] = useState('')
  const [tokens, setTokens] = useState<CtmToken[]>([])
  const [loading, setLoading] = useState(true)

  const fetchTokens = useCallback(async () => {
    const params: Record<string, string> = {}
    if (search) params.search = search
    if (settlementType) params.settlementType = settlementType
    if (riskTier) params.riskTier = riskTier

    const data = await ctmApi.getTokens(params)
    setTokens(data.tokens as CtmToken[])
    setLoading(false)
  }, [search, settlementType, riskTier])

  usePolling(fetchTokens, 30_000)

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text-primary">Featured Tokens</h1>
        <div className="flex items-center gap-3">
          <Button size="sm" variant="secondary" onClick={() => setShowRequest(true)}><Plus className="w-4 h-4 mr-1" />Request a token</Button>
          <Link href="/ctm" className="text-sm text-primary hover:underline">← CTM Home</Link>
        </div>
      </div>

      <Modal isOpen={showRequest} onClose={() => setShowRequest(false)} title="Request a token">
        <div className="space-y-3">
          <p className="text-xs text-text-muted">Don&apos;t see your token? Tell us about it. Our team reviews every request before it is listed.</p>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs font-semibold text-text-primary">Token name
              <input value={req.tokenName} maxLength={100} onChange={(e) => setReq({ ...req, tokenName: e.target.value })} className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm" />
            </label>
            <label className="text-xs font-semibold text-text-primary">Symbol
              <input value={req.tokenSymbol} maxLength={20} onChange={(e) => setReq({ ...req, tokenSymbol: e.target.value.toUpperCase() })} className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm uppercase" />
            </label>
          </div>
          <label className="block text-xs font-semibold text-text-primary">What is this token?
            <textarea value={req.description} maxLength={1000} rows={3} onChange={(e) => setReq({ ...req, description: e.target.value })} className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm" />
          </label>
          <label className="block text-xs font-semibold text-text-primary">Official website (optional)
            <input value={req.officialWebsite} type="url" inputMode="url" autoCapitalize="none" placeholder="https://" onChange={(e) => setReq({ ...req, officialWebsite: e.target.value })} className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm" />
          </label>
          <label className="block text-xs font-semibold text-text-primary">Proof link, e.g. explorer or CoinGecko (optional)
            <input value={req.evidenceUrl} type="url" inputMode="url" autoCapitalize="none" placeholder="https://" onChange={(e) => setReq({ ...req, evidenceUrl: e.target.value })} className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm" />
          </label>
          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="primary" onClick={submitRequest} disabled={sending}>{sending ? 'Sending…' : 'Send request'}</Button>
            <Button size="sm" variant="ghost" onClick={() => setShowRequest(false)}>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <input
          type="text"
          placeholder="Search tokens..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="border border-border rounded-lg px-3 py-2 text-sm flex-1 min-w-48 focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        <select
          value={settlementType}
          onChange={(e) => setSettlementType(e.target.value)}
          className="border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        >
          <option value="">All types</option>
          <option value="MANUAL">Manual</option>
          <option value="ON_CHAIN">On-chain</option>
          <option value="HYBRID">Hybrid</option>
        </select>
        <select
          value={riskTier}
          onChange={(e) => setRiskTier(e.target.value)}
          className="border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        >
          <option value="">All risk tiers</option>
          <option value="low">Low risk</option>
          <option value="medium">Medium risk</option>
          <option value="high">High risk</option>
          <option value="extreme">Extreme risk</option>
        </select>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : tokens.length === 0 ? (
        <EmptyState icon={Coins} title="No tokens found" description="Try adjusting your filters." />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {tokens.map((token) => (
            <Link key={token.id} href={`/ctm/tokens/${token.slug}`} className="block bg-surface shadow-card border border-border rounded-xl p-4 hover:shadow-card-md transition-shadow">
              <div className="flex items-center gap-3 mb-3">
                <EntityLogo type="token" slug={token.symbol} size="xl" logoUrl={token.logoUrl} />
                <div className="min-w-0">
                  <p className="font-semibold text-text-primary truncate">{token.name}</p>
                  <p className="text-xs text-text-muted">{token.symbol}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap mb-2">
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${RISK_COLORS[token.riskTier] ?? 'bg-surface-alt text-text-secondary'}`}>
                  {token.riskTier} risk
                </span>
                <Badge variant="default" size="sm">{token.settlementType}</Badge>
              </div>
              <div className="text-xs text-text-muted space-y-0.5">
                <div>{token.totalTrades.toLocaleString()} trades</div>
                {token.lastTradedAt && <div>Last: {new Date(token.lastTradedAt).toLocaleDateString()}</div>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
