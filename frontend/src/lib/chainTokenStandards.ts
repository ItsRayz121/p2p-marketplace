export interface TokenStandard {
  value: string
  label: string
  isNative?: boolean
  hasContract: boolean
}

export interface AddressFormat {
  encoding: 'hex' | 'base58' | 'base64' | 'bech32' | 'hex64' | 'utf8'
  prefix: string
  checksummed: boolean
  example: string
  regex: string
}

export interface ChainMeta {
  category: string
  defaultAddressType: string
  nativeSymbol: string
  evmChainId?: number
  explorerBase: string
  networkLabel: string
  addressFormat: AddressFormat
  tokenStandards: TokenStandard[]
}

export const CHAIN_META: Record<string, ChainMeta> = {
  ethereum: {
    category: 'ethereum', defaultAddressType: 'EVM', nativeSymbol: 'ETH',
    evmChainId: 1, networkLabel: 'ERC20',
    explorerBase: 'https://etherscan.io',
    addressFormat: {
      encoding: 'hex', prefix: '0x', checksummed: true,
      example: '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B',
      regex: '^0x[0-9a-fA-F]{40}$',
    },
    tokenStandards: [
      { value: 'native',  label: 'ETH (Native)',            isNative: true, hasContract: false },
      { value: 'erc20',   label: 'ERC-20 (Fungible Token)',                 hasContract: true  },
      { value: 'erc721',  label: 'ERC-721 (NFT)',                           hasContract: true  },
      { value: 'erc1155', label: 'ERC-1155 (Multi-Token)',                  hasContract: true  },
    ],
  },

  bnb: {
    category: 'bnb', defaultAddressType: 'EVM', nativeSymbol: 'BNB',
    evmChainId: 56, networkLabel: 'BEP20',
    explorerBase: 'https://bscscan.com',
    addressFormat: {
      encoding: 'hex', prefix: '0x', checksummed: true,
      example: '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B',
      regex: '^0x[0-9a-fA-F]{40}$',
    },
    tokenStandards: [
      { value: 'native', label: 'BNB (Native)',             isNative: true, hasContract: false },
      { value: 'bep20',  label: 'BEP-20 (Fungible Token)',                  hasContract: true  },
      { value: 'bep721', label: 'BEP-721 (NFT)',                            hasContract: true  },
    ],
  },

  tron: {
    category: 'tron', defaultAddressType: 'TRC20', nativeSymbol: 'TRX',
    networkLabel: 'TRC20',
    explorerBase: 'https://tronscan.org/#',
    addressFormat: {
      encoding: 'base58', prefix: 'T', checksummed: true,
      example: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE',
      regex: '^T[0-9A-Za-z]{33}$',
    },
    tokenStandards: [
      { value: 'native', label: 'TRX (Native)',             isNative: true, hasContract: false },
      { value: 'trc10',  label: 'TRC-10 (Token ID)',                        hasContract: false },
      { value: 'trc20',  label: 'TRC-20 (Fungible Token)',                  hasContract: true  },
      { value: 'trc721', label: 'TRC-721 (NFT)',                            hasContract: true  },
    ],
  },

  solana: {
    category: 'solana', defaultAddressType: 'SOL', nativeSymbol: 'SOL',
    networkLabel: 'SPL',
    explorerBase: 'https://solscan.io',
    addressFormat: {
      encoding: 'base58', prefix: '', checksummed: false,
      example: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      regex: '^[1-9A-HJ-NP-Za-km-z]{32,44}$',
    },
    tokenStandards: [
      { value: 'native',  label: 'SOL (Native)',            isNative: true, hasContract: false },
      { value: 'spl',     label: 'SPL Token',                               hasContract: true  },
      { value: 'spl2022', label: 'Token-2022 (SPL Extensions)',             hasContract: true  },
    ],
  },

  ton: {
    category: 'ton', defaultAddressType: 'TON', nativeSymbol: 'TON',
    networkLabel: 'TON',
    explorerBase: 'https://tonscan.org',
    addressFormat: {
      encoding: 'base64', prefix: 'UQ or EQ', checksummed: true,
      example: 'UQBFzmF3n4FUkuL1McRY4QMwVhGQDSp5vCuvkm2-mG1JLGXL',
      regex: '^[UE]Q[A-Za-z0-9_\\-]{46}$',
    },
    tokenStandards: [
      { value: 'native',  label: 'TON (Native)',            isNative: true, hasContract: false },
      { value: 'jetton',  label: 'Jetton (TEP-74 Fungible)',               hasContract: true  },
      { value: 'nft_ton', label: 'NFT (TEP-62)',                           hasContract: true  },
    ],
  },

  sui: {
    category: 'sui', defaultAddressType: 'SUI', nativeSymbol: 'SUI',
    networkLabel: 'SUI',
    explorerBase: 'https://suiscan.xyz',
    addressFormat: {
      encoding: 'hex64', prefix: '0x', checksummed: false,
      example: '0x0000000000000000000000000000000000000000000000000000000000000002',
      regex: '^0x[0-9a-fA-F]{1,64}$',
    },
    tokenStandards: [
      { value: 'native',  label: 'SUI (Native)',            isNative: true, hasContract: false },
      { value: 'coin',    label: 'Coin<T> (Fungible)',                      hasContract: true  },
      { value: 'nft_sui', label: 'NFT Object',                             hasContract: true  },
    ],
  },

  avalanche: {
    category: 'avalanche', defaultAddressType: 'EVM', nativeSymbol: 'AVAX',
    evmChainId: 43114, networkLabel: 'AVAX C-Chain',
    explorerBase: 'https://snowtrace.io',
    addressFormat: {
      encoding: 'hex', prefix: '0x', checksummed: true,
      example: '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B',
      regex: '^0x[0-9a-fA-F]{40}$',
    },
    tokenStandards: [
      { value: 'native', label: 'AVAX (Native C-Chain)',    isNative: true, hasContract: false },
      { value: 'erc20',  label: 'ERC-20 (C-Chain)',                         hasContract: true  },
      { value: 'arc20',  label: 'ARC-20 (Inscriptions)',                    hasContract: false },
    ],
  },

  polygon: {
    category: 'polygon', defaultAddressType: 'EVM', nativeSymbol: 'POL',
    evmChainId: 137, networkLabel: 'POLYGON',
    explorerBase: 'https://polygonscan.com',
    addressFormat: {
      encoding: 'hex', prefix: '0x', checksummed: true,
      example: '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B',
      regex: '^0x[0-9a-fA-F]{40}$',
    },
    tokenStandards: [
      { value: 'native', label: 'POL (Native)',             isNative: true, hasContract: false },
      { value: 'erc20',  label: 'ERC-20 (Polygon)',                         hasContract: true  },
    ],
  },

  arbitrum: {
    category: 'arbitrum', defaultAddressType: 'EVM', nativeSymbol: 'ETH',
    evmChainId: 42161, networkLabel: 'ARBITRUM',
    explorerBase: 'https://arbiscan.io',
    addressFormat: {
      encoding: 'hex', prefix: '0x', checksummed: true,
      example: '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B',
      regex: '^0x[0-9a-fA-F]{40}$',
    },
    tokenStandards: [
      { value: 'native', label: 'ETH (Native)',             isNative: true, hasContract: false },
      { value: 'erc20',  label: 'ERC-20 (Arbitrum)',                        hasContract: true  },
    ],
  },

  optimism: {
    category: 'optimism', defaultAddressType: 'EVM', nativeSymbol: 'ETH',
    evmChainId: 10, networkLabel: 'OPTIMISM',
    explorerBase: 'https://optimistic.etherscan.io',
    addressFormat: {
      encoding: 'hex', prefix: '0x', checksummed: true,
      example: '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B',
      regex: '^0x[0-9a-fA-F]{40}$',
    },
    tokenStandards: [
      { value: 'native', label: 'ETH (Native)',             isNative: true, hasContract: false },
      { value: 'erc20',  label: 'ERC-20 (Optimism)',                        hasContract: true  },
    ],
  },

  base: {
    category: 'base', defaultAddressType: 'EVM', nativeSymbol: 'ETH',
    evmChainId: 8453, networkLabel: 'BASE',
    explorerBase: 'https://basescan.org',
    addressFormat: {
      encoding: 'hex', prefix: '0x', checksummed: true,
      example: '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B',
      regex: '^0x[0-9a-fA-F]{40}$',
    },
    tokenStandards: [
      { value: 'native', label: 'ETH (Native)',             isNative: true, hasContract: false },
      { value: 'erc20',  label: 'ERC-20 (Base)',                            hasContract: true  },
    ],
  },

  bitcoin: {
    category: 'bitcoin', defaultAddressType: 'BTC_BECH32', nativeSymbol: 'BTC',
    networkLabel: 'BTC',
    explorerBase: 'https://mempool.space',
    addressFormat: {
      encoding: 'bech32', prefix: 'bc1', checksummed: true,
      example: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      regex: '^(1|3)[1-9A-HJ-NP-Za-km-z]{25,34}$|^bc1[0-9a-z]{39,59}$',
    },
    tokenStandards: [
      { value: 'native', label: 'BTC (Native)',             isNative: true, hasContract: false },
      { value: 'brc20',  label: 'BRC-20 (Ordinals)',                        hasContract: false },
      { value: 'runes',  label: 'Runes',                                    hasContract: false },
    ],
  },

  xrp: {
    category: 'xrp', defaultAddressType: 'XRP', nativeSymbol: 'XRP',
    networkLabel: 'XRP',
    explorerBase: 'https://xrpscan.com',
    addressFormat: {
      encoding: 'base58', prefix: 'r', checksummed: true,
      example: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
      regex: '^r[1-9A-HJ-NP-Za-km-z]{24,34}$',
    },
    tokenStandards: [
      { value: 'native', label: 'XRP (Native)',             isNative: true, hasContract: false },
      { value: 'iou',    label: 'IOU / Issued Asset',                       hasContract: false },
    ],
  },

  cosmos: {
    category: 'cosmos', defaultAddressType: 'COSMOS', nativeSymbol: 'ATOM',
    networkLabel: 'COSMOS',
    explorerBase: 'https://mintscan.io/cosmos',
    addressFormat: {
      encoding: 'bech32', prefix: 'cosmos1', checksummed: true,
      example: 'cosmos1qnk2n4nlkpw9xfqntladh74er2xa62wgas4qlz',
      regex: '^cosmos1[0-9a-z]{38}$',
    },
    tokenStandards: [
      { value: 'native', label: 'ATOM (Native)',            isNative: true, hasContract: false },
      { value: 'cw20',   label: 'CW-20 (CosmWasm Fungible)',               hasContract: true  },
      { value: 'ibc',    label: 'IBC Token',                               hasContract: false },
    ],
  },
}

export const CHAIN_CATEGORIES = [
  // L1s
  { value: 'ethereum',  label: 'Ethereum (L1 EVM)',          addressType: 'EVM'        },
  { value: 'bnb',       label: 'BNB Smart Chain (EVM)',      addressType: 'EVM'        },
  { value: 'tron',      label: 'TRON (L1)',                  addressType: 'TRC20'      },
  { value: 'solana',    label: 'Solana (L1)',                addressType: 'SOL'        },
  { value: 'ton',       label: 'TON (L1)',                   addressType: 'TON'        },
  { value: 'sui',       label: 'SUI (L1)',                   addressType: 'SUI'        },
  { value: 'avalanche', label: 'Avalanche C-Chain (EVM L1)', addressType: 'EVM'        },
  { value: 'bitcoin',   label: 'Bitcoin (L1)',               addressType: 'BTC_BECH32' },
  { value: 'xrp',       label: 'XRP Ledger (L1)',            addressType: 'XRP'        },
  { value: 'cosmos',    label: 'Cosmos Hub (L1)',            addressType: 'COSMOS'     },
  // EVM L2s
  { value: 'polygon',   label: 'Polygon (EVM L2)',           addressType: 'EVM'        },
  { value: 'arbitrum',  label: 'Arbitrum One (EVM L2)',      addressType: 'EVM'        },
  { value: 'optimism',  label: 'Optimism (EVM L2)',          addressType: 'EVM'        },
  { value: 'base',      label: 'Base (EVM L2)',              addressType: 'EVM'        },
]

export const ADDRESS_TYPES = [
  { value: 'EVM',         label: 'EVM (0x...)',              regex: '^0x[0-9a-fA-F]{40}$' },
  { value: 'TRC20',       label: 'TRON (T...)',              regex: '^T[0-9A-Za-z]{33}$' },
  { value: 'SOL',         label: 'Solana (Base58)',          regex: '^[1-9A-HJ-NP-Za-km-z]{32,44}$' },
  { value: 'TON',         label: 'TON (UQ.../EQ...)',        regex: '^[UE]Q[A-Za-z0-9_\\-]{46}$' },
  { value: 'SUI',         label: 'SUI (0x + 64 hex)',        regex: '^0x[0-9a-fA-F]{1,64}$' },
  { value: 'BTC_BECH32',  label: 'Bitcoin SegWit (bc1...)',  regex: '^bc1[0-9a-z]{39,59}$' },
  { value: 'BTC_LEGACY',  label: 'Bitcoin Legacy (1...)',    regex: '^1[1-9A-HJ-NP-Za-km-z]{25,34}$' },
  { value: 'BTC_P2SH',    label: 'Bitcoin P2SH (3...)',      regex: '^3[1-9A-HJ-NP-Za-km-z]{25,34}$' },
  { value: 'XRP',         label: 'XRP (r...)',               regex: '^r[1-9A-HJ-NP-Za-km-z]{24,34}$' },
  { value: 'COSMOS',      label: 'Cosmos (cosmos1...)',      regex: '^cosmos1[0-9a-z]{38}$' },
  { value: 'APTOS',       label: 'Aptos (0x + 64 hex)',      regex: '^0x[0-9a-fA-F]{1,64}$' },
  { value: 'NEAR',        label: 'NEAR (account.near)',      regex: '^[a-z0-9_.\\-]{2,64}(\\.near)?$' },
]
