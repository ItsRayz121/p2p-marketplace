/**
 * Hot-wallet send serialization (nonce-collision guard).
 *
 * The platform broadcasts on-chain transactions from a SINGLE EVM hot wallet
 * address (HOT_WALLET_INDEX) via two independent code paths:
 *   - withdrawal.sender.ts  → ERC20 token transfers (user withdrawals)
 *   - gas/gas.delivery.ts   → native-token sends (gas station deliveries)
 *
 * Without coordination, two concurrent sends on the same chain each fetch the
 * same pending nonce and produce two txs with an identical nonce — one silently
 * replaces/drops the other in the mempool. The user's balance is already debited
 * but the funds never arrive.
 *
 * This module provides a per-chain Redis mutex. Callers acquire the lock, read
 * the pending nonce, broadcast with an explicit nonce, then release. Different
 * chains never block each other (nonces are per-address-per-chain).
 */

import { randomBytes } from 'node:crypto'
import { redis } from './redis'
import { logger } from './logger'

// The lock is held only around nonce-read + broadcast (not confirmation), so a
// generous TTL comfortably covers the EVM delivery retry loop (~6s) plus RPC
// latency, while still self-healing if a process dies mid-send.
const LOCK_TTL_MS = 120_000
const MAX_WAIT_MS = 30_000
const RETRY_DELAY_MS = 250

/**
 * Normalize the many chain spellings used across the codebase to one canonical
 * key per physical chain, so the withdrawal sender (slug ids like "ethereum")
 * and the gas delivery path (GasChain enum like "ETH") map to the SAME lock.
 */
export function normalizeEvmChainKey(input: string): string {
  const s = input.trim().toLowerCase()
  const map: Record<string, string> = {
    eth: 'ethereum', ethereum: 'ethereum', mainnet: 'ethereum',
    bsc: 'bsc', bnb: 'bsc',
    matic: 'polygon', polygon: 'polygon',
    arb: 'arbitrum', arbitrum: 'arbitrum',
    op: 'optimism', optimism: 'optimism',
    base: 'base',
    avax: 'avalanche', avalanche: 'avalanche',
  }
  return map[s] ?? s
}

// Compare-and-delete so we only release a lock we still own (never a lock that
// already expired and was re-acquired by another sender).
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

/**
 * Run `fn` while holding an exclusive per-chain hot-wallet lock. Throws if the
 * lock can't be acquired within MAX_WAIT_MS (caller leaves the send pending for
 * the recovery job to retry, rather than risking a colliding broadcast).
 */
export async function withHotWalletLock<T>(chainInput: string, fn: () => Promise<T>): Promise<T> {
  const key = `hotwallet:nonce:lock:${normalizeEvmChainKey(chainInput)}`
  const token = randomBytes(16).toString('hex')
  const deadline = Date.now() + MAX_WAIT_MS

  let acquired = false
  while (Date.now() < deadline) {
    const res = await redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX')
    if (res === 'OK') {
      acquired = true
      break
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
  }

  if (!acquired) {
    throw new Error(`hotWalletLock: could not acquire lock for ${key} within ${MAX_WAIT_MS}ms`)
  }

  try {
    return await fn()
  } finally {
    try {
      await redis.eval(RELEASE_SCRIPT, 1, key, token)
    } catch (err) {
      logger.warn({ err, key }, 'hotWalletLock: lock release failed (will self-expire)')
    }
  }
}
