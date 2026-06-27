import { http } from 'viem'
import { mainnet, bsc, polygon, arbitrum, optimism, base } from '@reown/appkit/networks'
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'

/**
 * Reown AppKit project id (provisioned at https://cloud.reown.com — RupChain /
 * PakSwap team project). This value is NOT a secret: AppKit embeds it in the
 * client bundle by design, and it's protected by the allowed-domains list in
 * the Reown dashboard rather than by keeping it private. The env var override
 * lets us rotate it without a code change. Without any id, WalletConnect /
 * mobile pairing is disabled (injected wallets like MetaMask still work).
 */
export const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '61dd45a14b857501cf6f976bab316897'

/**
 * EVM networks RupChain supports. Imported from `@reown/appkit/networks` (which
 * re-exports the viem chain defs with AppKit's type wrapping) so the same
 * references flow into both `WagmiAdapter` and `createAppKit()`. If we mixed
 * viem-chain refs with AppKit-chain refs the modal would silently fail to
 * recognise the active chain.
 */
export const APPKIT_NETWORKS = [mainnet, bsc, polygon, arbitrum, optimism, base] as [
  typeof mainnet, typeof bsc, typeof polygon, typeof arbitrum, typeof optimism, typeof base,
]

export const wagmiAdapter = new WagmiAdapter({
  networks: APPKIT_NETWORKS,
  projectId: WALLETCONNECT_PROJECT_ID,
  ssr: true,
  transports: {
    [mainnet.id]: http(),
    [bsc.id]: http(),
    [polygon.id]: http(),
    [arbitrum.id]: http(),
    [optimism.id]: http(),
    [base.id]: http(),
  },
})

export const wagmiConfig = wagmiAdapter.wagmiConfig
