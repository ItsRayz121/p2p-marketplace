'use client'

import { useState } from 'react'
import type { PortfolioAsset } from '@/lib/portfolio/types'

export const INTEREST_EXPLAINER =
  'Tell RupChain you would like this token listed. Only the token\'s network and contract address are used. Administrators see anonymous totals only, and only once enough people have suggested the same token. They never see your name, holdings, records or notes. This does not list the token, and you can withdraw at any time.'

interface Props {
  asset: PortfolioAsset
  onSuggest?: (assetId: string) => Promise<void>
  onWithdraw?: (assetId: string) => Promise<void>
}

/** Optional, explicit, withdrawable. Separate from everything the tracker needs to work. */
export function ListingInterestBlock({ asset, onSuggest, onWithdraw }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!onSuggest || !onWithdraw) return null
  if (asset.linkedToRupChainToken) return null // already available on RupChain

  const hasIdentity = Boolean(asset.network && asset.contractAddress)

  async function run(fn: (id: string) => Promise<void>) {
    setBusy(true)
    setError(null)
    try { await fn(asset.id) } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.') } finally { setBusy(false) }
  }

  return (
    <section aria-labelledby="interest-heading" className="rounded-xl border border-border bg-surface p-4 space-y-2">
      <h3 id="interest-heading" className="text-sm font-semibold text-text-primary">Suggest this token for listing</h3>
      <p className="text-xs text-text-muted">{INTEREST_EXPLAINER}</p>
      {!hasIdentity ? (
        <p className="text-xs text-text-muted">To suggest it, add its network and contract address first (Edit details). A name alone cannot identify a token.</p>
      ) : asset.listingInterest ? (
        <div className="flex flex-wrap items-center gap-3">
          <span role="status" className="text-sm text-text-primary">You suggested this token.</span>
          <button type="button" disabled={busy} onClick={() => run(onWithdraw)} className="text-sm font-medium text-primary hover:underline disabled:opacity-60">
            Withdraw my suggestion
          </button>
        </div>
      ) : (
        <button type="button" disabled={busy} onClick={() => run(onSuggest)} className="px-3 py-2 text-sm font-semibold rounded-lg border border-border text-text-primary hover:bg-surface-hover disabled:opacity-60">
          {busy ? 'Saving…' : 'I would like this token listed on RupChain'}
        </button>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </section>
  )
}
