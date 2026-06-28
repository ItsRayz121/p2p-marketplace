// Live health probes for the providers that DETECT incoming USDT payments.
//
// Payment detection is the single most important money-path in the gas system, so
// admins need an at-a-glance answer to "can we still see incoming payments right
// now, and on which provider?". This module actively probes each provider the
// poller (gasPaymentPoller.job.ts) and webhook rely on, per payment network:
//
//   BEP20 / ERC20 (EVM):
//     - Etherscan V2  — primary explorer scan (indexer-grade); needs a plan that
//                       covers the chain (BSC is NOT on Etherscan's free tier).
//     - Alchemy       — getLogs fallback (de-facto primary for BSC). Reliable.
//     - Public RPC    — getLogs secondary fallback (publicnode).
//     - Moralis       — supplementary webhook stream (detection does NOT depend on it).
//   TRC20:  TronGrid (only automatic path).
//   APTOS:  Aptos Indexer (only automatic path).
//
// Every probe is best-effort with a short timeout and is run in parallel by the
// caller — a slow/dead provider can never block the health endpoint. `canDetect`
// means "this provider could attribute a payment right now"; a network is healthy
// (`canDetect` at network level) as long as AT LEAST ONE provider can detect.

import { env } from '../env'

export type ProviderStatus = 'green' | 'yellow' | 'red' | 'unconfigured'

export interface ProviderHealth {
  name: string
  role: string            // human label: 'Primary · explorer', 'Fallback · getLogs', 'Supplementary · webhook'
  status: ProviderStatus
  detail: string          // human-readable result
  latencyMs: number | null
  canDetect: boolean      // currently usable to attribute a payment
}

export interface NetworkDetectionHealth {
  network: string         // 'BEP20'
  label: string           // 'BNB Smart Chain · USDT'
  canDetect: boolean      // any provider can detect → payments will be caught
  activeProvider: string | null  // the provider the poller will actually use right now
  providers: ProviderHealth[]
}

const UNCONFIGURED = (name: string, role: string, detail: string): ProviderHealth => ({
  name, role, status: 'unconfigured', detail, latencyMs: null, canDetect: false,
})

// ── EVM getLogs probe (Alchemy / public nodes) ───────────────────────────────────
// These providers are the poller's getLogs fallbacks, so the ONLY meaningful health
// question is "can this node serve our getLogs query right now?" — NOT "can it answer
// a block-number ping?". The old probe only did eth_blockNumber, so it showed green
// even when getLogs was rejected (e.g. BSC dataseed "Request exceeds defined limit"),
// masking real detection outages. This probe runs the SAME query shape the poller
// uses — USDT Transfer logs over the last 50 blocks — so green means detection works.
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ZERO_TOPIC = '0x0000000000000000000000000000000000000000000000000000000000000000'

async function probeEvmGetLogs(name: string, url: string | undefined, usdtContract: string): Promise<ProviderHealth> {
  const role = 'Fallback · getLogs'
  if (!url) return UNCONFIGURED(name, role, 'Not configured')
  const t0 = Date.now()
  const rpc = async (body: unknown) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  })
  try {
    const bnRes = await rpc({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 })
    if (bnRes.status === 401 || bnRes.status === 403) return { name, role, status: 'red', detail: 'Unauthorized — check API key', latencyMs: Date.now() - t0, canDetect: false }
    if (bnRes.status === 429) return { name, role, status: 'yellow', detail: 'Rate limited', latencyMs: Date.now() - t0, canDetect: true }
    if (!bnRes.ok) return { name, role, status: 'red', detail: `HTTP ${bnRes.status}`, latencyMs: Date.now() - t0, canDetect: false }
    const bnJson = (await bnRes.json()) as { result?: string }
    if (typeof bnJson.result !== 'string' || !bnJson.result.startsWith('0x')) {
      return { name, role, status: 'red', detail: 'No block number', latencyMs: Date.now() - t0, canDetect: false }
    }
    const head = BigInt(bnJson.result)
    const from = head > 50n ? head - 50n : 0n
    // Filter to USDT Transfer → zero address: near-empty result, same range mechanics
    // the poller exercises (proves the node accepts a 50-block getLogs range).
    const res = await rpc({
      jsonrpc: '2.0', id: 2, method: 'eth_getLogs',
      params: [{ address: usdtContract, topics: [TRANSFER_TOPIC, null, ZERO_TOPIC], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${head.toString(16)}` }],
    })
    const latencyMs = Date.now() - t0
    if (res.status === 429) return { name, role, status: 'yellow', detail: 'Rate limited', latencyMs, canDetect: true }
    if (!res.ok) return { name, role, status: 'red', detail: `getLogs HTTP ${res.status}`, latencyMs, canDetect: false }
    const json = (await res.json()) as { result?: unknown[]; error?: { message?: string } }
    if (json.error) {
      return { name, role, status: 'red', detail: `getLogs rejected: ${(json.error.message ?? 'error').slice(0, 90)}`, latencyMs, canDetect: false }
    }
    if (Array.isArray(json.result)) {
      return { name, role, status: 'green', detail: `getLogs ok · block ${Number(head).toLocaleString()} · ${latencyMs}ms`, latencyMs, canDetect: true }
    }
    return { name, role, status: 'red', detail: 'Unexpected getLogs response', latencyMs, canDetect: false }
  } catch (err) {
    return { name, role, status: 'red', detail: (err as Error)?.name === 'TimeoutError' ? 'Timeout' : ((err as Error)?.message?.slice(0, 120) ?? 'Unreachable'), latencyMs: Date.now() - t0, canDetect: false }
  }
}

// ── Etherscan V2 explorer probe ─────────────────────────────────────────────────
async function probeEtherscan(chainId: number): Promise<ProviderHealth> {
  const name = 'Etherscan'
  const role = 'Primary · explorer'
  const apiKey = env.ETHERSCAN_API_KEY
  if (!apiKey) return UNCONFIGURED(name, role, 'ETHERSCAN_API_KEY not set')
  const t0 = Date.now()
  try {
    const url = new URL('https://api.etherscan.io/v2/api')
    url.searchParams.set('chainid', String(chainId))
    url.searchParams.set('module', 'proxy')
    url.searchParams.set('action', 'eth_blockNumber')
    url.searchParams.set('apikey', apiKey)
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8_000) })
    const latencyMs = Date.now() - t0
    if (!res.ok) return { name, role, status: 'red', detail: `HTTP ${res.status}`, latencyMs, canDetect: false }
    const json = (await res.json()) as { result?: string; message?: string }
    const result = json.result
    if (typeof result === 'string' && result.startsWith('0x')) {
      const block = Number(BigInt(result))
      return { name, role, status: 'green', detail: `Block ${block.toLocaleString()} · ${latencyMs}ms`, latencyMs, canDetect: true }
    }
    // result is an error string on status "0"
    const msg = typeof result === 'string' ? result : (json.message ?? 'Unknown error')
    if (/not supported for this chain|upgrade your api plan/i.test(msg)) {
      return { name, role, status: 'red', detail: 'Chain not on current plan — upgrade to API Pro (free tier excludes BSC)', latencyMs, canDetect: false }
    }
    if (/invalid api key/i.test(msg)) {
      return { name, role, status: 'red', detail: 'Invalid API key', latencyMs, canDetect: false }
    }
    if (/rate limit|max .* reached/i.test(msg)) {
      return { name, role, status: 'yellow', detail: 'Rate limited', latencyMs, canDetect: true }
    }
    return { name, role, status: 'red', detail: msg.slice(0, 120), latencyMs, canDetect: false }
  } catch (err) {
    return { name, role, status: 'red', detail: (err as Error)?.name === 'TimeoutError' ? 'Timeout' : 'Unreachable', latencyMs: Date.now() - t0, canDetect: false }
  }
}

// ── Moralis key-validity probe (supplementary webhook provider) ─────────────────
// Detection does NOT depend on Moralis (it's a webhook stream, not a poll), so its
// canDetect is always false — but we surface whether the key is still valid/expired
// since the user asked specifically to monitor it.
async function probeMoralis(): Promise<ProviderHealth> {
  const name = 'Moralis'
  const role = 'Supplementary · webhook'
  if (!env.MORALIS_API_KEY) return UNCONFIGURED(name, role, 'Not configured (detection does not depend on it)')
  const t0 = Date.now()
  try {
    // Hit a key-GATED endpoint (ERC20 balances of the zero address) so an invalid /
    // expired key returns 401 — `web3/version` is public and would mask a dead key.
    const res = await fetch('https://deep-index.moralis.io/api/v2.2/0x0000000000000000000000000000000000000000/erc20?chain=0x1', {
      headers: { 'x-api-key': env.MORALIS_API_KEY, accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    })
    const latencyMs = Date.now() - t0
    if (res.status === 401 || res.status === 403) {
      return { name, role, status: 'red', detail: 'Key invalid or expired', latencyMs, canDetect: false }
    }
    if (res.status === 429) {
      return { name, role, status: 'yellow', detail: 'Rate limited (key valid)', latencyMs, canDetect: false }
    }
    if (!res.ok) return { name, role, status: 'yellow', detail: `HTTP ${res.status}`, latencyMs, canDetect: false }
    return { name, role, status: 'green', detail: `Key valid · ${latencyMs}ms`, latencyMs, canDetect: false }
  } catch (err) {
    return { name, role, status: 'yellow', detail: (err as Error)?.name === 'TimeoutError' ? 'Timeout' : 'Unreachable', latencyMs: Date.now() - t0, canDetect: false }
  }
}

// ── TronGrid probe ──────────────────────────────────────────────────────────────
async function probeTronGrid(): Promise<ProviderHealth> {
  const name = 'TronGrid'
  const role = 'Primary · indexer'
  const base = env.TRON_FULLNODE_URL
  if (!base) return UNCONFIGURED(name, role, 'TRON_FULLNODE_URL not set')
  const t0 = Date.now()
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = env.TRONGRID_API_KEY
    const res = await fetch(`${base.replace(/\/$/, '')}/wallet/getnowblock`, {
      method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(8_000),
    })
    const latencyMs = Date.now() - t0
    if (res.status === 401 || res.status === 403) return { name, role, status: 'red', detail: 'Unauthorized — check TRONGRID_API_KEY', latencyMs, canDetect: false }
    if (res.status === 429) return { name, role, status: 'yellow', detail: 'Rate limited (set TRONGRID_API_KEY)', latencyMs, canDetect: true }
    if (!res.ok) return { name, role, status: 'red', detail: `HTTP ${res.status}`, latencyMs, canDetect: false }
    const json = (await res.json()) as { block_header?: { raw_data?: { number?: number } } }
    const block = json.block_header?.raw_data?.number
    if (block) return { name, role, status: 'green', detail: `Block ${block.toLocaleString()} · ${latencyMs}ms`, latencyMs, canDetect: true }
    return { name, role, status: 'yellow', detail: 'Reachable, no block in response', latencyMs, canDetect: true }
  } catch (err) {
    return { name, role, status: 'red', detail: (err as Error)?.name === 'TimeoutError' ? 'Timeout' : 'Unreachable', latencyMs: Date.now() - t0, canDetect: false }
  }
}

// ── Aptos Indexer probe ─────────────────────────────────────────────────────────
async function probeAptosIndexer(): Promise<ProviderHealth> {
  const name = 'Aptos Indexer'
  const role = 'Primary · indexer'
  const url = env.APTOS_INDEXER_URL
  if (!url) return UNCONFIGURED(name, role, 'APTOS_INDEXER_URL not set')
  const t0 = Date.now()
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (env.APTOS_API_KEY) headers['authorization'] = `Bearer ${env.APTOS_API_KEY}`
    const res = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({ query: '{ ledger_infos(limit: 1) { chain_id } }' }),
      signal: AbortSignal.timeout(8_000),
    })
    const latencyMs = Date.now() - t0
    if (res.status === 401 || res.status === 403) return { name, role, status: 'red', detail: 'Unauthorized — check APTOS_API_KEY', latencyMs, canDetect: false }
    if (res.status === 429) return { name, role, status: 'yellow', detail: 'Rate limited', latencyMs, canDetect: true }
    if (!res.ok) return { name, role, status: 'red', detail: `HTTP ${res.status}`, latencyMs, canDetect: false }
    const json = (await res.json()) as { data?: { ledger_infos?: Array<{ chain_id?: number }> }; errors?: unknown }
    if (json.errors) return { name, role, status: 'red', detail: 'GraphQL error', latencyMs, canDetect: false }
    if (json.data?.ledger_infos?.length) return { name, role, status: 'green', detail: `chain_id ${json.data.ledger_infos[0]?.chain_id} · ${latencyMs}ms`, latencyMs, canDetect: true }
    return { name, role, status: 'yellow', detail: 'Reachable, empty response', latencyMs, canDetect: true }
  } catch (err) {
    return { name, role, status: 'red', detail: (err as Error)?.name === 'TimeoutError' ? 'Timeout' : 'Unreachable', latencyMs: Date.now() - t0, canDetect: false }
  }
}

// Pick the provider the poller will actually use, mirroring its real priority:
// Etherscan (when the plan covers the chain) → first usable getLogs node (Alchemy,
// then public RPC). Returns null when nothing can detect.
function pickActiveProvider(providers: ProviderHealth[]): string | null {
  const etherscan = providers.find((p) => p.name === 'Etherscan')
  if (etherscan?.canDetect) return 'Etherscan'
  const getLogs = providers.find((p) => (p.role.includes('getLogs')) && p.canDetect)
  if (getLogs) return getLogs.name
  const any = providers.find((p) => p.canDetect)
  return any?.name ?? null
}

const ALCHEMY = env.ALCHEMY_API_KEY
const alchemyUrl = (net: 'bnb-mainnet' | 'eth-mainnet') => ALCHEMY ? `https://${net}.g.alchemy.com/v2/${ALCHEMY}` : undefined

async function probeEvmNetwork(network: 'BEP20' | 'ERC20'): Promise<NetworkDetectionHealth> {
  const isBsc = network === 'BEP20'
  const usdt = isBsc ? '0x55d398326f99059fF775485246999027B3197955' : '0xdAC17F958D2ee523a2206206994597C13D831ec7'
  const [etherscan, alchemy, publicRpc, moralis] = await Promise.all([
    probeEtherscan(isBsc ? 56 : 1),
    probeEvmGetLogs('Alchemy', alchemyUrl(isBsc ? 'bnb-mainnet' : 'eth-mainnet'), usdt),
    probeEvmGetLogs('Public RPC', isBsc ? 'https://bsc-rpc.publicnode.com' : 'https://ethereum-rpc.publicnode.com', usdt),
    probeMoralis(),
  ])
  const providers = [etherscan, alchemy, publicRpc, moralis]
  return {
    network,
    label: isBsc ? 'BNB Smart Chain · USDT' : 'Ethereum · USDT',
    canDetect: providers.some((p) => p.canDetect),
    activeProvider: pickActiveProvider(providers),
    providers,
  }
}

// Probe every payment network's detection providers in parallel. Best-effort:
// any individual probe failure degrades to a red tile, never throws.
export async function probeDetectionProviders(): Promise<NetworkDetectionHealth[]> {
  const [bep20, erc20, trc20, aptos] = await Promise.all([
    probeEvmNetwork('BEP20'),
    probeEvmNetwork('ERC20'),
    probeTronGrid(),
    probeAptosIndexer(),
  ])
  return [
    bep20,
    erc20,
    { network: 'TRC20', label: 'Tron · USDT', canDetect: trc20.canDetect, activeProvider: trc20.canDetect ? trc20.name : null, providers: [trc20] },
    { network: 'APTOS', label: 'Aptos · USDT', canDetect: aptos.canDetect, activeProvider: aptos.canDetect ? aptos.name : null, providers: [aptos] },
  ]
}
