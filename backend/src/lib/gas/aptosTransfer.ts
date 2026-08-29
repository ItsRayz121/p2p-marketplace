/**
 * Low-level Aptos fungible-asset transfer + transaction-outcome lookup.
 *
 * Single source of truth for "sign a USDT transfer from the gas hot wallet and
 * submit it". Previously this SDK dance was copy-pasted in aptosRefund.ts and
 * gas.delivery.ts; the user-withdrawal sender now needs it too, so it lives here.
 *
 * USDT on Aptos is the native Tether fungible asset (6 decimals). The hot wallet
 * is the SAME Ed25519 account used for gas delivery + refunds (SLIP-0010 path
 * m/44'/637'/0'/0'/0'), so every outbound send from it MUST be serialized through
 * withHotWalletLock('aptos') by the CALLER to avoid sequence-number collisions.
 *
 * Security: the seed + derived private key Buffers are zeroed in a finally block.
 */

import { env } from '../env'
import { logger } from '../logger'
import { decryptGasSeed } from './gasWalletService'
import { deriveAptosPrivateKeyForDelivery, validateAptosAddress } from './aptosWalletService'

export const USDT_APTOS_DECIMALS = 6

/** Build an AptosConfig from env (fullnode + indexer + optional API key). */
async function makeAptos() {
  const { Aptos, AptosConfig } = await import('@aptos-labs/ts-sdk')
  const config = new AptosConfig({
    fullnode: env.APTOS_FULLNODE_URL,
    indexer: env.APTOS_INDEXER_URL,
    ...(env.APTOS_API_KEY ? { clientConfig: { API_KEY: env.APTOS_API_KEY } } : {}),
  })
  return new Aptos(config)
}

/**
 * Convert a human-decimal USDT amount to integer base units (6 dp). `toFixed`
 * first so IEEE-754 drift on the cents can't leak into the BigInt.
 */
export function usdtToAptosBaseUnits(amountUsdt: number | string): bigint {
  const n = Number(Number(amountUsdt).toFixed(USDT_APTOS_DECIMALS))
  return BigInt(Math.round(n * 10 ** USDT_APTOS_DECIMALS))
}

/**
 * Sign + submit a USDT (fungible-asset) transfer from the gas hot wallet and
 * wait for the network to commit it. Returns the on-chain transaction hash.
 * Throws on any failure (invalid address, non-positive amount, submit/commit
 * error). The CALLER must hold withHotWalletLock('aptos').
 */
export async function sendAptosFungibleAsset(params: {
  toAddress: string
  baseUnits: bigint
  assetAddr: string
}): Promise<string> {
  const { toAddress, baseUnits, assetAddr } = params
  if (!validateAptosAddress(toAddress)) {
    throw new Error(`sendAptosFungibleAsset: invalid Aptos address ${toAddress}`)
  }
  if (baseUnits <= 0n) {
    throw new Error(`sendAptosFungibleAsset: non-positive amount ${baseUnits}`)
  }

  const { Account, Ed25519PrivateKey } = await import('@aptos-labs/ts-sdk')
  const aptos = await makeAptos()

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
        functionArguments: [assetAddr, toAddress, baseUnits],
      },
    })

    const pending = await aptos.signAndSubmitTransaction({ signer: account, transaction: txn })
    await aptos.waitForTransaction({ transactionHash: pending.hash })

    logger.info(
      { toAddress, baseUnits: baseUnits.toString(), txHash: pending.hash },
      'sendAptosFungibleAsset: submitted',
    )
    return pending.hash
  } finally {
    seed.fill(0)
    if (privKey) privKey.fill(0)
  }
}

export type AptosTxOutcome = 'pending' | 'success' | 'failed'

/**
 * Look up whether an Aptos transaction has committed and, if so, whether it
 * succeeded. Returns 'pending' when the tx is not yet on-chain (or the node
 * has no record of it yet) — callers age-gate that case themselves.
 */
export async function getAptosTxOutcome(txHash: string): Promise<AptosTxOutcome> {
  const aptos = await makeAptos()
  try {
    const tx = (await aptos.getTransactionByHash({ transactionHash: txHash })) as {
      type?: string
      success?: boolean
    }
    // Pending txs come back as 'pending_transaction' with no `success` field.
    if (tx.type === 'pending_transaction' || typeof tx.success !== 'boolean') return 'pending'
    return tx.success ? 'success' : 'failed'
  } catch {
    // 404 / not-found-yet → still pending from our POV.
    return 'pending'
  }
}
