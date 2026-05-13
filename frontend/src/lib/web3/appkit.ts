'use client'
import { createAppKit } from '@reown/appkit/react'
import { mainnet, bsc, polygon, arbitrum, optimism, base } from '@reown/appkit/networks'
import { wagmiAdapter, WALLETCONNECT_PROJECT_ID } from './wagmi'

let initialized = false

/**
 * Idempotent AppKit bootstrap. The modal singleton must be created exactly
 * once on the client. Called from the Web3Provider on first mount.
 */
export function ensureAppKit() {
  if (initialized) return
  initialized = true
  createAppKit({
    adapters: [wagmiAdapter],
    networks: [mainnet, bsc, polygon, arbitrum, optimism, base],
    projectId: WALLETCONNECT_PROJECT_ID,
    metadata: {
      name: 'PakSwap',
      description: 'Pakistan P2P Crypto Marketplace',
      url: typeof window !== 'undefined' ? window.location.origin : 'https://p2p-marketplace-kappa.vercel.app',
      icons: ['https://p2p-marketplace-kappa.vercel.app/favicon.ico'],
    },
    features: {
      analytics: false,
      email: false,
      socials: false,
    },
  })
}
