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
import { createHash } from 'crypto'
import { env } from '../lib/env'
import { gasWalletIsConfigured, decryptGasSeed } from '../lib/gas/gasWalletService'
import { getSuiHotWalletAddress, deriveSuiPrivateKeyForDelivery } from '../lib/gas/suiWalletService'
import { deriveSlip10Ed25519, ed25519PublicKeyFromSeed } from '../lib/gas/nonEvmDerivation'

const SUI_SLIP10_PATH = "m/44'/784'/0'/0'/0'"
// The address shown as "From Wallet" in admin / where the user deposited 2 SUI.
const FUNDED_ADDR = '0x1990cc54460686e360376426876377b3b17ea3212aaefa6b5481a1a601992e2f'

/** Legacy sha3-256 address formula: 0x + hex(sha3_256(0x00 || pubkey))[0:64]. */
function legacySha3Address(pubkey: Buffer): string {
  const h = createHash('sha3-256').update(Buffer.concat([Buffer.from([0x00]), pubkey])).digest('hex')
  return `0x${h.slice(0, 64)}`
}

async function suiBalance(addr: string): Promise<string> {
  const res = await fetch(env.SUI_RPC_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'suix_getBalance', params: [addr, '0x2::sui::SUI'] }),
  })
  const data = await res.json() as { result?: { totalBalance?: string } }
  return data.result?.totalBalance ?? '0'
}

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

  // Resolve the installed @mysten/sui version without touching its (blocked)
  // ./package.json export — walk up from a real export entry and read the file.
  let sdkVersion = 'unknown'
  try {
    const { readFileSync } = await import('fs')
    const entry = require.resolve('@mysten/sui/client')
    const m = entry.match(/^(.*[\\/]@mysten[\\/]sui)[\\/]/)
    if (m) sdkVersion = JSON.parse(readFileSync(`${m[1]}/package.json`, 'utf8')).version
  } catch { /* version is informational only */ }
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

  // ── Legacy (sha3) address comparison — where did the 2 SUI go? ────────────
  console.log(`${C.bold}Address derivation comparison${C.reset}`)
  let legacyAddr: string | null = null
  let legacyBal = '0'
  let liveBal = '0'
  {
    const seed0 = decryptGasSeed()
    try {
      const { privateKey } = deriveSlip10Ed25519(seed0, SUI_SLIP10_PATH)
      try {
        const pubkey = ed25519PublicKeyFromSeed(privateKey)
        line('ed25519 pubkey', `0x${pubkey.toString('hex')}`)
        legacyAddr = legacySha3Address(pubkey)
      } finally { privateKey.fill(0) }
    } finally { seed0.fill(0) }
  }
  liveBal = await suiBalance(address)
  line('CURRENT (blake2b)', `${address}`)
  line('  balance', `${liveBal} MIST ${liveBal === '0' ? C.red + '(EMPTY)' + C.reset : C.green + '(funded)' + C.reset}`)
  if (legacyAddr) {
    legacyBal = await suiBalance(legacyAddr)
    const isFundedAddr = legacyAddr.toLowerCase() === FUNDED_ADDR.toLowerCase()
    line('LEGACY (sha3)', `${legacyAddr} ${isFundedAddr ? C.yellow + '← matches the funded address' + C.reset : ''}`)
    line('  balance', `${legacyBal} MIST ${legacyBal !== '0' ? C.yellow + '(holds funds — NOT spendable by this keypair)' + C.reset : '(empty)'}`)
  }
  line('Funded addr (admin)', FUNDED_ADDR)
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
      console.log('')
      // Data-driven verdict: distinguish "wallet empty" from "SDK can't spend".
      if (liveBal === '0' && legacyBal !== '0') {
        console.log(`${C.yellow}${C.bold}VERDICT:${C.reset} ${C.yellow}Wrong address funded.`)
        console.log(`The live delivery wallet (blake2b) is EMPTY. The ${legacyBal} MIST you`)
        console.log(`funded sits on the LEGACY sha3 address, which this keypair cannot sign`)
        console.log(`for (SUI derives the sender from blake2b(pubkey), not sha3).`)
        console.log(`FIX: fund the CURRENT address  ${address}`)
        console.log(`Those legacy funds are not spendable by the gas keypair.${C.reset}\n`)
      } else if (liveBal === '0') {
        console.log(`${C.yellow}${C.bold}VERDICT:${C.reset} ${C.yellow}The live delivery wallet is simply EMPTY.`)
        console.log(`FIX: fund  ${address}  with SUI and delivery will proceed.${C.reset}\n`)
      } else {
        console.log(`${C.yellow}${C.bold}VERDICT:${C.reset} ${C.yellow}Wallet holds ${liveBal} MIST but the SDK could not`)
        console.log(`select a gas coin at v${sdkVersion} — funds may be in the address-balance`)
        console.log(`accumulator (not a selectable Coin object). Needs SDK upgrade / withdraw path.${C.reset}\n`)
      }
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
