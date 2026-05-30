'use client'
import { useAccount, useBalance, useChainId } from 'wagmi'
import { getUiChainByChainId, type UiToken } from '@/lib/web3/chains'
import { formatUnits } from 'viem'

function TokenRow({
  symbol,
  address,
  token,
}: {
  symbol: string
  address: `0x${string}`
  token: UiToken
}) {
  const { data, isLoading, error } = useBalance({
    address,
    token: token.address ?? undefined,
  })

  return (
    <div className="flex items-center justify-between px-3 py-2 bg-surface rounded-lg">
      <span className="text-sm font-medium text-text-primary">{symbol}</span>
      <span className="text-sm font-mono text-text-secondary">
        {isLoading ? '…' : error ? '—' : data ? Number(formatUnits(data.value, data.decimals)).toFixed(4) : '0'}
      </span>
    </div>
  )
}

export function ConnectedBalances() {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const ui = getUiChainByChainId(chainId)

  if (!isConnected || !address) return null
  if (!ui) return null // ChainSwitcher already shows the unsupported-chain warning

  const allTokens: UiToken[] = [
    { symbol: ui.nativeSymbol, address: null, decimals: 18 },
    ...ui.tokens,
  ]

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-text-primary">On-chain balances · {ui.name}</h3>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {allTokens.map((t) => (
          <TokenRow
            key={t.symbol + (t.address ?? 'native')}
            symbol={t.symbol}
            address={address}
            token={t}
          />
        ))}
      </div>
      <p className="text-xs text-text-muted">
        These balances are read directly from your connected wallet. To trade on RupChain, deposit to your RupChain address below.
      </p>
    </div>
  )
}
