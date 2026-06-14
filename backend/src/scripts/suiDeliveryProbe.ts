/**
 * SUI delivery probe — NON-DESTRUCTIVE diagnostic.
 *
 *   npm run gas:probe-sui
 *
 * Purpose: determine, on the real production host (where the gas seed env vars
 * exist), WHY SUI delivery fails with "have 0 / No valid gas coins" even though
 * the hot wallet holds SUI on mainnet. The funds were deposited via SUI's newer
 * `accumulator_settlement` (address-balance) model, and we need to know whether
 * the current SDK (@mysten/sui) + RPC node can actually source gas from that
 * balance.
 *
 * What it does (READ-ONLY — never broadcasts a transaction):
 *   1. Derives the SUI hot wallet address + keypair from the gas seed.
 *   2. Reports the RPC URL, SDK version, suix_getBalance, suix_getCoins, and
 *      suix_getOwnedObjects for the hot wallet.
 *   3. Builds the EXACT transaction deliverSui() builds
 *      (splitCoins(tx.gas, [tiny]) + transferObjects to SELF), then:
 *        a. tx.build({ client })  — this is where the SDK resolves/selects the
 *           gas payment coin. If accumulator funds aren't selectable, it throws
 *           "No valid gas coins found for the transaction" HERE.
 *        b. client.dryRunTransactionBlock(bytes) — simulates execution without
 *           broadcasting. Confirms a real send would succeed.
 *
 * It sends to the hot wallet's OWN address and a 1000-MIST (0.000001 SUI) amount,
 * so even in the impossible event of a broadcast it is harmless. It does NOT call
 * signAndExecuteTransaction.
 */

import 'dotenv/config'
import { env } from '../lib/env'
import { gasWalletIsConfigured, decryptGasSeed } from '../lib/gas/gasWalletService'
import { getSuiHotWalletAddress, deriveSuiPrivateKeyForDelivery } from '../lib/gas/suiWalletService'

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m',
}

function line(label: string, value: string) {
  console.log(`  ${C.dim}${label.padEnd(22)}${C.reset} ${value}`)
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(env.SUI_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const data = await res.json() as { result?: unknown; error?: { message: string } }
  if (data.error) throw new Error(`${method}: ${data.error.message}`)
  return data.result
}

async function main() {
  console.log(`\n${C.bold}${C.cyan}SUI Delivery Probe${C.reset}  ${C.dim}(read-only — never broadcasts)${C.reset}\n`)

  if (!gasWalletIsConfigured()) {
    console.log(`${C.red}Gas wallet not configured (GAS_MASTER_KEY / GAS_SEED_CIPHERTEXT missing).${C.reset}`)
    console.log(`${C.yellow}Run this on the production host (Railway), where the seed env vars exist.${C.reset}\n`)
    process.exit(1)
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdkVersion = require('@mysten/sui/package.json').version as string
  const { SuiClient } = await import('@mysten/sui/client')
  const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519')
  const { Transaction } = await import('@mysten/sui/transactions')

  const address = getSuiHotWalletAddress()
  console.log(`${C.bold}Environment${C.reset}`)
  line('@mysten/sui', sdkVersion)
  line('SUI_RPC_URL', env.SUI_RPC_URL)
  line('Hot wallet', address ?? '(null)')
  console.log('')

  if (!address) { console.log(`${C.red}Could not derive hot wallet address.${C.reset}`); process.exit(1) }

  const client = new SuiClient({ url: env.SUI_RPC_URL })

  // ── On-chain visibility ──────────────────────────────────────────────────
  console.log(`${C.bold}On-chain visibility (via configured RPC)${C.reset}`)
  try {
    const bal = await rpc('suix_getBalance', [address, '0x2::sui::SUI']) as {
      totalBalance?: string; coinObjectCount?: number; fundsInAddressBalance?: string
    }
    line('getBalance.total', `${bal.totalBalance ?? '?'} MIST`)
    line('coinObjectCount', String(bal.coinObjectCount ?? '?'))
    line('fundsInAddressBalance', `${bal.fundsInAddressBalance ?? '(not reported by node)'}`)
  } catch (e) { line('getBalance', `${C.red}ERROR: ${(e as Error).message}${C.reset}`) }

  try {
    const coins = await client.getCoins({ owner: address, coinType: '0x2::sui::SUI' })
    line('getCoins count', String(coins.data.length))
    coins.data.slice(0, 3).forEach((c, i) => line(`  coin[${i}]`, `${c.coinObjectId.slice(0, 12)}… bal=${c.balance}`))
  } catch (e) { line('getCoins', `${C.red}ERROR: ${(e as Error).message}${C.reset}`) }

  try {
    const owned = await client.getOwnedObjects({ owner: address })
    line('getOwnedObjects', `${owned.data.length} object(s)`)
  } catch (e) { line('getOwnedObjects', `${C.red}ERROR: ${(e as Error).message}${C.reset}`) }
  console.log('')

  // ── Build the exact delivery tx and resolve gas (no broadcast) ───────────
  console.log(`${C.bold}Delivery simulation (build + dryRun, NO broadcast)${C.reset}`)
  const seed = decryptGasSeed()
  let privateKeySeed: Buffer | null = null
  try {
    privateKeySeed = deriveSuiPrivateKeyForDelivery(seed)
    const keypair = Ed25519Keypair.fromSecretKey(new Uint8Array(privateKeySeed))
    const signerAddr = keypair.getPublicKey().toSuiAddress()
    line('keypair address', signerAddr === address ? `${C.green}matches hot wallet${C.reset}` : `${C.red}MISMATCH: ${signerAddr}${C.reset}`)

    const tinyMist = BigInt(1000) // 0.000001 SUI, sent to self
    const tx = new Transaction()
    const [coin] = tx.splitCoins(tx.gas, [tinyMist])
    tx.transferObjects([coin], address) // to SELF — harmless even if it ever broadcast
    tx.setSender(address)

    let built: Uint8Array | null = null
    try {
      built = await tx.build({ client })
      line('tx.build (gas select)', `${C.green}OK — SDK selected a gas coin from this balance${C.reset}`)
    } catch (e) {
      line('tx.build (gas select)', `${C.red}FAILED${C.reset}`)
      console.log(`  ${C.red}${(e as Error).message}${C.reset}`)
      console.log(`\n${C.yellow}${C.bold}VERDICT:${C.reset} ${C.yellow}The SDK cannot source gas from this balance at v${sdkVersion}.`)
      console.log(`The 2 SUI is held in the address-balance accumulator and is NOT a`)
      console.log(`selectable owned Coin object. Delivery needs an SDK upgrade + an`)
      console.log(`address-balance gas/withdraw path, or the funds converted to a Coin.${C.reset}\n`)
      return
    }

    try {
      const dr = await client.dryRunTransactionBlock({ transactionBlock: built })
      const status = dr.effects.status.status
      line('dryRun status', status === 'success' ? `${C.green}success${C.reset}` : `${C.red}${status}${C.reset}`)
      if (dr.effects.status.error) line('dryRun error', `${C.red}${dr.effects.status.error}${C.reset}`)
      const gasUsed = dr.effects.gasUsed
      line('dryRun gasUsed', `comp=${gasUsed.computationCost} storage=${gasUsed.storageCost} rebate=${gasUsed.storageRebate}`)
      console.log('')
      if (status === 'success') {
        console.log(`${C.green}${C.bold}VERDICT:${C.reset} ${C.green}Delivery WOULD succeed. Gas is selectable and the tx`)
        console.log(`simulates cleanly. The live failure is the RPC node not reporting the`)
        console.log(`balance — point SUI_RPC_URL at this node and retries will deliver.${C.reset}\n`)
      } else {
        console.log(`${C.yellow}${C.bold}VERDICT:${C.reset} ${C.yellow}Gas selected but execution would fail (see dryRun error above).${C.reset}\n`)
      }
    } catch (e) {
      line('dryRun', `${C.red}ERROR: ${(e as Error).message}${C.reset}`)
      console.log(`\n${C.yellow}${C.bold}VERDICT:${C.reset} ${C.yellow}Gas selection succeeded but dryRun call failed — see error.${C.reset}\n`)
    }
  } finally {
    seed.fill(0)
    if (privateKeySeed) privateKeySeed.fill(0)
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(`\n${C.red}Probe crashed:${C.reset}`, e)
  process.exit(1)
})
