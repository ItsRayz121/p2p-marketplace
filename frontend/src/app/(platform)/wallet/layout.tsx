import { Web3Provider } from '@/lib/web3/Web3Provider'

export default function WalletLayout({ children }: { children: React.ReactNode }) {
  return <Web3Provider>{children}</Web3Provider>
}
