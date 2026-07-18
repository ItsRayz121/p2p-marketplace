/**
 * Rescan an EVM transaction for missed user deposits and run it through the
 * standard detection + credit pipeline (processDepositEvent).
 *
 * Use when a Moralis Streams webhook was missed (stream paused, delivery
 * dropped, signature drift) and a user's on-chain deposit never showed up.
 * Reads the tx receipt via the chain's RPC, extracts every ERC20 Transfer and
 * the native value transfer, and feeds each through the same idempotent
 * pipeline a real webhook would — the unique (txHash, chain, asset) key makes
 * repeated runs no-ops.
 *
 * Usage:
 *   npm run deposits:rescan -- <chain> <txHash>
 *   e.g. npm run deposits:rescan -- bsc 0x7720a9e8cd28e6324fa24d3bb54137309d998255159b6a764db344b569fc5c7f
 */
import { db } from '../lib/prisma'
import { getAllChains, getRpcUrl } from '../services/chainRegistry.service'
import { getBlockNumber, getTransactionReceiptWithLogs, getTransactionByHash } from '../lib/evmRpc'
import { processDepositEvent, type NormalizedDepositEvent } from '../services/depositWatcher.service'

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

async function main() {
  const [chainSlug, txHash] = process.argv.slice(2)
  if (!chainSlug || !txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    console.error('Usage: npm run deposits:rescan -- <chain> <txHash>')
    process.exit(1)
  }

  const chain = (await getAllChains()).find((c) => c.id === chainSlug)
  if (!chain || chain.chainId == null || chain.family !== 'EVM') {
    console.error(`Chain ${chainSlug} is not a configured EVM chain`)
    process.exit(1)
  }
  const rpcUrl = getRpcUrl(chain.id)
  if (!rpcUrl) {
    console.error(`No RPC URL configured for ${chain.id}`)
    process.exit(1)
  }

  const [currentBlock, receipt, tx] = await Promise.all([
    getBlockNumber(rpcUrl, chain.id),
    getTransactionReceiptWithLogs(rpcUrl, chain.id, txHash),
    getTransactionByHash(rpcUrl, chain.id, txHash),
  ])
  if (!receipt) {
    console.error('Transaction receipt not found — tx unmined or wrong chain')
    process.exit(1)
  }
  if (receipt.status === '0x0') {
    console.error('Transaction reverted on-chain — nothing to credit')
    process.exit(1)
  }
  const confirmations = currentBlock >= receipt.blockNumber
    ? Number(currentBlock - receipt.blockNumber + 1n)
    : 0
  console.log(`Receipt OK — block ${receipt.blockNumber}, ${confirmations} confirmations`)

  const events: NormalizedDepositEvent[] = []

  // Native value transfer (if any).
  if (tx && tx.value > 0n && tx.to) {
    events.push({
      chainId: chain.chainId,
      txHash,
      fromAddress: tx.from,
      toAddress: tx.to,
      asset: 'native',
      symbol: chain.nativeSymbol,
      amount: tx.value.toString(),
      confirmations,
    })
  }

  // Every ERC20 Transfer in the receipt logs (any contract — the pipeline's
  // whitelist decides what is creditable).
  for (const log of receipt.logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length < 3) continue
    const from = '0x' + (log.topics[1] ?? '').slice(-40)
    const to = '0x' + (log.topics[2] ?? '').slice(-40)
    let value: bigint
    try {
      value = log.data === '0x' || log.data === '' ? 0n : BigInt(log.data)
    } catch { continue }
    if (value === 0n) continue
    events.push({
      chainId: chain.chainId,
      txHash,
      fromAddress: from,
      toAddress: to,
      asset: log.address,
      symbol: '',
      amount: value.toString(),
      confirmations,
    })
  }

  if (events.length === 0) {
    console.log('No native value and no ERC20 Transfer logs found in this tx.')
    process.exit(0)
  }

  for (const event of events) {
    const result = await processDepositEvent(event)
    console.log(
      `[${event.asset === 'native' ? chain.nativeSymbol : event.asset}] → ${event.toAddress}: ` +
      JSON.stringify(result),
    )
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => db.$disconnect())
