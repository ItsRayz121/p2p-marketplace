// Fallback payment poller — defence-in-depth and PRIMARY detection for TRON.
//
// Runs ~every 60 s. Scans each configured payment network for incoming USDT to the
// gas deposit address, then applies the same matching logic as webhook.routes.ts.
//
//   - EVM (BEP20/ERC20): scans recent blocks via RPC getLogs for Transfer events.
//   - TRON  (TRC20):     queries TronGrid for confirmed TRC20 transfers. Moralis
//                        does NOT support TRON, so the webhook never fires for it —
//                        this poller is the ONLY automatic detection path for TRC20.
//
// On a confirmed, unambiguous match the order is moved to `payment_detected` and gas
// delivery is queued automatically (same path the EVM webhook uses). Ambiguous
// amount matches (>1 candidate order) are parked as unattributed for manual review
// so auto-delivery never credits the wrong user.

import { createPublicClient, http, parseAbiItem } from 'viem'
import { bsc, mainnet } from 'viem/chains'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { logger } from '../lib/logger'
import { env } from '../lib/env'
import { getAptosHotWalletAddress } from '../lib/gas/aptosWalletService'
import { getEvmHotWalletAddress } from '../lib/gas/gasWalletService'
import { matchAndDeliverGasPayment } from '../lib/gas/gas.matching'

// ERC20 Transfer(from, to, value) — indexed from + to allow topic-filter on 'to'
const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)

// Grace window: attribute payments to orders that expired at most this many ms ago.
// Covers the case where the webhook fired after the order expiry job already ran.
const GRACE_WINDOW_MS = 15 * 60 * 1000 // 15 minutes

// USDT TRC20 contract on TRON mainnet, 6 decimals.
const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const USDT_TRC20_DECIMALS = 6
// only_confirmed=true returns solidified txs; nominal depth used only for display.
const TRON_CONFIRMED_DEPTH = 19
// On a cold start (no cursor) scan this far back so on-time payments aren't missed.
const TRON_COLD_START_LOOKBACK_MS = 30 * 60 * 1000

// Native USDT on Aptos (Tether) — fungible-asset metadata address, 6 decimals.
// Overridable via PlatformConfig key 'gas_usdt_aptos_asset' (e.g. testnet/alt asset).
const USDT_APTOS_ASSET_DEFAULT = '0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b'
const USDT_APTOS_DECIMALS = 6
const APTOS_COLD_START_LOOKBACK_MS = 30 * 60 * 1000

interface NetworkConfig {
  paymentNetwork: string
  viemChain: typeof bsc | typeof mainnet
  // Ordered list of RPC URLs to try (primary first). getLogs/getBlockNumber
  // fall through to the next on failure so one rate-limited node can't stall
  // detection. The first that allows the small getLogs range wins.
  rpcUrls: () => string[]
  usdtContract: `0x${string}`
  usdtDecimals: number
  depositAddressDbKey: string
  depositAddressEnvFn: () => string | undefined
  // Etherscan V2 chain id (BSC 56, Ethereum 1) for the explorer-API scanner —
  // the reliable, indexer-grade detection path (parity with TronGrid/Aptos),
  // used in preference to getLogs whenever ETHERSCAN_API_KEY is configured.
  etherscanChainId: number
  // How many blocks ≈ the scan window. Keeps getLogs range reasonable.
  // BSC  ~3 s/block → 100 blocks ≈ 5 min
  // ETH ~12 s/block →  30 blocks ≈ 6 min
  scanBlocks: number
  // Minimum block confirmations required before treating the payment as final.
  minConfirmations: number
}

// Dedup + drop falsy. Keeps the operator's configured order.
function uniqUrls(...urls: Array<string | undefined>): string[] {
  return [...new Set(urls.filter((u): u is string => !!u))]
}

// Public BSC "dataseed" nodes answer getBlockNumber fine but REJECT every getLogs
// range query ("Request exceeds defined limit"), so they must never be used for log
// scanning — only Alchemy / publicnode / operator-configured endpoints can serve it.
const GETLOGS_INCAPABLE_RE = /dataseed|ninicoin/i
function getLogsCapable(urls: string[]): string[] {
  return urls.filter((u) => !GETLOGS_INCAPABLE_RE.test(u))
}

// RPC error messages meaning "this block range is too wide / returned too much" —
// recoverable by splitting the range and retrying. Rate-limits, auth, and network
// errors are deliberately NOT matched here: splitting wouldn't help, so on those we
// fall through to the next endpoint instead.
const RANGE_LIMIT_RE = /exceed\w* .*limit|limit exceeded|block range|range is too|too many results|response size|more than \d+ results|10000/i
function isRangeLimitError(err: unknown): boolean {
  return RANGE_LIMIT_RE.test((err as Error)?.message ?? '')
}

const NETWORK_CONFIGS: NetworkConfig[] = [
  {
    paymentNetwork:      'BEP20',
    viemChain:           bsc,
    // bsc-dataseed.binance.org rejects getLogs ranges ("Request exceeds defined
    // limit"). Prefer operator-configured endpoints, then publicnode (allows
    // getLogs), and keep BSC_RPC_URL last as a getBlockNumber fallback.
    // Alchemy (if ALCHEMY_API_KEY set) first — it serves getLogs reliably, unlike
    // most free public BSC nodes. Then operator endpoints, then publicnode.
    rpcUrls:             () => uniqUrls(
      env.ALCHEMY_API_KEY ? `https://bnb-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}` : undefined,
      env.BSC_RPC_URL_PRIMARY,
      env.BSC_RPC_URL_FALLBACK,
      'https://bsc-rpc.publicnode.com',
      'https://bsc-dataseed1.ninicoin.io',
      env.BSC_RPC_URL,
    ),
    usdtContract:        '0x55d398326f99059fF775485246999027B3197955',
    usdtDecimals:        18,  // Binance-Peg USDT on BSC uses 18 decimals
    depositAddressDbKey: 'gas_usdt_bep20_address',
    depositAddressEnvFn: () => env.GAS_FEE_DEPOSIT_ADDRESS_BEP20,
    etherscanChainId:    56,
    scanBlocks:          100,
    minConfirmations:    3,
  },
  {
    paymentNetwork:      'ERC20',
    viemChain:           mainnet,
    rpcUrls:             () => uniqUrls(
      env.ALCHEMY_API_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}` : undefined,
      env.ETHEREUM_RPC_URL,
      'https://ethereum-rpc.publicnode.com',
      'https://rpc.ankr.com/eth',
    ),
    usdtContract:        '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    usdtDecimals:        6,
    depositAddressDbKey: 'gas_usdt_erc20_address',
    depositAddressEnvFn: () => env.GAS_FEE_DEPOSIT_ADDRESS_ERC20,
    etherscanChainId:    1,
    scanBlocks:          30,
    minConfirmations:    6,
  },
]

// Heartbeat: record each poller tick so admins can see liveness + health at a
// glance. Read by GET /admin/gas/poller-health. The record accumulates so a
// failing tick still preserves the last successful scan time and block.
//   { lastTickAt, lastSuccessAt, lastErrorAt, lastError, ok, found,
//     currentBlock, syncedBlock, configured }
interface HeartbeatResult {
  ok: boolean
  found?: number
  error?: string
  currentBlock?: number | bigint
  syncedBlock?: number | bigint
  configured?: boolean
}

async function writePollerHeartbeat(network: string, result: HeartbeatResult | number): Promise<void> {
  // Back-compat: a bare number means "successful tick, N found".
  const r: HeartbeatResult = typeof result === 'number' ? { ok: true, found: result } : result
  const key = `gas_poller_health:${network}`
  const now = Date.now()
  try {
    let prev: Record<string, unknown> = {}
    const raw = await redis.get(key)
    if (raw) { try { prev = JSON.parse(raw) as Record<string, unknown> } catch { /* ignore */ } }
    const next: Record<string, unknown> = {
      ...prev,
      // legacy `at` kept so older readers don't break
      at: now,
      lastTickAt: now,
      ok: r.ok,
      configured: r.configured ?? true,
    }
    if (r.found != null) next.found = r.found
    if (r.currentBlock != null) next.currentBlock = Number(r.currentBlock)
    if (r.syncedBlock != null) next.syncedBlock = Number(r.syncedBlock)
    if (r.ok) { next.lastSuccessAt = now; next.lastError = null }
    else { next.lastErrorAt = now; next.lastError = (r.error ?? 'unknown error').slice(0, 300) }
    await redis.set(key, JSON.stringify(next))
  } catch {
    /* best-effort — a heartbeat write failure must never break the poller */
  }
}

// Resolve deposit address: GasChainConfig.depositAddressOverride → PlatformConfig → env var.
// Admins can set the override field in the chain registry without touching PlatformConfig.
async function resolveDepositAddress(dbKey: string, envValue: string | undefined, chainSlug?: string): Promise<string | null> {
  if (chainSlug) {
    const chainCfg = await db.gasChainConfig.findFirst({
      where: { slug: chainSlug.toUpperCase(), isActive: true },
      select: { depositAddressOverride: true },
    }).catch(() => null)
    if (chainCfg?.depositAddressOverride) return chainCfg.depositAddressOverride
  }
  const dbOverride = await db.platformConfig.findUnique({ where: { key: dbKey } })
  if (dbOverride?.value) return dbOverride.value
  return envValue ?? null
}

// ── EVM scanner (getLogs) ───────────────────────────────────────────────────────
async function scanNetwork(cfg: NetworkConfig): Promise<void> {
  // Resolve the deposit address the SAME way order creation does:
  //   env override → platformConfig override → HD-mnemonic EVM hot wallet.
  // Previously this only checked env/DB, so a mnemonic-only deployment resolved
  // null and the poller silently returned — leaving BEP20/ERC20 unscanned and
  // showing "no scan yet" in the admin health card.
  const depositAddress =
    (await resolveDepositAddress(cfg.depositAddressDbKey, cfg.depositAddressEnvFn(), cfg.paymentNetwork))
    ?? getEvmHotWalletAddress()
  if (!depositAddress) {
    await writePollerHeartbeat(cfg.paymentNetwork, { ok: false, configured: false, error: 'No deposit address configured (env, platformConfig, or mnemonic)' })
    return
  }

  // Determine block range: last-checked block → current block.
  const redisKey = `gas_poller_last_block:${cfg.paymentNetwork}`
  const rpcUrls = cfg.rpcUrls()
  if (rpcUrls.length === 0) {
    await writePollerHeartbeat(cfg.paymentNetwork, { ok: false, configured: false, error: 'No RPC URL configured' })
    return
  }

  // Build a client over the first RPC URL that answers getBlockNumber. Returns
  // the client + which URL it used so getLogs can start there and fall through.
  let client: ReturnType<typeof createPublicClient> | undefined
  let currentBlock: bigint | undefined
  for (let i = 0; i < rpcUrls.length; i++) {
    try {
      const c = createPublicClient({ chain: cfg.viemChain, transport: http(rpcUrls[i], { timeout: 10_000 }) })
      currentBlock = await c.getBlockNumber()
      client = c
      break
    } catch {
      /* try next URL */
    }
  }
  if (!client || currentBlock === undefined) {
    await writePollerHeartbeat(cfg.paymentNetwork, { ok: false, error: `All ${rpcUrls.length} RPC endpoint(s) unreachable (getBlockNumber failed)` })
    return
  }

  const storedBlockRaw = await redis.get(redisKey)
  const syncedBlock = storedBlockRaw ? BigInt(storedBlockRaw) : null

  // Skip the (expensive) getLogs when there are no actionable orders, but still
  // record a healthy heartbeat with the current/synced block so admins can see
  // the poller is alive and how far it has synced.
  const graceCutoff = new Date(Date.now() - GRACE_WINDOW_MS)
  const activeOrExpired = await db.gasFeeOrder.count({
    where: {
      paymentNetwork: cfg.paymentNetwork,
      status: { in: ['payment_pending', 'payment_uploaded', 'expired'] },
      expiresAt: { gte: graceCutoff },
    },
  })
  if (activeOrExpired === 0) {
    await writePollerHeartbeat(cfg.paymentNetwork, { ok: true, found: 0, currentBlock, syncedBlock: syncedBlock ?? currentBlock })
    return
  }

  // Only scan up to a "safe tip" that is already minConfirmations deep. Scanning
  // (and advancing the cursor) all the way to the chain head would skip a payment
  // sitting in the last few blocks (confirmations < threshold) AND move the cursor
  // past it, so it would never be re-scanned once confirmed. Capping the ceiling
  // here guarantees every block we attribute is already final and the cursor never
  // jumps a not-yet-confirmed payment.
  const safeToBlock = currentBlock - BigInt(cfg.minConfirmations)
  if (safeToBlock <= 0n) {
    await writePollerHeartbeat(cfg.paymentNetwork, { ok: true, found: 0, currentBlock, syncedBlock: syncedBlock ?? 0n })
    return
  }

  const fromBlock = syncedBlock != null ? syncedBlock + 1n : safeToBlock - BigInt(cfg.scanBlocks)

  // Nothing new (confirmed) since last run.
  if (fromBlock > safeToBlock) {
    await writePollerHeartbeat(cfg.paymentNetwork, { ok: true, found: 0, currentBlock, syncedBlock: syncedBlock ?? safeToBlock })
    return
  }

  // Cap the total window so a long downtime doesn't try to replay the whole chain.
  const maxRange = BigInt(Math.max(cfg.scanBlocks, 500))
  const effectiveFrom = fromBlock < safeToBlock - maxRange ? safeToBlock - maxRange : fromBlock

  // getLogs across [effectiveFrom, safeToBlock] using only getLogs-CAPABLE endpoints
  // (dataseed nodes answer getBlockNumber but reject every range query). Each endpoint
  // is tried in turn; if one rejects the range as too wide we SPLIT it in half and
  // retry — a node that can't serve 500 blocks can almost always serve 50 or 1. This
  // means a single over-wide or rate-limited call can no longer stall detection: the
  // OLD code stopped at the failed chunk and never advanced the cursor, leaving BEP20
  // permanently stuck behind the chain head (the "Request exceeds defined limit" loop).
  const logRpcUrls = getLogsCapable(rpcUrls)
  if (logRpcUrls.length === 0) {
    await writePollerHeartbeat(cfg.paymentNetwork, { ok: false, error: 'No getLogs-capable RPC endpoint configured (only dataseed nodes, which reject getLogs)', currentBlock, syncedBlock: syncedBlock ?? effectiveFrom })
    return
  }

  function getLogsOnce(url: string, from: bigint, to: bigint) {
    const c = createPublicClient({ chain: cfg.viemChain, transport: http(url, { timeout: 15_000 }) })
    return c.getLogs({
      address: cfg.usdtContract,
      event:   TRANSFER_EVENT,
      args:    { to: depositAddress as `0x${string}` },
      fromBlock: from,
      toBlock:   to,
    })
  }
  type LogChunk = Awaited<ReturnType<typeof getLogsOnce>>

  // Cap recursion so a single block no endpoint can serve can't spin forever.
  const MAX_SPLIT_DEPTH = 14

  async function getLogsRange(from: bigint, to: bigint, depth: number): Promise<LogChunk> {
    let primaryErr: unknown // error from the PREFERRED endpoint (Alchemy) — surfaced to admins
    for (let i = 0; i < logRpcUrls.length; i++) {
      const url = logRpcUrls[i]!
      try {
        return await getLogsOnce(url, from, to)
      } catch (err) {
        if (i === 0) primaryErr = err
        // Too-wide range → split and retry (every endpoint, at the smaller size).
        if (isRangeLimitError(err) && to > from && depth < MAX_SPLIT_DEPTH) {
          const mid = from + (to - from) / 2n
          const left  = await getLogsRange(from, mid, depth + 1)
          const right = await getLogsRange(mid + 1n, to, depth + 1)
          return [...left, ...right]
        }
        logger.warn({ network: cfg.paymentNetwork, rpc: url, from: from.toString(), to: to.toString(), err: (err as Error)?.message }, 'gasPaymentPoller: getLogs failed on RPC — trying next')
      }
    }
    if (primaryErr instanceof Error) throw primaryErr
    throw new Error(typeof primaryErr === 'string' ? primaryErr : 'getLogs failed on all getLogs-capable RPC endpoints')
  }

  let logs: LogChunk
  try {
    logs = await getLogsRange(effectiveFrom, safeToBlock, 0)
  } catch (err) {
    // Every capable endpoint failed even after splitting — record the PREFERRED
    // endpoint's error (not a noisy dataseed one) and retry next tick.
    logger.warn({ err, network: cfg.paymentNetwork, from: effectiveFrom.toString(), to: safeToBlock.toString() }, 'gasPaymentPoller: getLogs failed on all capable RPCs — will retry next tick')
    await writePollerHeartbeat(cfg.paymentNetwork, { ok: false, error: `getLogs failed (range ${effectiveFrom}-${safeToBlock}) via ${logRpcUrls[0]}: ${(err as Error)?.message ?? 'all getLogs-capable endpoints rejected the range'}`, currentBlock, syncedBlock: syncedBlock ?? effectiveFrom })
    return
  }

  const totalFound = logs.length
  for (const log of logs) {
    const txHash = log.transactionHash
    if (!txHash) continue
    const rawValue = log.args.value
    if (rawValue === undefined || rawValue === null) continue
    const confirmations = log.blockNumber != null ? Number(currentBlock) - Number(log.blockNumber) : 0
    if (confirmations < cfg.minConfirmations) continue
    const incoming = Number(rawValue) / Math.pow(10, cfg.usdtDecimals)
    if (!(incoming > 0)) continue
    const senderAddress = log.args.from ?? undefined
    const logBlockNumber = log.blockNumber
    await matchAndDeliverGasPayment({
      source: 'poller',
      paymentNetwork: cfg.paymentNetwork,
      txHash,
      incoming,
      confirmations,
      ...(senderAddress !== undefined ? { senderAddress } : {}),
      depositAddress,
      graceCutoff,
      getBlockTimestampMs: async () => {
        if (logBlockNumber == null) return null
        try {
          const block = await client!.getBlock({ blockNumber: logBlockNumber })
          return Number(block.timestamp) * 1000
        } catch (err) {
          logger.warn({ err, txHash }, 'gasPaymentPoller: could not fetch block timestamp for grace check')
          return null
        }
      },
    })
  }

  // Advance the durable cursor only after the full window scanned successfully.
  await redis.set(redisKey, safeToBlock.toString())
  await writePollerHeartbeat(cfg.paymentNetwork, { ok: true, found: totalFound, currentBlock, syncedBlock: safeToBlock })

  if (totalFound > 0) {
    logger.info({ network: cfg.paymentNetwork, count: totalFound, from: effectiveFrom.toString(), to: safeToBlock.toString() }, 'gasPaymentPoller: found Transfer events')
  }
}

// ── EVM scanner (Etherscan V2 explorer API) ─────────────────────────────────────
// Indexer-grade detection for BEP20/ERC20 — the reliable primary path, used in
// preference to getLogs whenever ETHERSCAN_API_KEY is set. Mirrors the TRON
// (TronGrid) and Aptos (indexer) approach: query the deposit address's USDT token
// transfers from a maintained explorer index instead of depending on a public
// archive node honouring getLogs. Etherscan V2 uses ONE key across all chains via
// the `chainid` param (BSC 56, Ethereum 1).
const ETHERSCAN_V2_BASE = 'https://api.etherscan.io/v2/api'

// Etherscan's FREE tier does NOT cover every chain — BSC (chainid=56) returns
// "Free API access is not supported for this chain. Please upgrade your api plan".
// When we see that plan-gate response we cache a per-chain skip flag so we stop
// wasting a failing call every tick and go straight to the getLogs/Alchemy scanner.
// The flag auto-expires, so the (faster, indexer-grade) Etherscan path resumes by
// itself if the operator later upgrades to a paid plan that covers the chain.
const ETHERSCAN_UNSUPPORTED_TTL_S = 6 * 60 * 60
function etherscanUnsupportedKey(chainId: number) { return `gas_etherscan_unsupported:${chainId}` }
function isEtherscanPlanGate(msg: string | undefined): boolean {
  return !!msg && /not supported for this chain|upgrade your api plan/i.test(msg)
}
async function markEtherscanUnsupported(chainId: number, msg: string): Promise<void> {
  try {
    await redis.set(etherscanUnsupportedKey(chainId), msg.slice(0, 200))
    await redis.expire(etherscanUnsupportedKey(chainId), ETHERSCAN_UNSUPPORTED_TTL_S)
  } catch { /* best-effort — never break the poller over a flag write */ }
}
async function isEtherscanUnsupported(chainId: number): Promise<boolean> {
  try { return (await redis.get(etherscanUnsupportedKey(chainId))) != null } catch { return false }
}

interface EtherscanTokenTx {
  blockNumber?: string
  timeStamp?: string
  hash?: string
  from?: string
  to?: string
  value?: string
  contractAddress?: string
  tokenDecimal?: string
  confirmations?: string
}

// Current head block via Etherscan proxy — used only on a cold start so we begin
// scanning from a recent block (not chain genesis, which would surface ancient
// transfers as "unattributed" and spam admins).
async function getEtherscanBlockNumber(chainId: number, apiKey: string): Promise<number | null> {
  const url = new URL(ETHERSCAN_V2_BASE)
  url.searchParams.set('chainid', String(chainId))
  url.searchParams.set('module', 'proxy')
  url.searchParams.set('action', 'eth_blockNumber')
  url.searchParams.set('apikey', apiKey)
  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    const json = (await res.json()) as { result?: string }
    // Plan-gate (e.g. BSC on the free tier): cache a skip flag and bail to fallback.
    if (typeof json.result === 'string' && isEtherscanPlanGate(json.result)) {
      await markEtherscanUnsupported(chainId, json.result)
      return null
    }
    if (!json.result) return null
    const n = Number(BigInt(json.result))
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

async function scanEvmExplorer(cfg: NetworkConfig): Promise<void> {
  const apiKey = env.ETHERSCAN_API_KEY
  if (!apiKey) { await scanNetwork(cfg); return } // no key → fall back to getLogs
  // This chain isn't covered by the current Etherscan plan (cached) — don't waste a
  // failing call every tick; use the getLogs/Alchemy scanner directly.
  if (await isEtherscanUnsupported(cfg.etherscanChainId)) { await scanNetwork(cfg); return }

  const depositAddress =
    (await resolveDepositAddress(cfg.depositAddressDbKey, cfg.depositAddressEnvFn(), cfg.paymentNetwork))
    ?? getEvmHotWalletAddress()
  if (!depositAddress) {
    await writePollerHeartbeat(cfg.paymentNetwork, { ok: false, configured: false, error: 'No deposit address configured (env, platformConfig, or mnemonic)' })
    return
  }

  // Skip the API call entirely when nothing is awaiting payment.
  const graceCutoff = new Date(Date.now() - GRACE_WINDOW_MS)
  const actionable = await db.gasFeeOrder.count({
    where: {
      paymentNetwork: cfg.paymentNetwork,
      status: { in: ['payment_pending', 'payment_uploaded', 'expired'] },
      expiresAt: { gte: graceCutoff },
    },
  })
  if (actionable === 0) { await writePollerHeartbeat(cfg.paymentNetwork, { ok: true, found: 0 }); return }

  // Durable cursor: last block we've fully scanned. Cold start anchors to the
  // current head minus the scan window so we never replay old history.
  const cursorKey = `gas_poller_explorer_block:${cfg.paymentNetwork}`
  const storedBlock = await redis.get(cursorKey)
  let startBlock: number
  if (storedBlock) {
    startBlock = Number(storedBlock) + 1
  } else {
    const head = await getEtherscanBlockNumber(cfg.etherscanChainId, apiKey)
    // Cold-start anchor failed. DON'T give up — if we returned here with no cursor
    // set, every subsequent tick would also be a cold start that fails identically,
    // permanently stalling detection. Fall back to the getLogs/Alchemy scanner so
    // payments are still detected (and the explorer path retries next tick).
    if (head == null) {
      logger.warn({ network: cfg.paymentNetwork }, 'gasPaymentPoller: Etherscan eth_blockNumber failed on cold start — falling back to getLogs/RPC scanner')
      return scanNetwork(cfg)
    }
    startBlock = Math.max(0, head - cfg.scanBlocks)
  }

  const url = new URL(ETHERSCAN_V2_BASE)
  url.searchParams.set('chainid', String(cfg.etherscanChainId))
  url.searchParams.set('module', 'account')
  url.searchParams.set('action', 'tokentx')
  url.searchParams.set('address', depositAddress)
  url.searchParams.set('contractaddress', cfg.usdtContract)
  url.searchParams.set('startblock', String(startBlock))
  url.searchParams.set('endblock', '999999999')
  url.searchParams.set('page', '1')
  url.searchParams.set('offset', '100')
  url.searchParams.set('sort', 'asc')
  url.searchParams.set('apikey', apiKey)

  // On ANY Etherscan failure (HTTP error, rate limit, transient outage) fall back to
  // the getLogs/Alchemy scanner rather than skipping this tick — Etherscan being
  // degraded must never block payment detection. The explorer path retries next tick.
  let result: EtherscanTokenTx[]
  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(12_000) })
    if (!res.ok) {
      logger.warn({ network: cfg.paymentNetwork, status: res.status }, 'gasPaymentPoller: Etherscan HTTP error — falling back to getLogs/RPC scanner')
      return scanNetwork(cfg)
    }
    const json = (await res.json()) as { status?: string; message?: string; result?: EtherscanTokenTx[] | string }
    // Etherscan returns result as a STRING message on status "0" (empty set OR error).
    if (typeof json.result === 'string') {
      if (/no transactions found/i.test(json.result) || json.status === '1') {
        await writePollerHeartbeat(cfg.paymentNetwork, { ok: true, found: 0 })
        return
      }
      if (isEtherscanPlanGate(json.result)) await markEtherscanUnsupported(cfg.etherscanChainId, json.result)
      logger.warn({ network: cfg.paymentNetwork, msg: json.result }, 'gasPaymentPoller: Etherscan returned error/limit — falling back to getLogs/RPC scanner')
      return scanNetwork(cfg)
    }
    result = json.result ?? []
  } catch (err) {
    logger.warn({ err, network: cfg.paymentNetwork }, 'gasPaymentPoller: Etherscan fetch errored — falling back to getLogs/RPC scanner')
    return scanNetwork(cfg)
  }

  if (result.length === 0) { await writePollerHeartbeat(cfg.paymentNetwork, { ok: true, found: 0 }); return }

  // Advance the cursor to the highest CONFIRMED block in the page (any direction —
  // including our own outgoing deliveries/refunds), so a page full of outgoing txs
  // can't stall the cursor. Every confirmed INCOMING transfer up to that block is
  // matched in this same pass, so we never advance past an unprocessed payment.
  // Not-yet-confirmed transfers sit in more-recent blocks and stay behind the
  // cursor until they mature (matchAndDeliver dedupes any boundary tx re-seen).
  let cursorBlock = startBlock - 1
  let processed = 0
  for (const t of result) {
    const txHash = t.hash
    if (!txHash) continue
    const confirmations = Number(t.confirmations ?? 0)
    const blockNum = Number(t.blockNumber ?? 0)
    if (confirmations < cfg.minConfirmations) continue // not final yet — leave behind cursor

    // This block is final: it's safe to move the cursor past it.
    if (blockNum > cursorBlock) cursorBlock = blockNum

    // Only INCOMING USDT to our deposit address is a payment.
    if (!t.to || t.to.toLowerCase() !== depositAddress.toLowerCase()) continue
    if (t.contractAddress && t.contractAddress.toLowerCase() !== cfg.usdtContract.toLowerCase()) continue

    const decimals = t.tokenDecimal ? Number(t.tokenDecimal) : cfg.usdtDecimals
    const raw = t.value
    if (!raw) continue
    let incoming: number
    try { incoming = Number(BigInt(raw)) / Math.pow(10, decimals) } catch { continue }
    if (!(incoming > 0)) continue

    const tsMs = t.timeStamp ? Number(t.timeStamp) * 1000 : null
    await matchAndDeliverGasPayment({
      source: 'poller',
      paymentNetwork: cfg.paymentNetwork,
      txHash,
      incoming,
      confirmations,
      ...(t.from ? { senderAddress: t.from } : {}),
      depositAddress,
      graceCutoff,
      getBlockTimestampMs: async () => tsMs,
    })
    processed++
  }

  if (cursorBlock >= startBlock) await redis.set(cursorKey, String(cursorBlock))
  await writePollerHeartbeat(cfg.paymentNetwork, { ok: true, found: processed })
  if (processed > 0) {
    logger.info({ network: cfg.paymentNetwork, count: processed, fromBlock: startBlock, toBlock: cursorBlock }, 'gasPaymentPoller: Etherscan found USDT transfers')
  }
}

// ── TRON scanner (TronGrid) ─────────────────────────────────────────────────────
// Moralis can't see TRON, so this is the primary detection path for TRC20 payments.
interface TronTrc20Tx {
  transaction_id?: string
  block_timestamp?: number
  from?: string
  to?: string
  value?: string
  type?: string
  token_info?: { address?: string; decimals?: number; symbol?: string }
}

async function scanTron(): Promise<void> {
  const base = env.TRON_FULLNODE_URL
  if (!base) { await writePollerHeartbeat('TRC20', { ok: false, configured: false, error: 'TRON_FULLNODE_URL not set' }); return }

  const depositAddress = await resolveDepositAddress('gas_usdt_trc20_address', env.GAS_FEE_DEPOSIT_ADDRESS_TRC20, 'TRON')
  if (!depositAddress) { await writePollerHeartbeat('TRC20', { ok: false, configured: false, error: 'TRC20 deposit address not configured' }); return }

  const graceCutoff = new Date(Date.now() - GRACE_WINDOW_MS)
  const actionable = await db.gasFeeOrder.count({
    where: {
      paymentNetwork: 'TRC20',
      status: { in: ['payment_pending', 'payment_uploaded', 'expired'] },
      expiresAt: { gte: graceCutoff },
    },
  })
  if (actionable === 0) { await writePollerHeartbeat('TRC20', 0); return }

  const cursorKey = `gas_poller_last_ts:TRC20`
  const storedTs = await redis.get(cursorKey)
  const minTimestamp = storedTs ? Number(storedTs) : Date.now() - TRON_COLD_START_LOOKBACK_MS

  const url = new URL(`${base.replace(/\/$/, '')}/v1/accounts/${depositAddress}/transactions/trc20`)
  url.searchParams.set('only_to', 'true')
  url.searchParams.set('only_confirmed', 'true')
  url.searchParams.set('contract_address', USDT_TRC20_CONTRACT)
  url.searchParams.set('limit', '50')
  url.searchParams.set('order_by', 'block_timestamp,asc')
  url.searchParams.set('min_timestamp', String(minTimestamp))

  const headers: Record<string, string> = {}
  // Header name matches the rest of the codebase's TronGrid calls.
  if (env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = env.TRONGRID_API_KEY

  let transfers: TronTrc20Tx[]
  try {
    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      logger.warn({ status: res.status, network: 'TRC20' }, 'gasPaymentPoller: TronGrid request failed — will retry next tick')
      await writePollerHeartbeat('TRC20', { ok: false, error: `TronGrid HTTP ${res.status}` })
      return // don't advance cursor
    }
    const json = (await res.json()) as { data?: TronTrc20Tx[]; success?: boolean }
    transfers = json.data ?? []
  } catch (err) {
    logger.warn({ err, network: 'TRC20' }, 'gasPaymentPoller: TronGrid fetch errored — will retry next tick')
    await writePollerHeartbeat('TRC20', { ok: false, error: `TronGrid fetch error: ${(err as Error)?.message ?? 'unknown'}` })
    return // don't advance cursor
  }

  if (transfers.length === 0) { await writePollerHeartbeat('TRC20', 0); return }

  logger.info({ network: 'TRC20', count: transfers.length }, 'gasPaymentPoller: found TRC20 transfers')

  let maxTs = minTimestamp
  for (const t of transfers) {
    const ts = Number(t.block_timestamp ?? 0)
    if (ts > maxTs) maxTs = ts

    const txHash = t.transaction_id
    if (!txHash) continue
    if (t.type && t.type !== 'Transfer') continue
    // Defensive: ensure it's the USDT contract (only_to + contract_address already filter).
    if (t.token_info?.address && t.token_info.address !== USDT_TRC20_CONTRACT) continue

    const decimals = t.token_info?.decimals ?? USDT_TRC20_DECIMALS
    const raw = t.value
    if (!raw) continue
    let incoming: number
    try {
      incoming = Number(BigInt(raw)) / Math.pow(10, decimals)
    } catch {
      continue
    }
    if (!(incoming > 0)) continue

    await matchAndDeliverGasPayment({
      source: 'poller',
      paymentNetwork: 'TRC20',
      txHash,
      incoming,
      confirmations: TRON_CONFIRMED_DEPTH,
      ...(t.from ? { senderAddress: t.from } : {}),
      depositAddress,
      graceCutoff,
      getBlockTimestampMs: async () => (ts > 0 ? ts : null),
    })
  }

  // Advance cursor. Using the max timestamp seen (inclusive on next run) is safe —
  // the duplicate guard in matchAndDeliver dedupes any boundary tx re-seen.
  await redis.set(cursorKey, String(maxTs))
  await writePollerHeartbeat('TRC20', transfers.length)
}

// ── Aptos scanner (Indexer GraphQL) ─────────────────────────────────────────────
// Moralis can't see Aptos either, so this is the primary detection path for USDT
// paid on Aptos (the APTOS payment network). Queries the Aptos Indexer for
// incoming fungible-asset deposits of USDT to the Aptos gas wallet.
interface AptosFaActivity {
  transaction_version?: number | string
  event_index?: number | string
  amount?: string
  asset_type?: string
  owner_address?: string
  type?: string
  transaction_timestamp?: string
}

async function scanAptos(): Promise<void> {
  const indexerUrl = env.APTOS_INDEXER_URL
  if (!indexerUrl) { await writePollerHeartbeat('APTOS', { ok: false, configured: false, error: 'Aptos indexer URL not set' }); return }

  const depositAddress = await resolveDepositAddress('gas_usdt_aptos_address', getAptosHotWalletAddress() ?? undefined, 'APT')
  if (!depositAddress) { await writePollerHeartbeat('APTOS', { ok: false, configured: false, error: 'Aptos deposit address not configured' }); return }

  const assetCfg = await db.platformConfig.findUnique({ where: { key: 'gas_usdt_aptos_asset' } })
  const assetType = assetCfg?.value || USDT_APTOS_ASSET_DEFAULT

  const graceCutoff = new Date(Date.now() - GRACE_WINDOW_MS)
  const actionable = await db.gasFeeOrder.count({
    where: {
      paymentNetwork: 'APTOS',
      status: { in: ['payment_pending', 'payment_uploaded', 'expired'] },
      expiresAt: { gte: graceCutoff },
    },
  })
  if (actionable === 0) { await writePollerHeartbeat('APTOS', 0); return }

  const cursorKey = 'gas_poller_last_ts:APTOS'
  const storedTs = await redis.get(cursorKey)
  const minTs = storedTs ?? new Date(Date.now() - APTOS_COLD_START_LOOKBACK_MS).toISOString()

  const query = `
    query GasAptosDeposits($owner: String!, $asset: String!, $minTs: timestamp!) {
      fungible_asset_activities(
        where: {
          owner_address: { _eq: $owner },
          asset_type: { _eq: $asset },
          is_transaction_success: { _eq: true },
          type: { _ilike: "%Deposit%" },
          transaction_timestamp: { _gt: $minTs }
        },
        order_by: { transaction_timestamp: asc },
        limit: 50
      ) {
        transaction_version
        event_index
        amount
        asset_type
        owner_address
        type
        transaction_timestamp
      }
    }`

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (env.APTOS_API_KEY) headers['authorization'] = `Bearer ${env.APTOS_API_KEY}`

  let activities: AptosFaActivity[]
  try {
    const res = await fetch(indexerUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables: { owner: depositAddress, asset: assetType, minTs } }),
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) {
      logger.warn({ status: res.status, network: 'APTOS' }, 'gasPaymentPoller: Aptos indexer request failed — will retry next tick')
      await writePollerHeartbeat('APTOS', { ok: false, error: `Aptos indexer HTTP ${res.status}` })
      return
    }
    const json = (await res.json()) as { data?: { fungible_asset_activities?: AptosFaActivity[] }; errors?: unknown }
    if (json.errors) {
      logger.warn({ errors: json.errors, network: 'APTOS' }, 'gasPaymentPoller: Aptos indexer returned GraphQL errors')
      await writePollerHeartbeat('APTOS', { ok: false, error: 'Aptos indexer GraphQL errors' })
      return
    }
    activities = json.data?.fungible_asset_activities ?? []
  } catch (err) {
    logger.warn({ err, network: 'APTOS' }, 'gasPaymentPoller: Aptos indexer fetch errored — will retry next tick')
    await writePollerHeartbeat('APTOS', { ok: false, error: `Aptos indexer fetch error: ${(err as Error)?.message ?? 'unknown'}` })
    return
  }

  if (activities.length === 0) { await writePollerHeartbeat('APTOS', 0); return }

  logger.info({ network: 'APTOS', count: activities.length }, 'gasPaymentPoller: found Aptos USDT deposits')

  let maxTsStr = minTs
  let maxTsMs = Date.parse(minTs)
  for (const a of activities) {
    const ts = a.transaction_timestamp
    // Aptos indexer timestamps are UTC; append Z when absent for correct parsing.
    const tsMs = ts ? Date.parse(ts.endsWith('Z') ? ts : `${ts}Z`) : NaN
    if (Number.isFinite(tsMs) && tsMs > maxTsMs) { maxTsMs = tsMs; maxTsStr = ts! }

    const version = a.transaction_version != null ? String(a.transaction_version) : null
    if (!version) continue
    const eventIdx = a.event_index != null ? String(a.event_index) : '0'
    const txHash = `aptos:${version}:${eventIdx}`

    const raw = a.amount
    if (!raw) continue
    let incoming: number
    try {
      incoming = Number(BigInt(raw)) / Math.pow(10, USDT_APTOS_DECIMALS)
    } catch {
      continue
    }
    if (!(incoming > 0)) continue

    await matchAndDeliverGasPayment({
      source: 'poller',
      paymentNetwork: 'APTOS',
      txHash,
      incoming,
      confirmations: 1, // is_transaction_success already filtered; Aptos finalizes on commit
      depositAddress,
      graceCutoff,
      getBlockTimestampMs: async () => (Number.isFinite(tsMs) ? tsMs : null),
    })
  }

  await redis.set(cursorKey, maxTsStr)
  await writePollerHeartbeat('APTOS', activities.length)
}

export async function runGasPaymentPoller(): Promise<void> {
  for (const cfg of NETWORK_CONFIGS) {
    try {
      // Prefer the Etherscan explorer API (reliable, indexer-grade) when a key is
      // configured; otherwise fall back to the getLogs RPC scanner. scanEvmExplorer
      // itself defers to scanNetwork when ETHERSCAN_API_KEY is absent.
      await scanEvmExplorer(cfg)
    } catch (err) {
      logger.error({ err, network: cfg.paymentNetwork }, 'gasPaymentPoller: EVM scan threw unexpectedly')
    }
  }

  try {
    await scanTron()
  } catch (err) {
    logger.error({ err, network: 'TRC20' }, 'gasPaymentPoller: scanTron threw unexpectedly')
  }

  try {
    await scanAptos()
  } catch (err) {
    logger.error({ err, network: 'APTOS' }, 'gasPaymentPoller: scanAptos threw unexpectedly')
  }
}
