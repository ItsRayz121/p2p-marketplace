/**
 * Aptos USDT refund — sender lookup + fungible-asset transfer from the gas hot
 * wallet back to the original payer.
 *
 * USDT on Aptos is the native Tether fungible asset (6 decimals). Inbound
 * payments are detected by the poller (gasPaymentPoller.scanAptos) which stores
 * a SYNTHETIC paymentTxHash of the form `aptos:{transaction_version}:{event_index}`
 * and does NOT capture the sender. So a refund must:
 *   1. Parse the transaction_version out of the synthetic hash.
 *   2. Query the indexer for the WITHDRAW side of that tx → the payer's address.
 *   3. Sign + submit a primary_fungible_store::transfer of the same USDT amount.
 *
 * Security: the hot wallet private key is derived on demand, used to sign, and
 * the seed/key Buffers are zeroed immediately after.
 */

import type { Decimal } from '@prisma/client/runtime/library'
import { env } from '../env'
import { db } from '../prisma'
import { logger } from '../logger'
import { decryptGasSeed } from './gasWalletService'
import {
  deriveAptosPrivateKeyForDelivery,
  validateAptosAddress,
} from './aptosWalletService'

// Native USDT on Aptos (Tether) — fungible-asset metadata address, 6 decimals.
// Mirrors gasPaymentPoller; overridable via PlatformConfig 'gas_usdt_aptos_asset'.
const USDT_APTOS_ASSET_DEFAULT = '0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b'
const USDT_APTOS_DECIMALS = 6

/** Resolve the USDT fungible-asset metadata address (config override → default). */
export async function getAptosUsdtAsset(): Promise<string> {
  const cfg = await db.platformConfig.findUnique({ where: { key: 'gas_usdt_aptos_asset' } })
  return cfg?.value || USDT_APTOS_ASSET_DEFAULT
}

/**
 * Fetch the Aptos hot wallet's native APT balance (in APT, not octas). Aptos
 * charges tx gas in APT, so this must stay funded or USDT refunds will fail.
 * Returns 0 for an unfunded/non-existent account.
 */
export async function getAptosNativeBalance(address: string): Promise<number> {
  const { Aptos, AptosConfig } = await import('@aptos-labs/ts-sdk')
  const config = new AptosConfig({
    fullnode: env.APTOS_FULLNODE_URL,
    indexer: env.APTOS_INDEXER_URL,
    ...(env.APTOS_API_KEY ? { clientConfig: { API_KEY: env.APTOS_API_KEY } } : {}),
  })
  const aptos = new Aptos(config)
  try {
    const octas = await aptos.getAccountAPTAmount({ accountAddress: address })
    return Number(octas) / 1e8 // octas → APT
  } catch {
    return 0 // account never funded → no APT
  }
}

/** Extract the Aptos transaction_version from a synthetic `aptos:{ver}:{idx}` hash. */
function parseAptosVersion(txHash: string): string | null {
  const m = /^aptos:(\d+):/.exec(txHash)
  return m ? m[1]! : null
}

/**
 * Resolve the payer's address for an Aptos USDT payment, from the indexer.
 * Looks up the WITHDRAW activity of the payment's transaction_version.
 * Returns null if it can't be resolved (caller retries / alerts).
 */
export async function getAptosSenderFromTx(txHash: string): Promise<string | null> {
  const version = parseAptosVersion(txHash)
  if (!version) return null

  const asset = await getAptosUsdtAsset()
  const query = `
    query GasAptosWithdraw($version: bigint!, $asset: String!) {
      fungible_asset_activities(
        where: {
          transaction_version: { _eq: $version },
          asset_type: { _eq: $asset },
          type: { _ilike: "%Withdraw%" }
        },
        order_by: { event_index: asc },
        limit: 1
      ) {
        owner_address
      }
    }`

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (env.APTOS_API_KEY) headers['authorization'] = `Bearer ${env.APTOS_API_KEY}`

  try {
    const res = await fetch(env.APTOS_INDEXER_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables: { version, asset } }),
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as {
      data?: { fungible_asset_activities?: Array<{ owner_address?: string }> }
      errors?: unknown
    }
    if (json.errors) return null
    const owner = json.data?.fungible_asset_activities?.[0]?.owner_address
    return owner && validateAptosAddress(owner) ? owner : null
  } catch {
    return null
  }
}

/**
 * Send a USDT refund on Aptos from the gas hot wallet to `toAddress`.
 * Returns the on-chain transaction hash. Throws on any failure.
 */
export async function sendAptosUsdtRefund(toAddress: string, amountUsdt: Decimal): Promise<string> {
  if (!validateAptosAddress(toAddress)) {
    throw new Error(`sendAptosUsdtRefund: invalid Aptos address ${toAddress}`)
  }

  const { Aptos, AptosConfig, Account, Ed25519PrivateKey } = await import('@aptos-labs/ts-sdk')

  const assetAddr = await getAptosUsdtAsset()
  // Integer base units (6 decimals). toFixed avoids float drift on the cents.
  const amount = BigInt(Math.round(Number(Number(amountUsdt).toFixed(USDT_APTOS_DECIMALS)) * 10 ** USDT_APTOS_DECIMALS))
  if (amount <= 0n) throw new Error(`sendAptosUsdtRefund: non-positive amount for ${amountUsdt} USDT`)

  const config = new AptosConfig({
    fullnode: env.APTOS_FULLNODE_URL,
    indexer: env.APTOS_INDEXER_URL,
    ...(env.APTOS_API_KEY ? { clientConfig: { API_KEY: env.APTOS_API_KEY } } : {}),
  })
  const aptos = new Aptos(config)

  const seed = decryptGasSeed()
  let privKey: Buffer | null = null
  try {
    privKey = deriveAptosPrivateKeyForDelivery(seed)
    const account = Account.fromPrivateKey({
      privateKey: new Ed25519PrivateKey(new Uint8Array(privKey)),
    })

    const txn = await aptos.transaction.build.simple({
      sender: account.accountAddress,
      data: {
        function: '0x1::primary_fungible_store::transfer',
        typeArguments: ['0x1::fungible_asset::Metadata'],
        functionArguments: [assetAddr, toAddress, amount],
      },
    })

    const pending = await aptos.signAndSubmitTransaction({ signer: account, transaction: txn })
    await aptos.waitForTransaction({ transactionHash: pending.hash })

    logger.info({ toAddress, amount: amount.toString(), txHash: pending.hash }, 'Aptos USDT refund submitted')
    return pending.hash
  } finally {
    seed.fill(0)
    if (privKey) privKey.fill(0)
  }
}
