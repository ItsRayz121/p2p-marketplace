const CHAIN_DISPLAY_NAMES: Record<string, string> = {
  TRON:     'TRON',
  BSC:      'BNB Smart Chain',
  OPBNB:    'opBNB',
  ETHEREUM: 'Ethereum',
  ETH:      'Ethereum',
  BASE:     'Base',
  ARB:      'Arbitrum',
  OP:       'Optimism',
  MATIC:    'Polygon',
  AVAX:     'Avalanche',
  SOL:      'Solana',
  TON:      'TON',
  SUI:      'SUI',
  APT:      'Aptos',
  NEAR:     'NEAR',
}

export function chainDisplayName(chain: string): string {
  return CHAIN_DISPLAY_NAMES[chain.toUpperCase()] ?? chain
}
