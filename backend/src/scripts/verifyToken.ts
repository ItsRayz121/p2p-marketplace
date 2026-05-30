/**
 * 3-layer token verification CLI
 *
 * Usage:
 *   npx ts-node src/scripts/verifyToken.ts --chain ethereum --symbol USDT
 *   npx ts-node src/scripts/verifyToken.ts --chain bsc --address 0x55d398326f99059fF775485246999027B3197955
 *
 * Layers:
 *   1. CoinGecko API  — official contract address + decimals
 *   2. On-chain RPC   — calls decimals() + symbol() on the contract
 *   3. TrustWallet    — community-audited asset registry on GitHub
 *
 * All layers passing → prints a ready-to-use POST body for the admin API.
 */

import * as https from 'node:https'
import * as http from 'node:http'
import 'dotenv/config'

// ── ANSI colours ──────────────────────────────────────────────────────────────
const GREEN  = '\x1b[32m'
const RED    = '\x1b[31m'
const YELLOW = '\x1b[33m'
const CYAN   = '\x1b[36m'
const BOLD   = '\x1b[1m'
const RESET  = '\x1b[0m'

function pass(msg: string) { return `${GREEN}[✓]${RESET} ${msg}` }
function fail(msg: string) { return `${RED}[✗]${RESET} ${msg}` }
function warn(msg: string) { return `${YELLOW}[!]${RESET} ${msg}` }

// ── Config maps ───────────────────────────────────────────────────────────────

const COINGECKO_PLATFORM: Record<string, string> = {
  ethereum: 'ethereum',
  bsc:      'binance-smart-chain',
  polygon:  'polygon-pos',
  arbitrum: 'arbitrum-one',
  optimism: 'optimistic-ethereum',
  base:     'base',
  avalanche: 'avalanche',
}

const COINGECKO_SYMBOL_TO_ID: Record<string, string> = {
  USDT:  'tether',
  USDC:  'usd-coin',
  DAI:   'dai',
  WBTC:  'wrapped-bitcoin',
  LINK:  'chainlink',
  UNI:   'uniswap',
  AAVE:  'aave',
  BUSD:  'binance-usd',
  TUSD:  'true-usd',
  FRAX:  'frax',
  PEPE:  'pepe',
  SHIB:  'shiba-inu',
}

const RPC_URLS: Record<string, string> = {
  ethereum: process.env.ETHEREUM_RPC_URL ?? 'https://eth.llamarpc.com',
  bsc:      process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org',
  polygon:  process.env.POLYGON_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com',
  arbitrum: process.env.ARBITRUM_RPC_URL ?? 'https://arb1.arbitrum.io/rpc',
  optimism: process.env.OPTIMISM_RPC_URL ?? 'https://mainnet.optimism.io',
  base:     process.env.BASE_RPC_URL ?? 'https://mainnet.base.org',
  avalanche: process.env.AVALANCHE_RPC_URL ?? 'https://api.avax.network/ext/bc/C/rpc',
}

const TW_CHAIN: Record<string, string> = {
  ethereum: 'ethereum',
  bsc:      'smartchain',
  polygon:  'polygon',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  base:     'base',
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function fetchJson(url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const lib = parsed.protocol === 'https:' ? https : http
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: opts?.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'RupChain-TokenVerifier/1.0',
        ...(opts?.headers ?? {}),
      },
    }
    const req = lib.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode === 404) { reject(new Error(`HTTP 404: ${url}`)); return }
        if ((res.statusCode ?? 0) >= 400) { reject(new Error(`HTTP ${res.statusCode}: ${url}`)); return }
        try { resolve(JSON.parse(data)) } catch { reject(new Error(`Invalid JSON from ${url}`)) }
      })
    })
    req.on('error', reject)
    if (opts?.body) req.write(opts.body)
    req.end()
  })
}

// ── Decode ABI-encoded string ─────────────────────────────────────────────────

function decodeAbiString(hex: string): string | null {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length < 128) return null
  const len = parseInt(clean.slice(64, 128), 16)
  if (isNaN(len) || len === 0) return null
  const strHex = clean.slice(128, 128 + len * 2)
  return Buffer.from(strHex, 'hex').toString('utf8').replace(/\0/g, '').trim()
}

// ── CLI argument parsing ──────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2)
  const get = (flag: string) => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  return { chain: get('--chain'), symbol: get('--symbol'), address: get('--address') }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { chain, symbol, address: cliAddress } = parseArgs()

  if (!chain) {
    console.error(`${RED}Usage:${RESET}`)
    console.error('  npx ts-node src/scripts/verifyToken.ts --chain ethereum --symbol USDT')
    console.error('  npx ts-node src/scripts/verifyToken.ts --chain bsc --address 0x55d398326f...')
    process.exit(1)
  }

  const chainSlug = chain.toLowerCase()

  console.log(`\n${BOLD}${CYAN}Token Verification — ${symbol ?? cliAddress ?? '?'} on ${chain.toUpperCase()}${RESET}`)
  console.log('─'.repeat(56))

  let resolvedAddress: string | null = cliAddress ?? null
  let resolvedDecimals: number | null = null
  let coingeckoOk = false

  // ── Layer 1: CoinGecko ───────────────────────────────────────────────────────
  if (symbol) {
    const cgPlatform = COINGECKO_PLATFORM[chainSlug]
    const cgId = COINGECKO_SYMBOL_TO_ID[symbol.toUpperCase()]

    if (!cgPlatform) {
      console.log(warn(`CoinGecko: no platform mapping for chain "${chainSlug}" — skipped`))
    } else if (!cgId) {
      console.log(warn(`CoinGecko: no ID mapping for symbol "${symbol.toUpperCase()}" — add it to COINGECKO_SYMBOL_TO_ID`))
    } else {
      try {
        const apiKey = process.env.COINGECKO_API_KEY
        const headers = apiKey ? { 'x-cg-demo-api-key': apiKey } : {}
        const url = `https://api.coingecko.com/api/v3/coins/${cgId}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`
        const data = await fetchJson(url, { headers }) as {
          detail_platforms?: Record<string, { contract_address: string; decimal_place: number } | null>
        }
        const platformData = data.detail_platforms?.[cgPlatform]
        if (platformData?.contract_address) {
          resolvedAddress = platformData.contract_address
          resolvedDecimals = platformData.decimal_place
          coingeckoOk = true
          console.log(pass(`CoinGecko    address=${resolvedAddress}  decimals=${resolvedDecimals}`))
        } else {
          console.log(fail(`CoinGecko    token not found on platform "${cgPlatform}"`))
        }
      } catch (err) {
        console.log(fail(`CoinGecko    ${err instanceof Error ? err.message : 'fetch failed'}`))
      }
    }
  } else {
    console.log(warn('CoinGecko: --symbol not provided, skipping CoinGecko lookup'))
  }

  // ── Layer 2: On-chain RPC ────────────────────────────────────────────────────
  let onChainOk = false
  let onChainSymbol: string | null = null
  let onChainDecimals: number | null = null

  if (!resolvedAddress) {
    console.log(warn('On-chain: no address to verify (CoinGecko failed or --address not provided)'))
  } else {
    const rpcUrl = RPC_URLS[chainSlug]
    if (!rpcUrl) {
      console.log(warn(`On-chain: no RPC URL for chain "${chainSlug}" — skipped`))
    } else {
      try {
        const call = async (data: string): Promise<string> => {
          const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: resolvedAddress, data }, 'latest'] })
          const res = await fetchJson(rpcUrl, { method: 'POST', body }) as { result?: string; error?: { message: string } }
          if (res.error) throw new Error(res.error.message)
          return res.result ?? '0x'
        }

        const [symbolHex, decimalsHex] = await Promise.all([
          call('0x95d89b41'), // symbol()
          call('0x313ce567'), // decimals()
        ])
        onChainSymbol   = decodeAbiString(symbolHex)
        onChainDecimals = Number(BigInt(decimalsHex || '0x12'))

        const symbolMatch   = !symbol || (onChainSymbol?.toUpperCase() === symbol.toUpperCase())
        const decimalsMatch = resolvedDecimals == null || onChainDecimals === resolvedDecimals
        onChainOk = symbolMatch && decimalsMatch

        if (onChainOk) {
          console.log(pass(`On-chain     symbol=${onChainSymbol}  decimals=${onChainDecimals}`))
        } else {
          console.log(fail(`On-chain     symbol=${onChainSymbol} (expected ${symbol?.toUpperCase() ?? '?'}), decimals=${onChainDecimals} (expected ${resolvedDecimals ?? '?'})`))
        }
      } catch (err) {
        console.log(fail(`On-chain     ${err instanceof Error ? err.message : 'RPC call failed'}`))
      }
    }
  }

  // ── Layer 3: TrustWallet ─────────────────────────────────────────────────────
  let twOk = false
  const twChain = TW_CHAIN[chainSlug]

  if (!resolvedAddress) {
    console.log(warn('TrustWallet: no address to check — skipped'))
  } else if (!twChain) {
    console.log(warn(`TrustWallet: no chain mapping for "${chainSlug}" — skipped`))
  } else {
    try {
      const url = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${twChain}/assets/${resolvedAddress}/info.json`
      await fetchJson(url)
      twOk = true
      console.log(pass('TrustWallet  community-audited ✓'))
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'fetch failed'
      if (msg.includes('404')) {
        console.log(warn('TrustWallet  not in registry (not a hard blocker, but check carefully)'))
      } else {
        console.log(fail(`TrustWallet  ${msg}`))
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log('─'.repeat(56))

  const hardPassed = onChainOk // on-chain is the hard requirement
  const softWarnings = !coingeckoOk || !twOk

  if (hardPassed) {
    console.log(`\n${GREEN}${BOLD}On-chain verification PASSED.${RESET}${softWarnings ? ` ${YELLOW}(CoinGecko or TrustWallet warnings above — review before adding)${RESET}` : ''}`)
    console.log(`\n${BOLD}Ready-to-use API call:${RESET}`)
    console.log(`${CYAN}POST /admin/deposit-chains/${chainSlug}/tokens${RESET}`)
    console.log(JSON.stringify({
      symbol: symbol?.toUpperCase() ?? onChainSymbol ?? 'UNKNOWN',
      address: resolvedAddress,
      decimals: resolvedDecimals ?? onChainDecimals,
      coingeckoId: symbol ? (COINGECKO_SYMBOL_TO_ID[symbol.toUpperCase()] ?? null) : null,
      onChainVerified: true,
      trustWalletVerified: twOk,
    }, null, 2))
  } else {
    console.log(`\n${RED}${BOLD}VERIFICATION FAILED — do NOT add this token until on-chain check passes.${RESET}`)
    process.exit(1)
  }

  console.log()
}

main().catch((err) => {
  console.error(`${RED}Fatal:${RESET}`, err instanceof Error ? err.message : err)
  process.exit(1)
})
