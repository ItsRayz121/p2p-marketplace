/**
 * Live USDT network fee fetcher for all supported payment chains.
 *
 * Each chain implements the exact fee for a USDT token transfer (not a native
 * coin transfer — those use different gas limits and fee models).
 *
 * Priority for each chain:
 *   1. Redis cache (30 s TTL, key: gas_usdt_fee:<CHAIN>)
 *   2. Live RPC / REST call
 *   3. Hardcoded default (shown with isLive = false)
 *
 * Adding a new payment chain: add a case in getUsdtNetworkFeeUsd() only.
 */

import { redis } from '../redis'
import { getEvmGasPrice } from '../evmRpc'
import { GAS_CHAINS, type GasChainId } from './gas.chains'

export interface NetworkFeeResult {
  feeUsd: number
  feeNative: number
  nativeSymbol: string
  isLive: boolean
  /** Ready-to-display string, e.g. "~$0.29" */
  feeDisplay: string
}

// Gas limit for an ERC-20 USDT transfer on any EVM chain (vs 21,000 for native)
const ERC20_GAS_LIMIT = 65_000n

const STABLES = new Set(['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'USDP'])

async function getUsdPrice(symbol: string): Promise<number> {
  if (STABLES.has(symbol.toUpperCase())) return 1.0
  const raw = await redis.get(`rate:${symbol.toUpperCase()}`)
  if (!raw) return 0
  try {
    const p = JSON.parse(raw) as { usdPrice?: number }
    return p.usdPrice && p.usdPrice > 0 ? p.usdPrice : 0
  } catch { return 0 }
}

async function fromCache(key: string): Promise<NetworkFeeResult | null> {
  try {
    const raw = await redis.get(key)
    if (!raw) return null
    return JSON.parse(raw) as NetworkFeeResult
  } catch { return null }
}

async function toCache(key: string, result: NetworkFeeResult, ttl = 30): Promise<void> {
  await redis.set(key, JSON.stringify(result), 'EX', ttl)
}

function fallback(symbol: string, defaultUsd: number): NetworkFeeResult {
  return { feeUsd: defaultUsd, feeNative: 0, nativeSymbol: symbol, isLive: false, feeDisplay: `~$${defaultUsd.toFixed(2)}` }
}

// ── EVM chains ─────────────────────────────────────────────────────────────────
// eth_gasPrice × 65,000 gas (ERC-20 token transfer) / 1e18 × native/USD

async function evmFee(chainId: GasChainId, nativeSymbol: string, defaultUsd: number): Promise<NetworkFeeResult> {
  const key = `gas_usdt_fee:${chainId}`
  const cached = await fromCache(key)
  if (cached) return cached

  try {
    const gasPriceWei = await getEvmGasPrice(GAS_CHAINS[chainId].getRpcUrl(), chainId)
    const feeNative = Number(gasPriceWei * ERC20_GAS_LIMIT) / 1e18
    const nativeUsd = await getUsdPrice(nativeSymbol)
    if (nativeUsd > 0) {
      const feeUsd = feeNative * nativeUsd
      const result: NetworkFeeResult = { feeUsd, feeNative, nativeSymbol, isLive: true, feeDisplay: `~$${feeUsd.toFixed(2)}` }
      await toCache(key, result)
      return result
    }
  } catch { /* fall through */ }

  return fallback(nativeSymbol, defaultUsd)
}

// ── TRON (TRC-20) ─────────────────────────────────────────────────────────────
// energyPrice (sun/energy) from /wallet/chainparameters × 65,000 energy / 1e6 × TRX/USD
// 65,000 energy = typical USDT TRC-20 transfer cost when account has no energy

async function tronFee(): Promise<NetworkFeeResult> {
  const key = 'gas_usdt_fee:TRON'
  const cached = await fromCache(key)
  if (cached) return cached

  const defaultUsd = 1.50
  try {
    const rpcUrl = GAS_CHAINS.TRON.getRpcUrl()
    const res = await fetch(`${rpcUrl}/wallet/chainparameters`, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/json' },
    })
    if (res.ok) {
      const data = await res.json() as { chainParameter: Array<{ key: string; value: number }> }
      const energyParam = data.chainParameter.find(p => p.key === 'getEnergyFee')
      if (energyParam) {
        const energyPriceSun = energyParam.value // sun per energy unit
        const ENERGY_FOR_USDT = 65_000
        const feeTrx = (energyPriceSun * ENERGY_FOR_USDT) / 1e6
        const trxUsd = await getUsdPrice('TRX')
        if (trxUsd > 0) {
          const feeUsd = feeTrx * trxUsd
          const result: NetworkFeeResult = { feeUsd, feeNative: feeTrx, nativeSymbol: 'TRX', isLive: true, feeDisplay: `~$${feeUsd.toFixed(2)}` }
          await toCache(key, result)
          return result
        }
      }
    }
  } catch { /* fall through */ }

  return fallback('TRX', defaultUsd)
}

// ── Aptos ─────────────────────────────────────────────────────────────────────
// GET /v1/estimate_gas_price → gas_estimate (octas/gas_unit)
// fungible_asset_transfer uses ~900 gas units
// fee = gas_estimate × 900 / 1e8 (octas → APT) × APT/USD

async function aptosFee(): Promise<NetworkFeeResult> {
  const key = 'gas_usdt_fee:APTOS'
  const cached = await fromCache(key)
  if (cached) return cached

  const defaultUsd = 0.01
  try {
    const res = await fetch('https://fullnode.mainnet.aptoslabs.com/v1/estimate_gas_price', {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/json' },
    })
    if (res.ok) {
      const data = await res.json() as { gas_estimate: number }
      const APT_GAS_UNITS = 900 // fungible_asset_transfer
      const feeApt = (data.gas_estimate * APT_GAS_UNITS) / 1e8
      const aptUsd = await getUsdPrice('APT')
      if (aptUsd > 0) {
        const feeUsd = feeApt * aptUsd
        const result: NetworkFeeResult = { feeUsd, feeNative: feeApt, nativeSymbol: 'APT', isLive: true, feeDisplay: `~$${feeUsd.toFixed(2)}` }
        await toCache(key, result)
        return result
      }
    }
  } catch { /* fall through */ }

  return fallback('APT', defaultUsd)
}

// ── Solana ────────────────────────────────────────────────────────────────────
// Base fee: 5,000 lamports × 2 signatures = 10,000 lamports (mandatory)
// Priority fee: median of getRecentPrioritizationFees × 200,000 CU / 1,000,000
// Total / 1e9 → SOL → USD

async function solanaFee(): Promise<NetworkFeeResult> {
  const key = 'gas_usdt_fee:SOL'
  const cached = await fromCache(key)
  if (cached) return cached

  const defaultUsd = 0.001
  try {
    const rpcUrl = GAS_CHAINS.SOL.getRpcUrl()
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getRecentPrioritizationFees', params: [] }),
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) {
      const data = await res.json() as { result?: Array<{ prioritizationFee: number }> }
      const fees = (data.result ?? []).sort((a, b) => a.prioritizationFee - b.prioritizationFee)
      const midItem = fees[Math.floor(fees.length / 2)]
      const median = fees.length > 0 && midItem ? midItem.prioritizationFee : 0
      const BASE_LAMPORTS = 10_000          // 5000 lamports × 2 sigs
      const COMPUTE_UNITS = 200_000
      const priorityLamports = Math.ceil(median * COMPUTE_UNITS / 1_000_000)
      const feeSol = (BASE_LAMPORTS + priorityLamports) / 1e9
      const solUsd = await getUsdPrice('SOL')
      if (solUsd > 0) {
        const feeUsd = feeSol * solUsd
        const result: NetworkFeeResult = { feeUsd, feeNative: feeSol, nativeSymbol: 'SOL', isLive: true, feeDisplay: `~$${feeUsd.toFixed(2)}` }
        await toCache(key, result)
        return result
      }
    }
  } catch { /* fall through */ }

  return fallback('SOL', defaultUsd)
}

// ── TON ───────────────────────────────────────────────────────────────────────
// Jetton (USDT) transfer: fixed 0.055 TON minimum (forward fee + gas + storage
// deposit). TON's fee model is based on cells/bits, not a simple gas price,
// so we use the well-known minimum and apply live TON/USD price.

async function tonFee(): Promise<NetworkFeeResult> {
  const key = 'gas_usdt_fee:TON'
  const cached = await fromCache(key)
  if (cached) return cached

  const JETTON_FEE_TON = 0.055 // minimum for any jetton transfer
  const defaultUsd = 0.05
  try {
    const tonUsd = await getUsdPrice('TON')
    if (tonUsd > 0) {
      const feeUsd = JETTON_FEE_TON * tonUsd
      const result: NetworkFeeResult = { feeUsd, feeNative: JETTON_FEE_TON, nativeSymbol: 'TON', isLive: true, feeDisplay: `~$${feeUsd.toFixed(2)}` }
      await toCache(key, result, 60)
      return result
    }
  } catch { /* fall through */ }

  return { feeUsd: defaultUsd, feeNative: JETTON_FEE_TON, nativeSymbol: 'TON', isLive: false, feeDisplay: `~$${defaultUsd.toFixed(2)}` }
}

// ── SUI ───────────────────────────────────────────────────────────────────────
// suix_getReferenceGasPrice → price in MIST (1 SUI = 1e9 MIST)
// Coin transfer computation budget: ~1,000 units
// fee = gasPrice × 1,000 / 1e9 × SUI/USD

async function suiFee(): Promise<NetworkFeeResult> {
  const key = 'gas_usdt_fee:SUI'
  const cached = await fromCache(key)
  if (cached) return cached

  const defaultUsd = 0.01
  try {
    const rpcUrl = GAS_CHAINS.SUI.getRpcUrl()
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'suix_getReferenceGasPrice', params: [] }),
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) {
      const data = await res.json() as { result?: string }
      if (data.result) {
        const gasPriceMist = BigInt(data.result)
        const COMPUTE_UNITS = 1_000n
        const feeSui = Number(gasPriceMist * COMPUTE_UNITS) / 1e9
        const suiUsd = await getUsdPrice('SUI')
        if (suiUsd > 0) {
          const feeUsd = feeSui * suiUsd
          const result: NetworkFeeResult = { feeUsd, feeNative: feeSui, nativeSymbol: 'SUI', isLive: true, feeDisplay: `~$${feeUsd.toFixed(2)}` }
          await toCache(key, result)
          return result
        }
      }
    }
  } catch { /* fall through */ }

  return fallback('SUI', defaultUsd)
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Returns the live USDT transfer network fee for a given payment chain.
 * Always resolves — never throws. Falls back to a hardcoded default on any
 * RPC or price-feed failure.
 *
 * To add a new payment chain: add a case below and implement its fetcher above.
 */
export async function getUsdtNetworkFeeUsd(chainId: GasChainId | 'APTOS'): Promise<NetworkFeeResult> {
  switch (chainId) {
    case 'BSC':      return evmFee('BSC',      'BNB',  0.29)
    case 'ETHEREUM': return evmFee('ETHEREUM',  'ETH',  2.00)
    case 'BASE':     return evmFee('BASE',      'ETH',  0.05)
    case 'ARB':      return evmFee('ARB',       'ETH',  0.10)
    case 'OP':       return evmFee('OP',        'ETH',  0.10)
    case 'MATIC':    return evmFee('MATIC',     'POL',  0.02)
    case 'AVAX':     return evmFee('AVAX',      'AVAX', 0.10)
    case 'TRON':     return tronFee()
    case 'APTOS':    return aptosFee()
    case 'SOL':      return solanaFee()
    case 'TON':      return tonFee()
    case 'SUI':      return suiFee()
  }
}
