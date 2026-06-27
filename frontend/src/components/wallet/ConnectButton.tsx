'use client'
import { useAccount, useDisconnect, useConnect } from 'wagmi'
import { useAppKit } from '@reown/appkit/react'
import { Button } from '@/components/ui/Button'
import { isAppKitEnabled } from '@/lib/web3/appkit'
import { toast } from '@/lib/toast'

function shortAddr(a: string): string {
  return a.slice(0, 6) + '…' + a.slice(-4)
}

/**
 * WalletConnect/Reown modal path — only rendered when AppKit has actually been
 * created (project id configured), so useAppKit() is never called against an
 * uninitialised modal.
 */
function AppKitConnectButton({ address, isConnected }: { address?: string; isConnected: boolean }) {
  const { open } = useAppKit()
  const { disconnect } = useDisconnect()

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => open({ view: 'Account' })}
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
    <Button size="sm" onClick={() => open()}>
      Connect Wallet
    </Button>
  )
}

/**
 * Fallback path when no WalletConnect project id is configured — connects the
 * injected browser-extension wallet (MetaMask / OKX) directly via wagmi and
 * never touches AppKit, so the Reown "Project ID Missing" error can't fire.
 */
function InjectedConnectButton({ address, isConnected }: { address?: string; isConnected: boolean }) {
  const { connect, connectors } = useConnect()
  const { disconnect } = useDisconnect()

  const handleConnect = () => {
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
        <span className="px-3 py-1.5 text-xs font-mono bg-surface border border-border rounded-lg">
          {shortAddr(address)}
        </span>
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

export function ConnectButton() {
  const { address, isConnected } = useAccount()
  // isAppKitEnabled is a build-time constant, so the branch never changes during
  // a session — each child calls its own hooks unconditionally (hook-safe).
  return isAppKitEnabled
    ? <AppKitConnectButton address={address} isConnected={isConnected} />
    : <InjectedConnectButton address={address} isConnected={isConnected} />
}
