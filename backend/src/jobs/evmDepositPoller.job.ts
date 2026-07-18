// EVM USER deposit poller — Moralis-independent backstop.
//
// Moralis Streams is the primary detection path for deposits to per-user EVM
// addresses, but it is a single external point of failure: a paused stream,
// dropped delivery, or webhook-secret drift silently swallows deposits (the
// 2026-07-18 incident: 1 USDT BEP20 to a subscribed address produced no
// webhook at all). This poller scans ERC20 Transfer logs to OUR deposit
// addresses directly via RPC, so detection no longer depends on Moralis.
//
// SAFETY MODEL (money movement — read before editing):
//   - Every hit is fed through processDepositEvent — the SAME pipeline the
//     webhook uses. Its unique (txHash, chain, asset) key + atomic
//     detected→credited gate make crediting exactly-once; re-scanning a block
//     range can never double-credit.
//   - processDepositEvent independently RPC-verifies the receipt (revert check
//     + real confirmation count) before crediting, so a lying/lagging scan RPC
//     can't credit a reverted or unconfirmed tx.
//   - The per-chain block cursor only advances when every chunk in the tick
//     succeeded, and is re-scanned with an overlap; missed pages are retried
//     next tick.
//
// SCOPE: ERC20 Transfer logs only. Native coin deposits (ETH/BNB/POL sent
// directly) have no event logs and would need per-block tx scanning — Moralis
// still covers those, and `npm run deposits:rescan -- <chain> <txHash>`
// handles one-off recovery.

import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { logger } from '../lib/logger'
import { env } from '../lib/env'
import { getAllChains, getRpcUrl } from '../services/chainRegistry.service'
import { getBlockNumber, getLogs } from '../lib/evmRpc'
import { processDepositEvent } from '../services/depositWatcher.service'

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

const CURSOR_KEY_PREFIX = 'evm_deposit_poller_last_block:'
const HEARTBEAT_KEY = 'evm_deposit_poller_health'

// Cold start (no cursor): look back this many blocks so recent deposits are
// caught on first run without an unbounded historical scan.
const COLD_START_BLOCKS = 1000n
// Re-scan overlap behind the cursor — a boundary block is never skipped;
// idempotency makes re-reads free.
const CURSOR_OVERLAP_BLOCKS = 10n
// Cap the blocks covered per chain per tick so one tick stays bounded; if the
// poller is further behind it catches up across subsequent ticks.
const MAX_BLOCKS_PER_TICK = 1500n

// Public BSC "dataseed" nodes reject getLogs range queries — never scan with them.
const GETLOGS_INCAPABLE_RE = /dataseed|ninicoin/i

// getLogs-capable fallback endpoints per chain, tried after the operator's
// configured RPC. Mirrors the gas payment poller's endpoint strategy.
const FALLBACK_LOG_RPCS: Record<string, string[]> = {
  bsc: [
    'https://bsc-rpc.publicnode.com',
    'https://bsc.drpc.org',
    'https://bsc-mainnet.public.blastapi.io',
  ],
  ethereum: [
    'https://ethereum-rpc.publicnode.com',
    'https://eth.drpc.org',
  ],
  polygon: ['https://polygon-bor-rpc.publicnode.com'],
  arbitrum: ['https://arbitrum-one-rpc.publicnode.com'],
  optimism: ['https://optimism-rpc.publicnode.com'],
  base: ['https://base-rpc.publicnode.com'],
}

function scanRpcCandidates(chainId: string): string[] {
  const configured = getRpcUrl(chainId)
  const alchemyHost: Record<string, string> = {
    bsc: 'bnb-mainnet',
    ethereum: 'eth-mainnet',
    polygon: 'polygon-mainnet',
    arbitrum: 'arb-mainnet',
    optimism: 'opt-mainnet',
    base: 'base-mainnet',
  }
  const alchemy = env.ALCHEMY_API_KEY && alchemyHost[chainId]
    ? `https://${alchemyHost[chainId]}.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`
    : undefined
  const urls = [alchemy, configured, ...(FALLBACK_LOG_RPCS[chainId] ?? [])]
    .filter((u): u is string => !!u)
    .filter((u) => !GETLOGS_INCAPABLE_RE.test(u))
  return [...new Set(urls)]
}

/** Left-pad an EVM address to a 32-byte topic value. */
function addressToTopic(address: string): string {
  return '0x' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0')
}

async function writeHeartbeat(perChain: Record<string, unknown>): Promise<void> {
  try {
    await redis.set(HEARTBEAT_KEY, JSON.stringify({ at: new Date().toISOString(), chains: perChain }))
  } catch { /* best-effort */ }
}

/** getLogs with endpoint fall-through — first candidate that answers wins. */
async function getLogsWithFallback(
  chainId: string,
  urls: string[],
  params: Parameters<typeof getLogs>[2],
): Promise<Awaited<ReturnType<typeof getLogs>> | null> {
  let lastError = ''
  for (const url of urls) {
    try {
      return await getLogs(url, chainId, params)
    } catch (err) {
      lastError = (err as Error).message?.slice(0, 200) ?? 'unknown'
    }
  }
  // warn (not debug) — this is the diagnosable signal when a chain's cursor
  // stalls; includes the LAST endpoint's error which is usually representative.
  logger.warn(
    { chainId, fromBlock: params.fromBlock.toString(), toBlock: params.toBlock.toString(), lastError },
    'evmDepositPoller: getLogs failed on every endpoint for this range',
  )
  return null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function scanChain(
  chain: { id: string; chainId: number; tokens: Array<{ symbol: string; address: string | null; decimals: number }> },
  toTopics: string[],
): Promise<{ ok: boolean; scanned?: number; credited?: number; detected?: number; error?: string; cursor?: string }> {
  const tokenContracts = chain.tokens
    .map((t) => t.address)
    .filter((a): a is string => !!a)
  if (tokenContracts.length === 0) return { ok: true, scanned: 0, credited: 0, detected: 0 }

  const rpcUrls = scanRpcCandidates(chain.id)
  if (rpcUrls.length === 0) return { ok: false, error: 'no getLogs-capable RPC configured' }

  // Current head — first endpoint that answers.
  let currentBlock: bigint | null = null
  for (const url of rpcUrls) {
    try { currentBlock = await getBlockNumber(url, chain.id); break } catch { /* next */ }
  }
  if (currentBlock === null) return { ok: false, error: 'all RPC endpoints failed for eth_blockNumber' }

  const cursorKey = CURSOR_KEY_PREFIX + chain.id
  const storedCursor = await redis.get(cursorKey)
  let fromBlock: bigint
  if (storedCursor && /^\d+$/.test(storedCursor)) {
    const cursor = BigInt(storedCursor)
    fromBlock = cursor > CURSOR_OVERLAP_BLOCKS ? cursor - CURSOR_OVERLAP_BLOCKS : 0n
  } else {
    fromBlock = currentBlock > COLD_START_BLOCKS ? currentBlock - COLD_START_BLOCKS : 0n
  }
  if (fromBlock > currentBlock) fromBlock = currentBlock

  // Bound the tick.
  const toBlock = (currentBlock - fromBlock) > MAX_BLOCKS_PER_TICK
    ? fromBlock + MAX_BLOCKS_PER_TICK
    : currentBlock

  const chunkSize = BigInt(Math.max(1, env.MAX_LOG_SCAN_BLOCKS))
  let credited = 0
  let detected = 0

  // Chunks are scanned in block order and the cursor advances to the end of the
  // last CONTIGUOUS successful chunk. On the first failure we stop — never
  // continue past a failed page (a deposit inside it would be skipped forever).
  // Partial progress is essential: with all-or-nothing advancement one flaky
  // page per tick re-runs the whole cold-start window every 2 minutes, which
  // itself triggers free-RPC throttling (observed on BSC/Polygon in prod).
  let lastGoodBlock: bigint | null = null
  let failed = false

  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = start + chunkSize - 1n > toBlock ? toBlock : start + chunkSize - 1n
    const logs = await getLogsWithFallback(chain.id, rpcUrls, {
      fromBlock: start,
      toBlock: end,
      address: tokenContracts,
      topics: [TRANSFER_TOPIC, null, toTopics],
    })
    if (logs === null) { failed = true; break }

    let chunkProcessingFailed = false
    for (const log of logs) {
      if (log.topics.length < 3) continue
      const from = '0x' + (log.topics[1] ?? '').slice(-40)
      const to = '0x' + (log.topics[2] ?? '').slice(-40)
      let value: bigint
      try {
        value = log.data === '0x' || log.data === '' ? 0n : BigInt(log.data)
      } catch { continue }
      if (value === 0n) continue

      const confirmations = currentBlock >= log.blockNumber
        ? Number(currentBlock - log.blockNumber + 1n)
        : 0

      try {
        const result = await processDepositEvent({
          chainId: chain.chainId,
          txHash: log.transactionHash,
          fromAddress: from,
          toAddress: to,
          asset: log.address,
          symbol: '',
          amount: value.toString(),
          confirmations,
        })
        if (result.status === 'credited') credited++
        else if (result.status === 'pending') detected++
      } catch (err) {
        logger.error({ err, chain: chain.id, txHash: log.transactionHash }, 'evmDepositPoller: processDepositEvent threw')
        chunkProcessingFailed = true
      }
    }
    // A processing throw means an event in THIS chunk wasn't recorded — don't
    // advance the cursor past it; retry the chunk next tick (idempotent).
    if (chunkProcessingFailed) { failed = true; break }

    lastGoodBlock = end
    // Pace requests so a multi-chunk catch-up doesn't trip free-RPC rate limits.
    if (end < toBlock) await sleep(150)
  }

  if (lastGoodBlock !== null) {
    await redis.set(cursorKey, lastGoodBlock.toString())
  }

  const scannedTo = lastGoodBlock ?? fromBlock
  return {
    ok: !failed,
    scanned: lastGoodBlock !== null ? Number(lastGoodBlock - fromBlock + 1n) : 0,
    credited,
    detected,
    cursor: scannedTo.toString(),
    ...(failed ? { error: `page failed after block ${scannedTo} — resuming there next tick` } : {}),
  }
}

export async function runEvmDepositPoller(): Promise<void> {
  // Every per-user EVM deposit address (one HD address per user, shared across
  // all EVM chains).
  const rows = await db.depositAddress.findMany({
    where: { chainFamily: 'EVM' },
    select: { address: true },
  })
  if (rows.length === 0) {
    await writeHeartbeat({ note: 'no EVM deposit addresses yet' })
    return
  }
  const toTopics = rows.map((r) => addressToTopic(r.address))

  const chains = (await getAllChains()).filter(
    (c): c is typeof c & { chainId: number } => c.family === 'EVM' && c.chainId != null,
  )

  const health: Record<string, unknown> = {}
  for (const chain of chains) {
    try {
      health[chain.id] = await scanChain(chain, toTopics)
    } catch (err) {
      logger.error({ err, chain: chain.id }, 'evmDepositPoller: chain scan threw')
      health[chain.id] = { ok: false, error: (err as Error).message?.slice(0, 200) }
    }
  }

  const creditedTotal = Object.values(health).reduce<number>(
    (n, h) => n + (typeof h === 'object' && h && 'credited' in h ? Number((h as { credited?: number }).credited ?? 0) : 0),
    0,
  )
  if (creditedTotal > 0) {
    logger.info({ health }, 'evmDepositPoller: credited deposits this tick')
  }
  await writeHeartbeat(health)
}
