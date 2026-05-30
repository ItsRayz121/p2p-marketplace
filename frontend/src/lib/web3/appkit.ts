'use client'
import { createAppKit } from '@reown/appkit/react'
import { wagmiAdapter, WALLETCONNECT_PROJECT_ID, APPKIT_NETWORKS } from './wagmi'

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
    // Same object references used by WagmiAdapter — see wagmi.ts.
    networks: APPKIT_NETWORKS,
    projectId: WALLETCONNECT_PROJECT_ID,
    metadata: {
      name: 'RupChain',
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
