'use client'
import { useAccount, useSwitchChain, useChainId } from 'wagmi'
import { SUPPORTED_CHAINS, UI_CHAINS, getUiChainByChainId } from '@/lib/web3/chains'

export function ChainSwitcher() {
  const { isConnected } = useAccount()
  const chainId = useChainId()
  const { switchChain, isPending } = useSwitchChain()

  if (!isConnected) return null

  const currentUi = getUiChainByChainId(chainId)
  const onSupportedChain = !!currentUi

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-xs font-medium text-text-muted">Chain</label>
        <select
          value={chainId ?? ''}
          onChange={(e) => switchChain({ chainId: Number(e.target.value) as (typeof SUPPORTED_CHAINS)[number]['id'] })}
          disabled={isPending}
          className="px-3 py-1.5 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {!onSupportedChain && chainId != null && (
            <option value={chainId}>Unsupported (id {chainId})</option>
          )}
          {UI_CHAINS.map((c) => (
            <option key={c.chainId} value={c.chainId}>
              {c.name}
            </option>
          ))}
        </select>
        {isPending && <span className="text-xs text-text-muted">switching…</span>}
      </div>
      {!onSupportedChain && (
        <div className="bg-warning/10 border border-warning/20 rounded-lg px-3 py-2 text-sm text-warning">
          Your wallet is on an unsupported network. RupChain supports Ethereum, BSC, Polygon, Arbitrum, Optimism and Base. Pick one above to switch.
        </div>
      )}
    </div>
  )
}
