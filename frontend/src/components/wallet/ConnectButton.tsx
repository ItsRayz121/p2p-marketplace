'use client'
import { useAccount, useDisconnect, useConnect } from 'wagmi'
import { useAppKit } from '@reown/appkit/react'
import { Button } from '@/components/ui/Button'
import { isAppKitEnabled } from '@/lib/web3/appkit'
import { toast } from '@/lib/toast'

function shortAddr(a: string): string {
  return a.slice(0, 6) + '…' + a.slice(-4)
}

export function ConnectButton() {
  const { address, isConnected } = useAccount()
  const { open } = useAppKit()
  const { disconnect } = useDisconnect()
  const { connect, connectors } = useConnect()

  // When the WalletConnect modal is configured, use it (covers mobile + many
  // wallets). Otherwise fall back to the injected browser-extension wallet so
  // MetaMask/OKX users can still connect — and the Reown "Project ID Missing"
  // error never surfaces.
  const handleConnect = () => {
    if (isAppKitEnabled) {
      open()
      return
    }
    const injected = connectors.find((c) => c.type === 'injected' || c.id === 'injected')
    if (injected) {
      connect({ connector: injected })
    } else {
      toast.error('No browser wallet found. Install MetaMask or OKX Wallet to connect.')
    }
  }

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => isAppKitEnabled ? open({ view: 'Account' }) : undefined}
          className="px-3 py-1.5 text-xs font-mono bg-surface border border-border rounded-lg hover:border-primary/40 transition-colors"
        >
          {shortAddr(address)}
        </button>
        <Button size="sm" variant="ghost" onClick={() => disconnect()}>
          Disconnect
        </Button>
      </div>
    )
  }

  return (
    <Button size="sm" onClick={handleConnect}>
      Connect Wallet
    </Button>
  )
}
