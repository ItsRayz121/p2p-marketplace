/**
 * Automated withdrawal sender — sends ERC20 tokens (USDT/USDC) from the
 * platform hot wallet for auto-approved (Tier 1) withdrawals.
 *
 * Called fire-and-forget from requestWithdrawal after the DB record is created.
 * On success: updates withdrawal → sent and the pending Transaction → completed.
 * On failure: leaves withdrawal as auto_approved and alerts admins.
 */

import { createWalletClient, http, parseUnits, type Chain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum, base, bsc, mainnet, optimism, polygon } from 'viem/chains'
import { db } from './prisma'
import { env } from './env'
import {
  decryptGasSeed,
  deriveEvmPrivateKeyHex,
  HOT_WALLET_INDEX,
} from './gas/gasWalletService'
import { getChainByNetworkLabel } from '../services/chainRegistry.service'
import { logger as log } from './logger'
import { createAdminNotif } from '../services/adminNotification.service'

const ERC20_TRANSFER_ABI = [
  {
    name: 'transfer',
    type: 'function' as const,
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const

const VIEM_CHAINS: Partial<Record<string, Chain>> = {
  ethereum: mainnet,
  bsc,
  polygon,
  arbitrum,
  optimism,
  base,
  // avalanche intentionally omitted — no USDT on Avalanche in chains.ts
}

const getRpcUrl = (chainId: string): string | undefined => {
  const map: Partial<Record<string, string>> = {
    ethereum: env.ETHEREUM_RPC_URL,
    bsc:      env.BSC_RPC_URL,
    polygon:  env.POLYGON_RPC_URL,
    arbitrum: env.ARBITRUM_RPC_URL,
    optimism: env.OPTIMISM_RPC_URL,
    base:     env.BASE_RPC_URL,
  }
  return map[chainId]
}

interface AutoWithdrawal {
  id: string
  userId: string
  coin: string
  network: string
  amount: number | string
  toAddress: string
}

export async function sendWithdrawalOnChain(wd: AutoWithdrawal): Promise<void> {
  // Resolve chain config from network label (e.g. "BEP20" → bsc)
  const chainCfg = await getChainByNetworkLabel(wd.network)
  if (!chainCfg) {
    log.warn({ withdrawalId: wd.id, network: wd.network }, 'sendWithdrawalOnChain: unknown network')
    return
  }

  // Find the ERC20 contract address for the coin on this chain
  const tokenCfg = chainCfg.tokens.find(
    (t: { symbol: string; address: string | null }) => t.symbol.toUpperCase() === wd.coin.toUpperCase() && t.address,
  )
  if (!tokenCfg?.address) {
    log.warn({ withdrawalId: wd.id, coin: wd.coin, chainId: chainCfg.id }, 'sendWithdrawalOnChain: no ERC20 contract for coin')
    return
  }

  const viemChain = VIEM_CHAINS[chainCfg.id]
  const rpcUrl = getRpcUrl(chainCfg.id)
  if (!viemChain || !rpcUrl) {
    log.warn({ withdrawalId: wd.id, chainId: chainCfg.id }, 'sendWithdrawalOnChain: no viem chain config')
    return
  }

  // Check hot wallet seed is available (GAS_SEED_CIPHERTEXT env var)
  if (!env.GAS_SEED_CIPHERTEXT) {
    log.warn({ withdrawalId: wd.id }, 'sendWithdrawalOnChain: GAS_SEED_CIPHERTEXT not set, skipping auto-send')
    void createAdminNotif({
      category: 'SYSTEM',
      title:    'Auto-withdrawal skipped — hot wallet not configured',
      body:     `Withdrawal ${wd.id} (${wd.amount} ${wd.coin} on ${wd.network}) is auto-approved but GAS_SEED_CIPHERTEXT is not set. Send manually from your wallet, then open the withdrawal in the admin panel → Review → Mark Sent (Manual Fallback).`,
      href:     '/admin/withdrawals',
      metadata: { withdrawalId: wd.id },
    })
    return
  }

  let txHash: `0x${string}`
  const seed = decryptGasSeed()
  try {
    const privateKey = deriveEvmPrivateKeyHex(seed, HOT_WALLET_INDEX)
    const account = privateKeyToAccount(privateKey)
    const client = createWalletClient({ chain: viemChain, transport: http(rpcUrl), account })

    txHash = await client.writeContract({
      address: tokenCfg.address as `0x${string}`,
      abi: ERC20_TRANSFER_ABI,
      functionName: 'transfer',
      args: [wd.toAddress as `0x${string}`, parseUnits(String(wd.amount), tokenCfg.decimals)],
    })
  } catch (err) {
    seed.fill(0)
    const msg = err instanceof Error ? err.message : String(err)
    log.error({ err, withdrawalId: wd.id }, 'sendWithdrawalOnChain: on-chain send failed')
    void createAdminNotif({
      category: 'SYSTEM',
      title:    'Auto-withdrawal send FAILED — manual action required',
      body:     `Withdrawal ${wd.id} (${wd.amount} ${wd.coin} on ${wd.network}) failed to send automatically: ${msg}. Send manually from the hot wallet, then open the withdrawal → Review → Mark Sent (Manual Fallback). Or reject to refund the user.`,
      href:     '/admin/withdrawals',
      metadata: { withdrawalId: wd.id, error: msg },
    })
    return
  }
  seed.fill(0)

  // Update DB: withdrawal → sent, existing pending Transaction → completed
  try {
    const wallet = await db.wallet.findFirst({
      where: { userId: wd.userId, coin: wd.coin, network: wd.network },
      select: { id: true },
    })

    await db.$transaction(async (tx) => {
      const locked = await tx.withdrawal.updateMany({
        where: { id: wd.id, status: 'auto_approved' },
        data:  { status: 'sent', txHash, completedAt: new Date() },
      })
      if (locked.count === 0) return // already processed by admin concurrently

      if (wallet) {
        // Update the pending transaction record created at withdrawal creation time
        const pendingTx = await tx.transaction.findFirst({
          where: {
            walletId: wallet.id,
            type:     'withdrawal',
            status:   'pending',
            metadata: { path: ['withdrawalId'], equals: wd.id },
          },
        })
        if (pendingTx) {
          await tx.transaction.update({
            where: { id: pendingTx.id },
            data:  { status: 'completed', txHash },
          })
        }
      }
    })

    log.info({ withdrawalId: wd.id, txHash, coin: wd.coin, network: wd.network }, 'Auto-send withdrawal completed')
  } catch (err) {
    // On-chain tx is already broadcast — log the DB failure but don't throw
    log.error({ err, withdrawalId: wd.id, txHash }, 'sendWithdrawalOnChain: DB update failed after successful on-chain send')
    void createAdminNotif({
      category: 'SYSTEM',
      title:    'Auto-withdrawal sent on-chain but DB update failed',
      body:     `Withdrawal ${wd.id} txHash ${txHash} was broadcast but the DB could not be updated. Update the status manually.`,
      href:     '/admin/withdrawals',
      metadata: { withdrawalId: wd.id, txHash },
    })
  }
}
