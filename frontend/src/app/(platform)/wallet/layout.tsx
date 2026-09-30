// The wallet route no longer mounts Web3Provider: the connect-wallet UI was
// retired with the "Payment Methods" rename, so nothing here needs wagmi and
// its (large) bundle stays out of this page. Bring it back here if a connect
// flow returns.
export default function WalletLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
