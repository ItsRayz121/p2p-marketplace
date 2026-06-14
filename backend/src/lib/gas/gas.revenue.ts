/**
 * Platform revenue withdrawal — safe accounting for moving platform-owned funds
 * out of the shared hot wallet to an EXTERNAL wallet the operator controls.
 *
 * The hot wallet (HD index 0) is shared: it custodies user balances AND holds
 * platform revenue (gas-order payments + withdrawal fees). To make a withdrawal
 * that can NEVER touch user funds, the withdrawable amount is computed as:
 *
 *   withdrawable = onChainTokenBalance
 *                − userLiability        (sum of all user Wallet balances for that coin/network)
 *                − pendingOutflows      (approved/pending user withdrawals not yet on-chain)
 *                − safetyBuffer         (configurable reserve, default 0)
 *
 * This is intentionally conservative — every term reduces the headroom, so the
 * result is always ≤ true platform-owned balance. Withdrawals are hard-capped at
 * this number by the route handler before any on-chain transfer happens.
 *
 * Destination addresses are operator-configured (PlatformConfig), NOT derived
 * from the platform mnemonic, so funds actually leave platform custody.
 */

import { db } from '../prisma'
import { getHotWalletTokenBalance } from './gas.tokenBalance'
import {
  getEvmHotWalletAddress,
  getTronHotWalletAddress,
} from './gasWalletService'
import { getAptosHotWalletAddress } from './aptosWalletService'

export type WithdrawFamily = 'evm' | 'tron' | 'aptos'

// PlatformConfig keys holding the external destination address per chain family.
export const WITHDRAW_DEST_KEY: Record<WithdrawFamily, string> = {
  evm:   'gas_withdraw_dest_evm',
  tron:  'gas_withdraw_dest_tron',
  aptos: 'gas_withdraw_dest_aptos',
}

// Optional per-family safety reserve (token units) kept in the wallet on top of
// the liability subtraction. PlatformConfig key, defaults to 0.
const WITHDRAW_BUFFER_KEY: Record<WithdrawFamily, string> = {
  evm:   'gas_withdraw_buffer_evm',
  tron:  'gas_withdraw_buffer_tron',
  aptos: 'gas_withdraw_buffer_aptos',
}

// GasChain enum value → withdraw family. SOL/TON/SUI return null (no payout path).
export function chainFamily(chain: string): WithdrawFamily | null {
  const c = chain.toUpperCase()
  if (c === 'TRON') return 'tron'
  if (c === 'APT' || c === 'APTOS') return 'aptos'
  if (['BSC', 'ETH', 'ETHEREUM', 'BASE', 'ARB', 'OP', 'MATIC', 'AVAX'].includes(c)) return 'evm'
  return null
}

// GasChain enum value → the network label users see on their Wallet/Withdrawal rows.
// Used to sum the custodial liability for the matching on-chain token pool.
const CHAIN_TO_WALLET_NETWORK: Record<string, string> = {
  BSC: 'BEP20', ETH: 'ERC20', ETHEREUM: 'ERC20', TRON: 'TRC20', APT: 'APTOS',
}

// ── Destination address validation ──────────────────────────────────────────

const EVM_ADDR   = /^0x[0-9a-fA-F]{40}$/
const TRON_ADDR  = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const APTOS_ADDR = /^0x[0-9a-fA-F]{1,64}$/

export function validateDestination(family: WithdrawFamily, address: string): boolean {
  const a = address.trim()
  if (family === 'evm')   return EVM_ADDR.test(a)
  if (family === 'tron')  return TRON_ADDR.test(a)
  if (family === 'aptos') return APTOS_ADDR.test(a)
  return false
}

// ── Destination config ──────────────────────────────────────────────────────

export async function getWithdrawDestination(family: WithdrawFamily): Promise<string | null> {
  const row = await db.platformConfig.findUnique({ where: { key: WITHDRAW_DEST_KEY[family] } })
  const v = row?.value?.trim()
  return v && v.length > 0 ? v : null
}

export async function getAllWithdrawDestinations(): Promise<Record<WithdrawFamily, string | null>> {
  const rows = await db.platformConfig.findMany({
    where: { key: { in: Object.values(WITHDRAW_DEST_KEY) } },
  })
  const map = Object.fromEntries(rows.map(r => [r.key, r.value?.trim() || null]))
  return {
    evm:   map[WITHDRAW_DEST_KEY.evm]   ?? null,
    tron:  map[WITHDRAW_DEST_KEY.tron]  ?? null,
    aptos: map[WITHDRAW_DEST_KEY.aptos] ?? null,
  }
}

export async function setWithdrawDestination(family: WithdrawFamily, address: string) {
  return db.platformConfig.upsert({
    where:  { key: WITHDRAW_DEST_KEY[family] },
    create: { key: WITHDRAW_DEST_KEY[family], value: address.trim() },
    update: { value: address.trim() },
  })
}

async function getBuffer(family: WithdrawFamily): Promise<number> {
  const row = await db.platformConfig.findUnique({ where: { key: WITHDRAW_BUFFER_KEY[family] } })
  const v = Number(row?.value ?? 0)
  return Number.isFinite(v) && v > 0 ? v : 0
}

// ── Token contract resolution ───────────────────────────────────────────────

/**
 * Resolve the on-chain contract address for a (chain, token) pair from the gas
 * token registry, falling back to the chain-level USDT contract.
 */
export async function resolveTokenContract(chain: string, tokenSymbol: string): Promise<string | null> {
  const sym = tokenSymbol.toUpperCase()
  const enumChain = chain.toUpperCase()

  const tokenCfg = await db.gasTokenConfig.findFirst({
    where: {
      symbol: { equals: sym, mode: 'insensitive' },
      tokenType: { not: 'native' },
      chain: { backendChainId: enumChain },
    },
    select: { contractAddress: true },
  }).catch(() => null)
  if (tokenCfg?.contractAddress) return tokenCfg.contractAddress

  if (sym === 'USDT') {
    const chainCfg = await db.gasChainConfig.findFirst({
      where: { backendChainId: enumChain },
      select: { usdtContractAddress: true },
    }).catch(() => null)
    if (chainCfg?.usdtContractAddress) return chainCfg.usdtContractAddress
  }
  return null
}

// ── Hot wallet owner per chain ──────────────────────────────────────────────

function hotWalletFor(chain: string): string | null {
  const fam = chainFamily(chain)
  if (fam === 'tron')  return getTronHotWalletAddress()
  if (fam === 'aptos') return getAptosHotWalletAddress()
  if (fam === 'evm')   return getEvmHotWalletAddress()
  return null
}

// ── Safe withdrawable calculation ───────────────────────────────────────────

export interface WithdrawableResult {
  token: string
  chain: string
  family: WithdrawFamily | null
  network: string | null
  onChain: number          // live hot-wallet token balance
  userLiability: number    // owed to users (Wallet balances)
  pendingOut: number       // user withdrawals deducted but not yet on-chain
  buffer: number
  available: number        // safe-to-withdraw (>= 0)
  destinationSet: boolean
  supported: boolean       // payout implemented for this chain family
}

/**
 * Compute the conservative platform-owned balance that can be withdrawn for a
 * given (chain, token). Never throws — returns zeros with supported=false on any
 * read failure so the UI degrades gracefully.
 */
export async function getWithdrawable(chain: string, tokenSymbol: string): Promise<WithdrawableResult> {
  const family  = chainFamily(chain)
  const network = CHAIN_TO_WALLET_NETWORK[chain.toUpperCase()] ?? null
  // EVM + Aptos payout is implemented; TRON is manual (see treasury.sweep).
  const supported = family === 'evm' || family === 'aptos'

  const base: WithdrawableResult = {
    token: tokenSymbol.toUpperCase(), chain: chain.toUpperCase(), family, network,
    onChain: 0, userLiability: 0, pendingOut: 0, buffer: 0, available: 0,
    destinationSet: false, supported,
  }
  if (!family) return base

  try {
    const owner = hotWalletFor(chain)
    const contract = await resolveTokenContract(chain, tokenSymbol)
    if (!owner || !contract) return base

    const [{ balance: onChain }, liabilityAgg, pendingAgg, dest, buffer] = await Promise.all([
      getHotWalletTokenBalance(chain.toUpperCase(), contract, owner),
      network
        ? db.wallet.aggregate({ _sum: { balance: true, lockedBalance: true }, where: { coin: base.token, network } })
        : Promise.resolve({ _sum: { balance: null, lockedBalance: null } }),
      network
        ? db.withdrawal.aggregate({
            _sum: { amount: true, fee: true },
            where: { coin: base.token, network, status: { in: ['pending', 'first_approved', 'approved', 'auto_approved', 'on_hold'] } },
          })
        : Promise.resolve({ _sum: { amount: null, fee: null } }),
      getWithdrawDestination(family),
      getBuffer(family),
    ])

    const userLiability = Number(liabilityAgg._sum.balance ?? 0) + Number(liabilityAgg._sum.lockedBalance ?? 0)
    const pendingOut    = Number(pendingAgg._sum.amount ?? 0) + Number(pendingAgg._sum.fee ?? 0)
    const available     = Math.max(0, onChain - userLiability - pendingOut - buffer)

    return {
      ...base,
      onChain, userLiability, pendingOut, buffer, available,
      destinationSet: !!dest,
    }
  } catch {
    return base
  }
}
