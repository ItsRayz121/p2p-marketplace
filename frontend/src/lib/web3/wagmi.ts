import { http } from 'viem'
import { mainnet, bsc, polygon, arbitrum, optimism, base } from 'viem/chains'
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { SUPPORTED_CHAINS } from './chains'

/**
 * Reown AppKit project id. Provision one at https://cloud.reown.com and set the
 * value via NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID. Without it, WalletConnect /
 * mobile wallets won't pair (injected wallets like MetaMask still work).
 */
export const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? ''

export const wagmiAdapter = new WagmiAdapter({
  networks: SUPPORTED_CHAINS as unknown as Parameters<typeof WagmiAdapter>[0]['networks'],
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
