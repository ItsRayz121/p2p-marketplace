'use client'
import { createAppKit } from '@reown/appkit/react'
import { wagmiAdapter, WALLETCONNECT_PROJECT_ID, APPKIT_NETWORKS } from './wagmi'

let initialized = false

/**
 * Whether the WalletConnect/Reown modal can be initialised. Without a project
 * id, calling createAppKit() makes Reown surface a "Project ID Missing" error
 * toast — so we skip it entirely and let the UI fall back to injected
 * (browser-extension) wallets instead. Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
 * (provision a free id at https://cloud.reown.com) to enable mobile pairing.
 */
export const isAppKitEnabled = WALLETCONNECT_PROJECT_ID.length > 0

/**
 * Idempotent AppKit bootstrap. The modal singleton must be created exactly
 * once on the client. Called from the Web3Provider on first mount. No-ops when
 * no project id is configured (prevents the Reown error toast).
 */
export function ensureAppKit() {
  if (initialized || !isAppKitEnabled) return
  initialized = true
  createAppKit({
    adapters: [wagmiAdapter],
    // Same object references used by WagmiAdapter — see wagmi.ts.
    networks: APPKIT_NETWORKS,
    projectId: WALLETCONNECT_PROJECT_ID,
    metadata: {
      name: 'RupChain',
      description: 'Pakistan P2P Crypto Marketplace',
      // Pin to the production origin (current origin at runtime) so the wallet
      // shows the real RupChain identity — guards against spoofed metadata.
      url: typeof window !== 'undefined' ? window.location.origin : 'https://rupchain.pk',
      icons: ['https://rupchain.pk/brand/icon-192.png'],
    },
    features: {
      analytics: false,
      email: false,
      socials: false,
    },
  })
}
