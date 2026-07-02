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
import { arbitrum, avalanche, base, bsc, mainnet, opBNB, optimism, polygon } from 'viem/chains'
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
  OPBNB: { chain: opBNB,     rpc: env.OPBNB_RPC_URL },
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

/**
 * Ordered TRON full-node hosts: the operator primary first (carries the API key),
 * then any configured fallbacks. De-duplicated. Only the primary is treated as
 * keyed — a TronGrid key is not valid on a different provider.
 */
function getTronHostsInOrder(): Array<{ host: string; isPrimary: boolean }> {
  const primary = env.TRON_FULLNODE_URL.replace(/\/$/, '')
  const fallbacks = (env.TRON_FULLNODE_FALLBACK_URLS ?? '')
    .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean)
  const seen = new Set<string>()
  const out: Array<{ host: string; isPrimary: boolean }> = []
  for (const [i, host] of [primary, ...fallbacks].entries()) {
    if (seen.has(host)) continue
    seen.add(host)
    out.push({ host, isPrimary: i === 0 })
  }
  return out
}

async function getTronTokenBalance(
  contract: string,
  owner: string,
  knownDecimals?: number,
): Promise<TokenBalanceResult> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { TronWeb } = require('tronweb')

  let lastErr: unknown
  for (const { host, isPrimary } of getTronHostsInOrder()) {
    try {
      const tronWeb = new TronWeb({
        fullHost: host,
        // TronGrid authenticates via the TRON-PRO-API-KEY header. An earlier
        // misspelt header name was silently ignored, so the key never applied
        // and every read hit the anonymous rate limit (429). Only the primary
        // gets the key.
        headers: isPrimary && env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY } : {},
      })
      // Read-only calls still need a caller address set on the instance.
      tronWeb.setAddress(owner)
      const c = await tronWeb.contract().at(contract)

      const decimals = knownDecimals ?? Number((await c.decimals().call()).toString())
      const raw = await c.balanceOf(owner).call()
      const balance = Number(raw.toString()) / 10 ** decimals
      return { balance, decimals }
    } catch (err) {
      lastErr = err // try the next host
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('TRON token balance read failed on all hosts')
}

// ── Solana (SPL token) ────────────────────────────────────────────────────────

async function getSolanaTokenBalance(
  mint: string,
  owner: string,
  knownDecimals?: number,
): Promise<TokenBalanceResult> {
  const rpc = async (method: string, params: unknown[]) => {
    const res = await fetch(env.SOL_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`Solana RPC ${method} HTTP ${res.status}`)
    const data = await res.json() as { result?: unknown; error?: { message: string } }
    if (data.error) throw new Error(`Solana RPC error: ${data.error.message}`)
    return data.result
  }

  // Sum every SPL token account the owner holds for this mint (there can be >1).
  const accts = await rpc('getTokenAccountsByOwner', [
    owner,
    { mint },
    { encoding: 'jsonParsed', commitment: 'confirmed' },
  ]) as {
    value?: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string; decimals: number } } } } } }>
  }

  const rows = accts?.value ?? []
  if (rows.length > 0) {
    const decimals = knownDecimals ?? rows[0]!.account.data.parsed.info.tokenAmount.decimals
    const rawSum = rows.reduce((sum, r) => sum + BigInt(r.account.data.parsed.info.tokenAmount.amount), 0n)
    return { balance: Number(formatUnits(rawSum, decimals)), decimals }
  }

  // No token account yet → zero balance. Pull decimals from the mint supply so the
  // UI still shows the right precision label.
  let decimals = knownDecimals
  if (decimals == null) {
    try {
      const sup = await rpc('getTokenSupply', [mint, { commitment: 'confirmed' }]) as { value?: { decimals?: number } }
      decimals = sup?.value?.decimals ?? 6
    } catch {
      decimals = 6
    }
  }
  return { balance: 0, decimals }
}

// ── SUI (Coin<T>) ───────────────────────────────────────────────────────────

async function getSuiTokenBalance(
  coinType: string,
  owner: string,
  knownDecimals?: number,
): Promise<TokenBalanceResult> {
  const rpc = async (method: string, params: unknown[]) => {
    const res = await fetch(env.SUI_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`SUI RPC ${method} HTTP ${res.status}`)
    const data = await res.json() as { result?: unknown; error?: { message: string } }
    if (data.error) throw new Error(`SUI RPC error: ${data.error.message}`)
    return data.result
  }

  let decimals = knownDecimals
  if (decimals == null) {
    try {
      const meta = await rpc('suix_getCoinMetadata', [coinType]) as { decimals?: number } | null
      decimals = meta?.decimals ?? 6
    } catch {
      decimals = 6
    }
  }
  // suix_getBalance sums every Coin<coinType> object the owner holds.
  const bal = await rpc('suix_getBalance', [owner, coinType]) as { totalBalance?: string } | null
  const raw = BigInt(bal?.totalBalance ?? '0')
  return { balance: Number(formatUnits(raw, decimals)), decimals }
}

// ── TON (jetton) ──────────────────────────────────────────────────────────────

async function getTonJettonBalance(
  jettonMaster: string,
  owner: string,
  knownDecimals?: number,
): Promise<TokenBalanceResult> {
  const { getTonEndpoints } = await import('./tonWalletService')

  let lastErr: unknown
  for (const ep of await getTonEndpoints()) {
    if (ep.kind !== 'jsonrpc-v2') continue // v4 (TON Hub) has no toncenter REST jetton route
    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (ep.apiKey) headers['X-API-Key'] = ep.apiKey

      // jetton wallet lookup uses the toncenter v3 REST API. restBase ends in
      // `/api/v2` (toncenter) or `…/toncenter-api-v2` (orbs) — swap to v3 for these.
      const v3Base = ep.restBase.replace(/\/api\/v2$/i, '/api/v3').replace(/-v2$/i, '-v3')
      // toncenter v3: the owner's jetton wallet for this master holds the balance.
      const walletUrl =
        `${v3Base}/jetton/wallets?owner_address=${encodeURIComponent(owner)}` +
        `&jetton_address=${encodeURIComponent(jettonMaster)}&limit=1`
      const wRes = await fetch(walletUrl, { headers, signal: AbortSignal.timeout(10_000) })
      if (!wRes.ok) throw new Error(`TON API jetton/wallets HTTP ${wRes.status}`)
      const wData = await wRes.json() as { jetton_wallets?: Array<{ balance?: string }> }
      const rawBalance = wData.jetton_wallets?.[0]?.balance ?? '0' // no wallet yet → 0

      let decimals = knownDecimals
      if (decimals == null) {
        try {
          const mUrl = `${v3Base}/jetton/masters?address=${encodeURIComponent(jettonMaster)}&limit=1`
          const mRes = await fetch(mUrl, { headers, signal: AbortSignal.timeout(10_000) })
          const mData = await mRes.json() as { jetton_masters?: Array<{ jetton_content?: { decimals?: string | number } }> }
          const d = mData.jetton_masters?.[0]?.jetton_content?.decimals
          decimals = d != null ? Number(d) : 6
        } catch {
          decimals = 6
        }
      }
      return { balance: Number(formatUnits(BigInt(rawBalance), decimals)), decimals }
    } catch (err) {
      lastErr = err // try the next endpoint
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('TON API jetton/wallets failed on all endpoints')
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
  if (dbChain === 'SOL') return getSolanaTokenBalance(contract, owner, knownDecimals)
  if (dbChain === 'SUI') return getSuiTokenBalance(contract, owner, knownDecimals)
  if (dbChain === 'TON') return getTonJettonBalance(contract, owner, knownDecimals)
  return getEvmTokenBalance(dbChain, contract, owner, knownDecimals)
}
