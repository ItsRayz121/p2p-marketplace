import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.preprocess(
    (val) => (val === '' || val === undefined || val === null ? 'production' : val),
    z.enum(['development', 'test', 'production'])
  ),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default('0.0.0.0'),

  // Database & Redis
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  // Auth
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  CSRF_SECRET: z.string().min(32, 'CSRF_SECRET must be at least 32 characters'),

  // Critical: CNIC hash — server refuses to start without this
  CNIC_HASH_SECRET: z.string().min(32, 'CNIC_HASH_SECRET is required and must be at least 32 characters'),

  // Frontend
  FRONTEND_URL: z.string().url().default('http://localhost:3000').refine(
    (url) => process.env.NODE_ENV !== 'production' || url.startsWith('https://'),
    { message: 'FRONTEND_URL must use HTTPS in production' },
  ),

  // Optional cookie domain so the refresh-token cookie can be first-party across
  // subdomains (e.g. ".rupchain.com" → shared by rupchain.com + api.rupchain.com).
  // Leave unset to keep host-only cookies (current behaviour).
  //
  // Self-healing: a malformed value here (protocol, trailing slash, port, stray
  // whitespace, or a missing/extra leading dot) makes the browser silently REJECT
  // every auth cookie → "logged out + 2FA on every open". So we normalize any
  // reasonable input — "https://rupchain.com/", " rupchain.com ", ".rupchain.com"
  // all collapse to ".rupchain.com" — rather than trusting it verbatim.
  COOKIE_DOMAIN: z
    .string()
    .optional()
    .transform((v) => {
      if (!v) return undefined
      const cleaned = v
        .trim()
        .replace(/^https?:\/\//i, '') // drop protocol
        .replace(/\/.*$/, '')          // drop path
        .replace(/:\d+$/, '')          // drop port
        .replace(/^\.+|\.+$/g, '')     // drop leading/trailing dots
        .toLowerCase()
      if (!cleaned || !cleaned.includes('.')) return undefined // ignore junk / bare hostnames like "localhost"
      return `.${cleaned}`
    }),

  // Cloudinary (file storage — KYC docs, payment proof screenshots)
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  // Resend (transactional email)
  // EMAIL_FROM must be a Resend-verified sender; format is either
  // 'noreply@yourdomain.com' or 'Display Name <noreply@yourdomain.com>'.
  // No default — an invalid/missing value disables outbound email with a warning log.
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),

  // Rate Exchange APIs
  BINANCE_API_KEY: z.string().optional(),
  BINANCE_API_SECRET: z.string().optional(),
  EXCHANGERATE_API_KEY: z.string().optional(),

  // Blockchain Monitoring
  MORALIS_API_KEY: z.string().optional(),
  MORALIS_WEBHOOK_SECRET: z.string().optional(),
  MORALIS_API_BASE_URL: z.string().url().default('https://api.moralis-streams.com'),
  // Per-chain stream ids — set after you create each Moralis Stream in the
  // dashboard. The subscribe worker skips chains whose id is unset and marks
  // their MoralisStreamSubscription rows as status='skipped'.
  MORALIS_STREAM_ID_ETHEREUM: z.string().optional(),
  MORALIS_STREAM_ID_BSC: z.string().optional(),
  MORALIS_STREAM_ID_POLYGON: z.string().optional(),
  MORALIS_STREAM_ID_ARBITRUM: z.string().optional(),
  MORALIS_STREAM_ID_OPTIMISM: z.string().optional(),
  MORALIS_STREAM_ID_BASE: z.string().optional(),
  // Public RPC endpoints used by the deposit reconciler worker (independent
  // of Moralis Streams). Each defaults to a free, public endpoint — operators
  // are strongly encouraged to point these at their own dedicated providers
  // for production use.
  ETHEREUM_RPC_URL: z.string().url().default('https://eth.llamarpc.com'),
  BSC_RPC_URL: z.string().url().default('https://bsc-dataseed.binance.org'),
  // Optional dedicated BSC endpoints for the gas payment poller's getLogs scan.
  // BSC public RPCs (bsc-dataseed.binance.org) reject wide block ranges with
  // "Request exceeds defined limit" — point these at a provider that allows
  // getLogs over a small range (any reasonable node does at ≤50 blocks).
  BSC_RPC_URL_PRIMARY: z.string().url().optional(),
  BSC_RPC_URL_FALLBACK: z.string().url().optional(),
  // Max blocks per getLogs request. Kept small so public RPCs never reject the
  // range; the poller pages through larger gaps in chunks of this size.
  MAX_LOG_SCAN_BLOCKS: z.coerce.number().int().positive().max(2000).default(50),
  // Gas payment poller interval (seconds) — surfaced in admin; the cron registers
  // the job, this documents the cadence for health displays.
  POLLER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  POLYGON_RPC_URL: z.string().url().default('https://polygon-bor-rpc.publicnode.com'),
  ARBITRUM_RPC_URL: z.string().url().default('https://arb1.arbitrum.io/rpc'),
  OPTIMISM_RPC_URL: z.string().url().default('https://mainnet.optimism.io'),
  BASE_RPC_URL: z.string().url().default('https://mainnet.base.org'),
  AVALANCHE_RPC_URL: z.string().url().default('https://api.avax.network/ext/bc/C/rpc'),
  // opBNB (BSC L2, chainId 204). Native gas coin is BNB but on a separate network.
  // Default is the official BNB Chain endpoint; rpcFallback.ts adds public fallbacks.
  OPBNB_RPC_URL: z.string().url().default('https://opbnb-mainnet-rpc.bnbchain.org'),

  // Non-EVM chain RPC endpoints (chains are inactive by default)
  // SOL: Solana JSON-RPC node (Helius, QuickNode, or public mainnet-beta endpoint)
  SOL_RPC_URL: z.string().url().default('https://api.mainnet-beta.solana.com'),
  // TON: TON HTTP API v2 base URL (toncenter.com or self-hosted)
  TON_ENDPOINT_URL: z.string().url().default('https://toncenter.com'),
  // TON_API_KEY: optional API key for toncenter.com rate-limit tier
  TON_API_KEY: z.string().optional(),
  // TON v4 API (TON Hub) — genuinely independent of toncenter, used as the real
  // delivery fallback when the toncenter-family v2 backend is 5xx'ing.
  TON_V4_ENDPOINT_URL: z.string().url().default('https://mainnet-v4.tonhubapi.com'),
  // SUI: SUI Mainnet JSON-RPC node (mysten, Shinami, QuickNode, etc.)
  SUI_RPC_URL: z.string().url().default('https://fullnode.mainnet.sui.io'),
  // Aptos Indexer GraphQL endpoint — used by the gas payment poller to detect
  // incoming USDT (fungible-asset) deposits to the Aptos gas wallet.
  APTOS_INDEXER_URL: z.string().url().default('https://api.mainnet.aptoslabs.com/v1/graphql'),
  // Aptos fullnode REST endpoint — used to submit outgoing USDT refund transfers.
  APTOS_FULLNODE_URL: z.string().url().default('https://api.mainnet.aptoslabs.com/v1'),
  // Optional Aptos Labs API key (Bearer) for higher indexer rate limits.
  APTOS_API_KEY: z.string().optional(),
  // Low-balance alert floor for the Aptos hot wallet's native APT (gas for USDT
  // refunds). Below this, the balance monitor emails/notifies the admin.
  GAS_APTOS_MIN_APT: z.coerce.number().positive().default(0.05),
  // Aptos deposit → hot-wallet sweep (aptosDepositSweep.service.ts). Per-user
  // Aptos deposit addresses hold USDT but no APT for gas, so the sweep first
  // tops them up with this much APT from the hot wallet before the USDT transfer.
  // A fungible-asset transfer costs well under 0.001 APT; 0.002 is safe headroom.
  APTOS_SWEEP_GAS_APT: z.coerce.number().positive().default(0.002),
  // Don't bother sweeping a deposit address holding less USDT than this (the gas
  // top-up would cost more than the amount recovered).
  APTOS_SWEEP_MIN_USDT: z.coerce.number().positive().default(0.01),
  // Max deposit addresses the straggler sweep processes per run (keeps a single
  // tick bounded; the rest are picked up on the next run).
  APTOS_SWEEP_STRAGGLER_BATCH: z.coerce.number().int().positive().default(25),
  // Reconciler tuning. The reconciler scans detected deposits older than
  // `DEPOSIT_RECONCILE_MIN_AGE_SECONDS` every `DEPOSIT_RECONCILE_INTERVAL_SECONDS`.
  DEPOSIT_RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  DEPOSIT_RECONCILE_MIN_AGE_SECONDS: z.coerce.number().int().nonnegative().default(30),
  DEPOSIT_RECONCILE_MAX_AGE_HOURS: z.coerce.number().int().positive().default(48),
  DEPOSIT_RECONCILE_BATCH_SIZE: z.coerce.number().int().positive().default(50),

  TATUM_API_KEY: z.string().optional(),
  TATUM_WEBHOOK_SECRET: z.string().optional(),
  BLOCKCYPHER_TOKEN: z.string().optional(),

  // Blockchain RPCs
  TRON_FULLNODE_URL: z.string().url().default('https://api.trongrid.io'),
  TRONGRID_API_KEY: z.string().optional(),
  // Optional comma-separated extra TRON full-node hosts to fall back to when the
  // primary returns 429/5xx (e.g. "https://api.trongrid.io,https://trx.api.tatum.io").
  // The API key is only sent to the primary (a TronGrid key is invalid elsewhere).
  TRON_FULLNODE_FALLBACK_URLS: z.string().optional(),
  ETHERSCAN_API_KEY: z.string().optional(),

  // Gas Fee System — TRON
  GAS_FEE_DEPOSIT_ADDRESS_TRC20: z.string().optional(),
  GAS_MARKUP_MULTIPLIER_TRON: z.coerce.number().default(1.5),

  // Gas Fee System — BSC
  GAS_FEE_DEPOSIT_ADDRESS_BEP20: z.string().optional(),
  GAS_MARKUP_MULTIPLIER_BSC: z.coerce.number().default(1.5),

  // Gas Fee System — opBNB (shares the EVM hot-wallet address with BSC)
  GAS_FEE_DEPOSIT_ADDRESS_OPBNB: z.string().optional(),
  GAS_MARKUP_MULTIPLIER_OPBNB: z.coerce.number().default(1.5),

  // Gas Fee System — Ethereum
  GAS_FEE_DEPOSIT_ADDRESS_ERC20: z.string().optional(),
  GAS_MARKUP_MULTIPLIER_ETH: z.coerce.number().default(1.5),

  // Gas Fee System — Base
  GAS_FEE_DEPOSIT_ADDRESS_BASE: z.string().optional(),
  GAS_MARKUP_MULTIPLIER_BASE: z.coerce.number().default(1.5),

  // Gas Fee System — Arbitrum
  GAS_FEE_DEPOSIT_ADDRESS_ARB: z.string().optional(),
  GAS_MARKUP_MULTIPLIER_ARB: z.coerce.number().default(1.5),

  // Gas Fee System — Optimism
  GAS_FEE_DEPOSIT_ADDRESS_OP: z.string().optional(),
  GAS_MARKUP_MULTIPLIER_OP: z.coerce.number().default(1.5),

  // Gas Fee System — Polygon
  GAS_FEE_DEPOSIT_ADDRESS_MATIC: z.string().optional(),
  GAS_MARKUP_MULTIPLIER_MATIC: z.coerce.number().default(1.5),

  // Gas Fee System — Avalanche
  GAS_FEE_DEPOSIT_ADDRESS_AVAX: z.string().optional(),
  GAS_MARKUP_MULTIPLIER_AVAX: z.coerce.number().default(1.5),

  // Gas Fee System — Solana (inactive)
  GAS_FEE_DEPOSIT_ADDRESS_SOL: z.string().optional(),
  GAS_MARKUP_MULTIPLIER_SOL: z.coerce.number().default(1.5),

  // Gas Fee System — TON (inactive)
  GAS_FEE_DEPOSIT_ADDRESS_TON: z.string().optional(),
  GAS_MARKUP_MULTIPLIER_TON: z.coerce.number().default(1.5),

  // Gas Fee System — SUI (inactive)
  GAS_FEE_DEPOSIT_ADDRESS_SUI: z.string().optional(),
  GAS_MARKUP_MULTIPLIER_SUI: z.coerce.number().default(1.5),

  // Gas Fee System — shared
  GAS_GUEST_DAILY_LIMIT_USD: z.coerce.number().default(10),
  COINGECKO_API_KEY: z.string().optional(),
  FREECRYPTOAPI_KEY: z.string().optional(),
  COINSTATS_API_KEY: z.string().optional(),
  CMC_API_KEY: z.string().optional(),
  // Alchemy — Ethereum node RPC (not a price API). Set as ETHEREUM_RPC_URL value.
  ALCHEMY_API_KEY: z.string().optional(),

  // P2P Platform Deposit Addresses (legacy shared addresses — fallback only)
  PLATFORM_DEPOSIT_USDT_TRC20: z.string().optional(),
  PLATFORM_DEPOSIT_USDT_BEP20: z.string().optional(),
  PLATFORM_DEPOSIT_USDT_ERC20: z.string().optional(),

  // Wallet HD-derivation custody (user deposit addresses — random seed, NOT mnemonic)
  // Generate via `npm run wallet:bootstrap` — see backend/src/scripts/walletBootstrap.ts
  WALLET_MASTER_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'WALLET_MASTER_KEY must be 64-char hex (32 bytes)').optional(),
  WALLET_MASTER_SEED_CIPHERTEXT: z.string().optional(),

  // Gas wallet HD-derivation (hot wallets + deposit addresses — BIP39 mnemonic based)
  // GAS_MASTER_KEY: 64-char hex (32 bytes) — AES-256-GCM key wrapping the gas seed
  // GAS_SEED_CIPHERTEXT: base64 `iv(12) || authTag(16) || ciphertext(64)` of BIP39 seed
  // Generate via `npm run gas:encrypt-mnemonic` — see backend/src/scripts/encryptGasMnemonic.ts
  GAS_MASTER_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'GAS_MASTER_KEY must be 64-char hex (32 bytes)').optional(),
  GAS_SEED_CIPHERTEXT: z.string().optional(),

  // Firebase Push Notifications
  FCM_SERVER_KEY: z.string().optional(),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT: z.string().optional(),

  // Google OAuth
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().url().optional(),

  // ── Telegram Mini App + Bot ──
  // TELEGRAM_BOT_TOKEN: the BotFather token. Used both as the HMAC key when
  // validating Mini App initData and to drive the bot (webhook + /start).
  // When unset, all Telegram features no-op gracefully (miniapp auth returns
  // 503, the bot is not started) — the rest of the app is unaffected.
  // .trim() is defensive: a token pasted into a Railway/host env var often
  // carries a trailing newline or stray space, which silently breaks the
  // initData HMAC (every Mini App login 401s) with no other symptom.
  TELEGRAM_BOT_TOKEN: z.string().trim().optional(),
  // TELEGRAM_BOT_USERNAME: the bot's @handle WITHOUT the leading "@"
  // (e.g. "RupChainBot"). Used to build t.me deep links for referrals.
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  // TELEGRAM_WEBHOOK_SECRET: random secret echoed by Telegram in the
  // X-Telegram-Bot-Api-Secret-Token header on every webhook call. The webhook
  // route rejects any request whose header does not match. Generate 32+ hex.
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  // TELEGRAM_WEBHOOK_URL: public HTTPS base that receives bot updates
  // (e.g. https://api.rupchain.com). The full webhook path is
  // `${TELEGRAM_WEBHOOK_URL}/api/v1/telegram/webhook`. When set, the backend
  // registers the webhook with Telegram on boot. Leave unset to skip.
  TELEGRAM_WEBHOOK_URL: z.string().url().optional(),
  // TELEGRAM_MINI_APP_URL: the exact Mini App bridge URL configured in
  // BotFather (e.g. https://rupchain.com/mini-app). Used in the /start reply's
  // web_app button. Falls back to `${FRONTEND_URL}/mini-app` when unset.
  TELEGRAM_MINI_APP_URL: z.string().url().optional(),

  // Cloudflare Turnstile
  TURNSTILE_SECRET_KEY: z.string().optional(),

  // Monitoring
  SENTRY_DSN: z.string().optional(),
  POSTHOG_API_KEY: z.string().optional(),

  // Alerts
  ADMIN_ALERT_EMAIL: z.string().email().optional(),
})

// Production-only required vars: fail fast if missing in prod.
// The server refuses to start if any of these are absent in production,
// preventing silent partial failures (gas not delivered, emails not sent, etc.).
const productionRequired: string[] = [
  'GAS_MASTER_KEY',
  'GAS_SEED_CIPHERTEXT',
  'MORALIS_WEBHOOK_SECRET',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'RESEND_API_KEY',
  'EMAIL_FROM',
]

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('❌ Invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

if (parsed.data.NODE_ENV === 'production' && productionRequired.length > 0) {
  const data = parsed.data as Record<string, unknown>
  const missing = productionRequired.filter((key) => !data[key])
  if (missing.length > 0) {
    console.error(`❌ Missing required production environment variables: ${missing.join(', ')}`)
    process.exit(1)
  }
}

export const env = parsed.data
export type Env = typeof parsed.data
