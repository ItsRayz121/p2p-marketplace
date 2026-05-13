'use client'
import { ReactNode, useEffect, useState } from 'react'
import { WagmiProvider, cookieToInitialState } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { wagmiConfig } from './wagmi'
import { ensureAppKit } from './appkit'

export function Web3Provider({
  children,
  cookies,
}: {
  children: ReactNode
  cookies?: string | null
}) {
  const [queryClient] = useState(() => new QueryClient())

  useEffect(() => {
    ensureAppKit()
  }, [])

  const initialState = cookieToInitialState(wagmiConfig, cookies ?? undefined)

  return (
    <WagmiProvider config={wagmiConfig} initialState={initialState}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  )
}
