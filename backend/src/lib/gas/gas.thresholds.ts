/**
 * Per-chain refill threshold management.
 * Thresholds define when and how much to refill the hot wallet from treasury.
 */

import type { GasChain } from '@prisma/client'
import { db } from '../prisma'
import type { GasChainId } from './gas.chains'
import { toDbChain } from './gas.chains'

export interface ThresholdData {
  triggerBelowNative: number
  refillTargetNative: number
  maxRefillNative: number
  isEnabled?: boolean
}

export async function getAllThresholds() {
  return db.gasRefillThreshold.findMany({ orderBy: { chain: 'asc' } })
}

export async function getThreshold(chain: GasChainId) {
  return db.gasRefillThreshold.findUnique({ where: { chain: toDbChain(chain) } })
}

export async function upsertThreshold(chain: GasChainId, data: ThresholdData) {
  const dbChain = toDbChain(chain)
  return db.gasRefillThreshold.upsert({
    where: { chain: dbChain },
    create: {
      chain: dbChain,
      triggerBelowNative: data.triggerBelowNative,
      refillTargetNative: data.refillTargetNative,
      maxRefillNative:    data.maxRefillNative,
      isEnabled:          data.isEnabled ?? true,
    },
    update: {
      triggerBelowNative: data.triggerBelowNative,
      refillTargetNative: data.refillTargetNative,
      maxRefillNative:    data.maxRefillNative,
      ...(data.isEnabled !== undefined ? { isEnabled: data.isEnabled } : {}),
    },
  })
}

export async function setThresholdEnabled(chain: GasChainId, isEnabled: boolean) {
  return db.gasRefillThreshold.update({
    where: { chain: toDbChain(chain) },
    data: { isEnabled },
  })
}

/** Returns all enabled thresholds — used by the balance-check job */
export async function getEnabledThresholds() {
  return db.gasRefillThreshold.findMany({ where: { isEnabled: true } })
}

/** Validates threshold values are self-consistent */
export function validateThreshold(data: ThresholdData): string | null {
  if (data.triggerBelowNative <= 0) return 'triggerBelowNative must be > 0'
  if (data.refillTargetNative <= data.triggerBelowNative) {
    return 'refillTargetNative must be > triggerBelowNative (target must be above the trigger floor)'
  }
  if (data.maxRefillNative <= 0) return 'maxRefillNative must be > 0'
  // Note: maxRefillNative may intentionally be less than (target - trigger) for chunk-refill patterns
  return null
}

// ── DB chain → GasChainId conversion (for display) ───────────────────────────

const DB_CHAIN_TO_ID: Record<GasChain, GasChainId> = {
  TRON: 'TRON', BSC: 'BSC', ETH: 'ETHEREUM', SOL: 'SOL',
  MATIC: 'MATIC', ARB: 'ARB', BASE: 'BASE', OP: 'OP',
  AVAX: 'AVAX', TON: 'TON', SUI: 'SUI',
}

export function dbChainToId(chain: GasChain): GasChainId {
  return DB_CHAIN_TO_ID[chain]
}
