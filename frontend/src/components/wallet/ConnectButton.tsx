'use client'
import { useAccount, useDisconnect } from 'wagmi'
import { useAppKit } from '@reown/appkit/react'
import { Button } from '@/components/ui/Button'

function shortAddr(a: string): string {
  return a.slice(0, 6) + '…' + a.slice(-4)
}

export function ConnectButton() {
  const { address, isConnected } = useAccount()
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
