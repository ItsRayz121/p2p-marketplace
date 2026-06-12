/**
 * On-chain token (non-native) balance readers for gas hot wallets.
 *
 * The native-balance path lives in gas.balance.ts; this module covers ERC-20 /
 * TRC-20 / Aptos fungible-asset balances so the admin panel can show how much
 * USDT/USDC a hot wallet actually holds, and so token delivery (Phase 4) can
 * pre-check token liquidity. Decimals are read on-chain when not supplied.
 */

import { createPublicClient, http, formatUnits } from 'viem'
import type { Chain } from 'viem'
import { arbitrum, avalanche, base, bsc, mainnet, optimism, polygon } from 'viem/chains'
import { env } from '../env'

export interface TokenBalanceResult {
  balance: number
  decimals: number
}

// ── EVM (ERC-20 / BEP-20) ─────────────────────────────────────────────────────

const ERC20_READ_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'decimals',  type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const

const EVM_MAP: Record<string, { chain: Chain; rpc: string }> = {
  BSC:   { chain: bsc,       rpc: env.BSC_RPC_URL },
  ETH:   { chain: mainnet,   rpc: env.ETHEREUM_RPC_URL },
  BASE:  { chain: base,      rpc: env.BASE_RPC_URL },
  ARB:   { chain: arbitrum,  rpc: env.ARBITRUM_RPC_URL },
  OP:    { chain: optimism,  rpc: env.OPTIMISM_RPC_URL },
  MATIC: { chain: polygon,   rpc: env.POLYGON_RPC_URL },
  AVAX:  { chain: avalanche, rpc: env.AVALANCHE_RPC_URL },
}

async function getEvmTokenBalance(
  dbChain: string,
  contract: string,
  owner: string,
  knownDecimals?: number,
): Promise<TokenBalanceResult> {
  const m = EVM_MAP[dbChain]
  if (!m) throw new Error(`getEvmTokenBalance: unsupported EVM chain ${dbChain}`)
  const client = createPublicClient({ chain: m.chain, transport: http(m.rpc, { timeout: 10_000 }) })
  const address = contract as `0x${string}`

  const decimals = knownDecimals ?? Number(
    await client.readContract({ address, abi: ERC20_READ_ABI, functionName: 'decimals' }),
  )
  const raw = await client.readContract({
    address, abi: ERC20_READ_ABI, functionName: 'balanceOf', args: [owner as `0x${string}`],
  }) as bigint
  return { balance: Number(formatUnits(raw, decimals)), decimals }
}

// ── TRON (TRC-20) ───────────────────────────────────────────────────────────

async function getTronTokenBalance(
  contract: string,
  owner: string,
  knownDecimals?: number,
): Promise<TokenBalanceResult> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { TronWeb } = require('tronweb')
  const tronWeb = new TronWeb({
    fullHost: env.TRON_FULLNODE_URL,
    headers: env.TRONGRID_API_KEY ? { 'TRONGRID-API-Key': env.TRONGRID_API_KEY } : {},
  })
  // Read-only calls still need a caller address set on the instance.
  tronWeb.setAddress(owner)
  const c = await tronWeb.contract().at(contract)

  const decimals = knownDecimals ?? Number((await c.decimals().call()).toString())
  const raw = await c.balanceOf(owner).call()
  const balance = Number(raw.toString()) / 10 ** decimals
  return { balance, decimals }
}

// ── Aptos (fungible asset) ────────────────────────────────────────────────────

async function getAptosFaBalance(
  metadata: string,
  owner: string,
  knownDecimals?: number,
): Promise<TokenBalanceResult> {
  const { Aptos, AptosConfig } = await import('@aptos-labs/ts-sdk')
  const config = new AptosConfig({
    fullnode: env.APTOS_FULLNODE_URL,
    indexer:  env.APTOS_INDEXER_URL,
    ...(env.APTOS_API_KEY ? { clientConfig: { API_KEY: env.APTOS_API_KEY } } : {}),
  })
  const aptos = new Aptos(config)

  let decimals = knownDecimals
  if (decimals == null) {
    try {
      const [d] = await aptos.view({
        payload: {
          function: '0x1::fungible_asset::decimals',
          typeArguments: ['0x1::fungible_asset::Metadata'],
          functionArguments: [metadata],
        },
      }) as [number | string]
      decimals = Number(d)
    } catch {
      decimals = 6 // sensible default for USDT/USDC on Aptos
    }
  }

  let rawBal = '0'
  try {
    const [b] = await aptos.view({
      payload: {
        function: '0x1::primary_fungible_store::balance',
        typeArguments: ['0x1::fungible_asset::Metadata'],
        functionArguments: [owner, metadata],
      },
    }) as [string | number]
    rawBal = String(b)
  } catch {
    rawBal = '0' // no primary store yet → zero balance
  }
  return { balance: Number(rawBal) / 10 ** decimals, decimals }
}

// ── Public dispatch ───────────────────────────────────────────────────────────

/**
 * Read a hot wallet's balance of a non-native token. `dbChain` is the GasChain
 * enum value (e.g. 'BSC', 'TRON', 'APT'). `contract` is the ERC-20/TRC-20
 * address or the Aptos fungible-asset metadata address.
 */
export async function getHotWalletTokenBalance(
  dbChain: string,
  contract: string,
  owner: string,
  knownDecimals?: number,
): Promise<TokenBalanceResult> {
  if (dbChain === 'TRON') return getTronTokenBalance(contract, owner, knownDecimals)
  if (dbChain === 'APT' || dbChain === 'APTOS') return getAptosFaBalance(contract, owner, knownDecimals)
  return getEvmTokenBalance(dbChain, contract, owner, knownDecimals)
}
