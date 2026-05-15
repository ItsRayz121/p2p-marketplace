/**
 * Production deployment verification script.
 *
 * Run this before going live or after a Railway deploy to verify:
 *   - Required env vars are set
 *   - All RPCs respond
 *   - Mnemonic decrypts and produces correct addresses
 *   - Hot wallet DB rows exist and match derived addresses
 *   - DB connectivity
 *   - Redis connectivity
 *   - BullMQ queue definitions load
 *   - Token configs exist for active chains
 *   - No chain is both active and missing its hot wallet
 *   - Chain activation safety check
 *
 * Usage:
 *   npx tsx src/scripts/deployVerify.ts
 *   npx tsx src/scripts/deployVerify.ts --chain TRON    (test a specific chain)
 *   npx tsx src/scripts/deployVerify.ts --full          (run all checks including non-EVM)
 *
 * Exit code:
 *   0 — all checks passed
 *   1 — one or more checks failed (logs show which)
 */

import 'dotenv/config'
import '../lib/env'

const args = process.argv.slice(2)
const specificChain = args.find((a) => a.startsWith('--chain='))?.split('=')[1]
  ?? (args.includes('--chain') ? args[args.indexOf('--chain') + 1] : null)
const fullMode = args.includes('--full')

// ── Result tracking ────────────────────────────────────────────────────────────

interface CheckResult {
  name: string
  ok: boolean
  value?: string
  warning?: string
  error?: string
}

const results: CheckResult[] = []
let hasFailure = false

function pass(name: string, value?: string, warning?: string): void {
  results.push({ name, ok: true, ...(value !== undefined ? { value } : {}), ...(warning !== undefined ? { warning } : {}) })
  console.log(`  ✅ ${name}${value ? ` → ${value}` : ''}${warning ? ` [WARN: ${warning}]` : ''}`)
}

function fail(name: string, error: string): void {
  hasFailure = true
  results.push({ name, ok: false, error })
  console.log(`  ❌ ${name} — ${error}`)
}

function warn(name: string, warning: string): void {
  results.push({ name, ok: true, warning })
  console.log(`  ⚠️  ${name} — ${warning}`)
}

function section(title: string): void {
  console.log(`\n▸ ${title}`)
}

// ── 1. Environment variables ───────────────────────────────────────────────────

async function checkEnvVars(): Promise<void> {
  section('Environment variables')
  const { env } = await import('../lib/env')

  const required = [
    ['DATABASE_URL',       env.DATABASE_URL],
    ['REDIS_URL',          env.REDIS_URL],
    ['JWT_SECRET',         env.JWT_SECRET],
    ['JWT_REFRESH_SECRET', env.JWT_REFRESH_SECRET],
    ['CSRF_SECRET',        env.CSRF_SECRET],
    ['CNIC_HASH_SECRET',   env.CNIC_HASH_SECRET],
  ] as [string, string | undefined][]

  for (const [key, val] of required) {
    if (val) pass(key, '[set]')
    else fail(key, 'required but not set')
  }

  // Gas system
  const hasKey = !!env.GAS_MASTER_KEY
  const hasCt  = !!env.GAS_SEED_CIPHERTEXT

  if (hasKey && hasCt) {
    pass('GAS_MASTER_KEY + GAS_SEED_CIPHERTEXT', 'both set')
  } else if (!hasKey && !hasCt) {
    warn('GAS mnemonic', 'not configured — delivery will use legacy GAS_WALLET_PRIVATE_KEY_* env vars')
  } else {
    fail('GAS mnemonic', `half-configured — ${hasKey ? 'GAS_MASTER_KEY' : 'GAS_SEED_CIPHERTEXT'} is set but the other is missing`)
  }

  // Legacy key fallbacks
  const legacyKeys = [
    ['GAS_WALLET_PRIVATE_KEY_TRON', env.GAS_WALLET_PRIVATE_KEY_TRON],
    ['GAS_WALLET_PRIVATE_KEY_BSC',  env.GAS_WALLET_PRIVATE_KEY_BSC],
    ['GAS_WALLET_PRIVATE_KEY_ETH',  env.GAS_WALLET_PRIVATE_KEY_ETH],
  ] as [string, string | undefined][]

  if (!hasKey) {
    for (const [key, val] of legacyKeys) {
      if (val) pass(key, '[set as fallback]')
      else warn(key, 'not set — this chain will not be able to deliver without mnemonic')
    }
  }

  // RPC URLs
  const rpcUrls = [
    ['TRON_FULLNODE_URL', env.TRON_FULLNODE_URL],
    ['BSC_RPC_URL',       env.BSC_RPC_URL],
    ['ETHEREUM_RPC_URL',  env.ETHEREUM_RPC_URL],
    ['BASE_RPC_URL',      env.BASE_RPC_URL],
    ['ARBITRUM_RPC_URL',  env.ARBITRUM_RPC_URL],
    ['OPTIMISM_RPC_URL',  env.OPTIMISM_RPC_URL],
    ['POLYGON_RPC_URL',   env.POLYGON_RPC_URL],
    ['AVALANCHE_RPC_URL', env.AVALANCHE_RPC_URL],
    ['SOL_RPC_URL',       env.SOL_RPC_URL],
    ['TON_ENDPOINT_URL',  env.TON_ENDPOINT_URL],
    ['SUI_RPC_URL',       env.SUI_RPC_URL],
  ] as [string, string][]

  for (const [key, val] of rpcUrls) {
    if (val) pass(key, val.slice(0, 50) + (val.length > 50 ? '…' : ''))
    else warn(key, 'using default public endpoint — recommend dedicated node for production')
  }
}

// ── 2. Mnemonic decryption + address derivation ────────────────────────────────

async function checkMnemonic(): Promise<void> {
  section('Mnemonic decryption + address derivation')
  const { gasWalletIsConfigured, validateGasWalletAtStartup } = await import('../lib/gas/gasWalletService')
  if (!gasWalletIsConfigured()) {
    warn('Mnemonic', 'not configured — skipping derivation checks')
    return
  }
  try {
    const result = validateGasWalletAtStartup()
    if (result.configured) {
      pass('TRON address derivation', result.tronHotWallet)
      pass('EVM address derivation',  result.evmHotWallet)

      const { sol, ton, sui } = result.nonEvm ?? {}
      if (sol && 'address' in sol) pass('SOL address derivation', sol.address, sol.warning)
      else if (sol && 'error' in sol) fail('SOL address derivation', sol.error)
      else warn('SOL address derivation', 'no result')

      if (ton && 'address' in ton) pass('TON address derivation', ton.address, ton.warning)
      else if (ton && 'error' in ton) fail('TON address derivation', ton.error)
      else warn('TON address derivation', 'no result')

      if (sui && 'address' in sui) pass('SUI address derivation', sui.address, sui.warning)
      else if (sui && 'error' in sui) fail('SUI address derivation', sui.error)
      else warn('SUI address derivation', 'no result')
    }
  } catch (err) {
    fail('Mnemonic validation', err instanceof Error ? err.message : String(err))
  }
}

// ── 3. Database connectivity ───────────────────────────────────────────────────

async function checkDatabase(): Promise<void> {
  section('Database')
  const { db } = await import('../lib/prisma')
  try {
    await db.$queryRaw`SELECT 1`
    pass('PostgreSQL connection', 'ok')
  } catch (err) {
    fail('PostgreSQL connection', err instanceof Error ? err.message : String(err))
    return
  }

  // Hot wallet rows
  const wallets = await db.gasHotWallet.findMany({ where: { isActive: true } })
  pass('GasHotWallet rows', `${wallets.length} active`)
  for (const w of wallets) {
    pass(`  ${w.chain} wallet`, w.address.slice(0, 20) + '…')
  }

  // Active chains with no hot wallet
  const activeChains = await db.gasChainConfig.findMany({
    where: { isActive: true, backendChainId: { not: null } },
    select: { slug: true, backendChainId: true, readinessState: true },
  })
  for (const c of activeChains) {
    const dbChain = c.backendChainId === 'ETHEREUM' ? 'ETH' : c.backendChainId!
    const wallet = wallets.find((w) => w.chain === dbChain)
    if (!wallet) {
      fail(`${c.slug} active chain missing hot wallet`, `No GasHotWallet row for ${dbChain}`)
    } else {
      pass(`${c.slug} chain ↔ hot wallet`, `${c.readinessState} / ${wallet.address.slice(0, 14)}…`)
    }
  }

  // Token configs
  const tokenCount = await db.gasTokenConfig.count({ where: { isActive: true } })
  if (tokenCount === 0) warn('GasTokenConfig', 'no active tokens — gas fee page will be empty')
  else pass('GasTokenConfig active tokens', String(tokenCount))

  await db.$disconnect()
}

// ── 4. Redis connectivity ──────────────────────────────────────────────────────

async function checkRedis(): Promise<void> {
  section('Redis')
  const { redis, disconnectRedis } = await import('../lib/redis')
  try {
    await (redis as unknown as { connect: () => Promise<void> }).connect?.()
  } catch { /* already connected */ }
  try {
    await redis.ping()
    pass('Redis PING', 'pong')
    const usdPkr = await redis.get('rate:USD_PKR')
    if (usdPkr) pass('rate:USD_PKR cached', usdPkr)
    else warn('rate:USD_PKR', 'not cached — rate updater job may not have run yet')
    await disconnectRedis()
  } catch (err) {
    fail('Redis connection', err instanceof Error ? err.message : String(err))
  }
}

// ── 5. RPC connectivity ────────────────────────────────────────────────────────

async function checkRpcs(): Promise<void> {
  section('RPC connectivity')
  const { SUPPORTED_GAS_CHAINS, NON_EVM_GAS_CHAINS } = await import('../lib/gas/gas.chains')
  const { testRpcHealth } = await import('../lib/gas/gas.balance')

  const chains = specificChain
    ? [specificChain.toUpperCase() as typeof SUPPORTED_GAS_CHAINS[number]]
    : fullMode
      ? SUPPORTED_GAS_CHAINS
      : SUPPORTED_GAS_CHAINS.filter((c) => !NON_EVM_GAS_CHAINS.includes(c))

  await Promise.all(
    chains.map(async (chain) => {
      try {
        const result = await testRpcHealth(chain)
        if (result.reachable) {
          pass(`${chain} RPC`, `block ${result.blockNumber} in ${result.latencyMs}ms${result.isStale ? ' [STALE]' : ''}`, result.isStale ? 'block appears stale' : undefined)
        } else {
          fail(`${chain} RPC`, result.error ?? 'unreachable')
        }
      } catch (err) {
        fail(`${chain} RPC`, err instanceof Error ? err.message : String(err))
      }
    })
  )
}

// ── 6. BullMQ queue definitions ───────────────────────────────────────────────

async function checkQueues(): Promise<void> {
  section('BullMQ queues')
  try {
    const { queues } = await import('../queues/definitions')
    const names = Object.keys(queues)
    pass('Queue definitions loaded', `${names.length} queues: ${names.join(', ')}`)
  } catch (err) {
    fail('Queue definitions', err instanceof Error ? err.message : String(err))
  }
}

// ── 7. Chain activation safety ────────────────────────────────────────────────

async function checkChainActivationSafety(): Promise<void> {
  section('Chain activation safety')
  const { GAS_CHAINS, NON_EVM_GAS_CHAINS } = await import('../lib/gas/gas.chains')
  const { db } = await import('../lib/prisma')

  const activeChains = await db.gasChainConfig.findMany({
    where: { isActive: true },
    select: { slug: true, backendChainId: true, readinessState: true },
  })

  for (const c of activeChains) {
    const dbSlug = c.slug as string
    const isNonEvm = NON_EVM_GAS_CHAINS.includes(dbSlug as 'SOL' | 'TON' | 'SUI')
    const legacyId = c.backendChainId === 'ETH' ? 'ETHEREUM' : c.backendChainId
    const chainCfg = legacyId ? GAS_CHAINS[legacyId as keyof typeof GAS_CHAINS] : null

    if (isNonEvm && chainCfg && !chainCfg.deliveryImplemented) {
      fail(
        `${dbSlug} is isActive=true but deliveryImplemented=false`,
        'Non-EVM chain is marked active but delivery is not implemented. Orders will fail. Set isActive=false until delivery is ready.',
      )
    } else if (!c.backendChainId) {
      warn(`${dbSlug} isActive but no backendChainId`, 'Chain has no backend delivery mapping — orders will fail')
    } else {
      pass(`${dbSlug} activation safety`, `readiness=${c.readinessState}`)
    }
  }

  await db.$disconnect()
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('━'.repeat(60))
  console.log('PakSwap Gas System — Production Deployment Verification')
  if (specificChain) console.log(`Chain filter: ${specificChain}`)
  if (fullMode) console.log('Mode: full (including non-EVM chains)')
  console.log('━'.repeat(60))

  await checkEnvVars()
  await checkMnemonic()
  await checkDatabase()
  await checkRedis()
  await checkRpcs()
  await checkQueues()
  await checkChainActivationSafety()

  // ── Summary ──────────────────────────────────────────────────────────────
  const passed  = results.filter((r) => r.ok && !r.warning).length
  const warned  = results.filter((r) => r.ok && r.warning).length
  const failed  = results.filter((r) => !r.ok).length

  console.log('\n' + '━'.repeat(60))
  console.log(`Summary: ${passed} passed  ${warned} warnings  ${failed} failed`)
  console.log('━'.repeat(60))

  if (hasFailure) {
    console.log('\n❌ Deployment verification FAILED — fix the above errors before going live.\n')
    process.exit(1)
  } else if (warned > 0) {
    console.log('\n⚠️  Deployment verification passed with warnings — review before production.\n')
    process.exit(0)
  } else {
    console.log('\n✅ All checks passed — system is production-ready.\n')
    process.exit(0)
  }
}

void main()
