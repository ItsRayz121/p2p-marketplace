/**
 * RPC fallback system for EVM gas chains.
 *
 * Each chain has:
 *   - primary: the operator-configured env var URL (first choice)
 *   - fallbacks: hardcoded reliable public endpoints (tried in order)
 *
 * `getWorkingRpcUrl(chain, primaryUrl)` probes the primary and falls back
 * automatically. `getRpcFallbackStatus(chain, primaryUrl)` returns health
 * info for every URL in the list — used by the system-health endpoint.
 *
 * Call sites (delivery, refund, confirmation) pass the env-var URL as
 * `primaryUrl`; this module handles the rest without touching env directly.
 */

import type { GasChainId } from './gas.chains'

// ── Fallback RPC lists ────────────────────────────────────────────────────────
// These are free, public endpoints that don't require API keys.
// Operators should configure their own dedicated RPCs via env vars.

const FALLBACK_RPCS: Partial<Record<GasChainId, string[]>> = {
  ETHEREUM: [
    'https://eth.llamarpc.com',
    'https://ethereum-rpc.publicnode.com',
    'https://rpc.ankr.com/eth',
  ],
  BSC: [
    'https://bsc-dataseed.binance.org',
    'https://bsc-rpc.publicnode.com',
    'https://bsc-dataseed1.ninicoin.io',
  ],
  BASE: [
    'https://mainnet.base.org',
    'https://base.llamarpc.com',
    'https://base-rpc.publicnode.com',
  ],
  ARB: [
    'https://arb1.arbitrum.io/rpc',
    'https://arbitrum.llamarpc.com',
    'https://arbitrum-one-rpc.publicnode.com',
  ],
  OP: [
    'https://mainnet.optimism.io',
    'https://optimism.llamarpc.com',
    'https://optimism-rpc.publicnode.com',
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
      signal: AbortSignal.timeout(6_000),
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
 * Returns the first reachable RPC URL for the given chain, trying `primaryUrl`
 * first, then the hardcoded fallback list. Throws if all endpoints fail.
 *
 * This is used at the point of need (delivery, refund, confirmation) — not
 * cached globally so that a recovered primary will be picked up on the next call.
 */
export async function getWorkingRpcUrl(chain: GasChainId, primaryUrl: string): Promise<string> {
  // Always probe primary first
  const primaryResult = await probeRpc(primaryUrl)
  if (primaryResult.reachable) return primaryUrl

  const fallbacks = FALLBACK_RPCS[chain] ?? []
  for (const url of fallbacks) {
    if (url === primaryUrl) continue // already tried
    const result = await probeRpc(url)
    if (result.reachable) return url
  }

  throw new Error(
    `All RPC endpoints for ${chain} are unreachable. ` +
    `Primary: ${primaryUrl}. Fallbacks tried: ${fallbacks.filter((u) => u !== primaryUrl).join(', ')}`,
  )
}

/**
 * Returns the ordered, de-duplicated list of RPC URLs to try for a chain:
 * the operator-configured primary first (when set), then the hardcoded free
 * public fallbacks. Unlike `getWorkingRpcUrl`, this does NOT probe — callers
 * that need to retry an actual RPC method (e.g. eth_getTransactionByHash)
 * across endpoints can iterate this list and stop at the first success.
 */
export function getRpcUrlsInOrder(chain: GasChainId, primaryUrl?: string): string[] {
  const fallbacks = FALLBACK_RPCS[chain] ?? []
  const ordered = [primaryUrl, ...fallbacks].filter(
    (u): u is string => typeof u === 'string' && u.length > 0,
  )
  return [...new Set(ordered)]
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
 * Probe all RPC endpoints for a chain (primary + fallbacks) in parallel.
 * Returns status for each, and which one would be used as active.
 * Used by the system-health endpoint.
 */
export async function getChainRpcFallbackStatus(
  chain: GasChainId,
  primaryUrl: string,
): Promise<ChainRpcFallbackStatus> {
  const fallbacks = FALLBACK_RPCS[chain] ?? []

  // Deduplicate: primary may already appear in the fallback list
  const allUrls = [primaryUrl, ...fallbacks.filter((u) => u !== primaryUrl)]

  const results = await Promise.all(allUrls.map((url) => probeRpc(url)))

  const endpoints: RpcEndpointStatus[] = results.map((r, i) => ({
    ...r,
    isPrimary: i === 0,
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
