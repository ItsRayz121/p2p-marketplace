/**
 * RPC fallback system for EVM gas chains.
 *
 * Each chain has an ordered candidate list:
 *   1. primary        — the operator-configured env var URL (first choice)
 *   2. env extras     — comma-separated <CHAIN>_RPC_FALLBACK_URLS (add providers with
 *                       no code change or redeploy of this file)
 *   3. built-in list  — free public endpoints, verified to answer from production
 *
 * Failover is health-aware: an endpoint that fails is put on a short cool-down so the
 * next calls skip it instead of each paying its full timeout, and the last endpoint
 * that worked is remembered for a few seconds. A recovered endpoint is picked up again
 * automatically once its cool-down ends.
 *
 * Call sites (delivery, refund, confirmation, balance, fee estimates, health) pass the
 * env-var URL as `primaryUrl`; this module handles the rest without touching env.
 */

import type { GasChainId } from './gas.chains'

// ── Fallback RPC lists ────────────────────────────────────────────────────────
// Free public endpoints that don't require API keys, ordered best-first. The BSC and
// Ethereum entries were probed for eth_blockNumber + a real eth_getLogs range: the
// dataseed/defibit BSC nodes reject getLogs (fine for delivery/balance, listed last),
// and some free tiers (drpc, blastapi) rate-limit getLogs intermittently, so several
// independent providers are kept rather than one.

const FALLBACK_RPCS: Partial<Record<GasChainId, string[]>> = {
  ETHEREUM: [
    'https://ethereum-rpc.publicnode.com',
    'https://eth.drpc.org',
    'https://1rpc.io/eth',
    'https://rpc.mevblocker.io',
    'https://eth.llamarpc.com',
  ],
  BSC: [
    'https://bsc-rpc.publicnode.com',
    'https://1rpc.io/bnb',
    'https://bsc.drpc.org',
    'https://bsc-mainnet.public.blastapi.io',
    'https://bsc-dataseed.binance.org',
    'https://bsc-dataseed1.defibit.io',
    'https://bsc-dataseed1.ninicoin.io',
  ],
  // opBNB (chainId 204) — free public endpoints. Alchemy does NOT serve opBNB, so
  // these are the resilient path for auto-delivery/confirmation/balance. Set
  // OPBNB_RPC_URL to a dedicated QuickNode/NodeReal URL for higher throughput.
  OPBNB: [
    'https://opbnb-mainnet-rpc.bnbchain.org',
    'https://opbnb-rpc.publicnode.com',
    'https://opbnb.drpc.org',
    'https://1rpc.io/opbnb',
    'https://opbnb-mainnet.public.blastapi.io',
  ],
  BASE: [
    'https://mainnet.base.org',
    'https://base-rpc.publicnode.com',
    'https://base.llamarpc.com',
    'https://base.drpc.org',
  ],
  ARB: [
    'https://arb1.arbitrum.io/rpc',
    'https://arbitrum-one-rpc.publicnode.com',
    'https://arbitrum.llamarpc.com',
    'https://arbitrum.drpc.org',
  ],
  OP: [
    'https://mainnet.optimism.io',
    'https://optimism-rpc.publicnode.com',
    'https://optimism.llamarpc.com',
    'https://optimism.drpc.org',
  ],
  MATIC: [
    'https://polygon-bor-rpc.publicnode.com',
    'https://polygon.llamarpc.com',
    'https://polygon.drpc.org',
  ],
  AVAX: [
    'https://api.avax.network/ext/bc/C/rpc',
    'https://avalanche-c-chain-rpc.publicnode.com',
    'https://avalanche.drpc.org',
  ],
}

// Env vars that can add extra endpoints per chain (comma-separated https URLs).
const EXTRA_URLS_ENV: Partial<Record<GasChainId, string>> = {
  ETHEREUM: 'ETHEREUM_RPC_FALLBACK_URLS',
  BSC:      'BSC_RPC_FALLBACK_URLS',
  OPBNB:    'OPBNB_RPC_FALLBACK_URLS',
  BASE:     'BASE_RPC_FALLBACK_URLS',
  ARB:      'ARBITRUM_RPC_FALLBACK_URLS',
  OP:       'OPTIMISM_RPC_FALLBACK_URLS',
  MATIC:    'POLYGON_RPC_FALLBACK_URLS',
  AVAX:     'AVALANCHE_RPC_FALLBACK_URLS',
}

/** Operator-supplied extra endpoints for a chain (validated, de-duplicated). */
export function getExtraRpcUrls(chain: GasChainId): string[] {
  const name = EXTRA_URLS_ENV[chain]
  const raw = name ? process.env[name] : undefined
  if (!raw) return []
  const urls = raw
    .split(',')
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\/\S+$/i.test(u))
  return [...new Set(urls)]
}

// ── Endpoint health memory (per process) ──────────────────────────────────────

const COOLDOWN_MS = 60_000          // skip a failed endpoint for this long
const LAST_WORKING_TTL_MS = 30_000  // reuse the last good endpoint without re-probing

const failedAt = new Map<string, number>()
const lastWorking = new Map<GasChainId, { url: string; at: number }>()

function isCoolingDown(url: string): boolean {
  const t = failedAt.get(url)
  if (t === undefined) return false
  if (Date.now() - t > COOLDOWN_MS) { failedAt.delete(url); return false }
  return true
}

export function markRpcFailure(url: string): void {
  failedAt.set(url, Date.now())
}

export function markRpcSuccess(url: string): void {
  failedAt.delete(url)
}

/** Healthy endpoints first (original order kept), cooling-down ones last. */
export function orderByRpcHealth(urls: string[]): string[] {
  return [...urls.filter((u) => !isCoolingDown(u)), ...urls.filter((u) => isCoolingDown(u))]
}

function candidateUrls(chain: GasChainId, primaryUrl?: string): string[] {
  const ordered = [primaryUrl, ...getExtraRpcUrls(chain), ...(FALLBACK_RPCS[chain] ?? [])].filter(
    (u): u is string => typeof u === 'string' && u.length > 0,
  )
  return [...new Set(ordered)]
}

// ── Probe a single RPC endpoint ───────────────────────────────────────────────

interface ProbeResult {
  url: string
  reachable: boolean
  latencyMs: number
  blockNumber?: number
  error?: string
}

async function probeRpc(url: string): Promise<ProbeResult> {
  const start = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(5_000),
    })
    const latencyMs = Date.now() - start
    if (!res.ok) {
      return { url, reachable: false, latencyMs, error: `HTTP ${res.status}` }
    }
    const json = (await res.json()) as { result?: string; error?: { message?: string } }
    if (json.error) {
      return { url, reachable: false, latencyMs, error: json.error.message ?? 'rpc_error' }
    }
    const blockNumber = json.result ? Number(BigInt(json.result)) : undefined
    return blockNumber !== undefined
      ? { url, reachable: true, latencyMs, blockNumber }
      : { url, reachable: true, latencyMs }
  } catch (err) {
    return {
      url,
      reachable: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : 'unknown_error',
    }
  }
}

// ── Get the first working RPC URL ─────────────────────────────────────────────

/**
 * Returns a reachable RPC URL for the chain: the last good one (for a few seconds),
 * otherwise the first healthy candidate that answers, trying `primaryUrl` first, then
 * operator extras, then the built-in list. Endpoints that fail go on a short
 * cool-down. Throws only if every endpoint is unreachable.
 *
 * Used at the point of need (delivery, refund, confirmation, balances, fee quotes) —
 * a recovered primary is picked up again once its cool-down ends.
 */
export async function getWorkingRpcUrl(chain: GasChainId, primaryUrl: string): Promise<string> {
  const candidates = candidateUrls(chain, primaryUrl)

  const cached = lastWorking.get(chain)
  if (cached && Date.now() - cached.at < LAST_WORKING_TTL_MS && candidates.includes(cached.url) && !isCoolingDown(cached.url)) {
    return cached.url
  }

  for (const url of orderByRpcHealth(candidates)) {
    const result = await probeRpc(url)
    if (result.reachable) {
      markRpcSuccess(url)
      lastWorking.set(chain, { url, at: Date.now() })
      return url
    }
    markRpcFailure(url)
  }

  lastWorking.delete(chain)
  throw new Error(
    `All RPC endpoints for ${chain} are unreachable. ` +
    `Primary: ${primaryUrl}. Fallbacks tried: ${candidates.filter((u) => u !== primaryUrl).join(', ')}`,
  )
}

/**
 * Like getWorkingRpcUrl but never throws: if everything is unreachable it returns the
 * primary so the caller's own request produces the real error. Use where a thrown
 * probe error would hide the underlying failure (fee quotes, balance reads).
 */
export async function getWorkingRpcUrlOrPrimary(chain: GasChainId, primaryUrl: string): Promise<string> {
  try {
    return await getWorkingRpcUrl(chain, primaryUrl)
  } catch {
    return primaryUrl
  }
}

/**
 * Returns the ordered, de-duplicated list of RPC URLs to try for a chain: the
 * operator-configured primary first (when set), operator extras, then the built-in
 * public fallbacks — with recently-failed endpoints moved to the back. Unlike
 * `getWorkingRpcUrl`, this does NOT probe — callers that need to retry an actual RPC
 * method (e.g. eth_getTransactionByHash) across endpoints can iterate this list and
 * stop at the first success.
 */
export function getRpcUrlsInOrder(chain: GasChainId, primaryUrl?: string): string[] {
  return orderByRpcHealth(candidateUrls(chain, primaryUrl))
}

// ── Full fallback status (for system-health) ──────────────────────────────────

export interface RpcEndpointStatus {
  url: string
  isPrimary: boolean
  reachable: boolean
  latencyMs: number
  blockNumber?: number
  error?: string
}

export interface ChainRpcFallbackStatus {
  chain: GasChainId
  primaryUrl: string
  activeUrl: string | null
  allReachable: boolean
  anyReachable: boolean
  endpoints: RpcEndpointStatus[]
}

/**
 * Probe all RPC endpoints for a chain (primary + extras + fallbacks) in parallel.
 * Returns status for each, and which one would be used as active.
 * Used by the system-health endpoint.
 */
export async function getChainRpcFallbackStatus(
  chain: GasChainId,
  primaryUrl: string,
): Promise<ChainRpcFallbackStatus> {
  const allUrls = candidateUrls(chain, primaryUrl)

  const results = await Promise.all(allUrls.map((url) => probeRpc(url)))
  for (const r of results) (r.reachable ? markRpcSuccess : markRpcFailure)(r.url)

  const endpoints: RpcEndpointStatus[] = results.map((r) => ({
    ...r,
    isPrimary: r.url === primaryUrl,
  }))

  const activeEndpoint = endpoints.find((e) => e.reachable) ?? null

  return {
    chain,
    primaryUrl,
    activeUrl: activeEndpoint?.url ?? null,
    allReachable: endpoints.every((e) => e.reachable),
    anyReachable: endpoints.some((e) => e.reachable),
    endpoints,
  }
}

/**
 * Run fallback status checks for all EVM chains in parallel.
 * Pass a map of chainId → primaryUrl (from env).
 */
export async function getAllChainRpcFallbackStatus(
  chainUrls: Partial<Record<GasChainId, string>>,
): Promise<ChainRpcFallbackStatus[]> {
  const entries = Object.entries(chainUrls) as [GasChainId, string][]
  return Promise.all(entries.map(([chain, url]) => getChainRpcFallbackStatus(chain, url)))
}
