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
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),

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
  POLYGON_RPC_URL: z.string().url().default('https://polygon-rpc.com'),
  ARBITRUM_RPC_URL: z.string().url().default('https://arb1.arbitrum.io/rpc'),
  OPTIMISM_RPC_URL: z.string().url().default('https://mainnet.optimism.io'),
  BASE_RPC_URL: z.string().url().default('https://mainnet.base.org'),
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
  TRON_FULL_NODE_URL: z.string().url().default('https://api.trongrid.io'),
  TRONGRID_API_KEY: z.string().optional(),
  ETHERSCAN_API_KEY: z.string().optional(),

  // Gas Fee System
  GAS_FEE_DEPOSIT_ADDRESS_TRC20: z.string().optional(),
  GAS_WALLET_PRIVATE_KEY_TRON: z.string().optional(),
  GAS_WALLET_SECRET_ARN_TRON: z.string().optional(),
  GAS_WALLET_ALERT_THRESHOLD_TRON: z.coerce.number().default(5000),
  GAS_WALLET_PAUSE_THRESHOLD_TRON: z.coerce.number().default(1000),
  GAS_MARKUP_MULTIPLIER_TRON: z.coerce.number().default(1.5),
  COINGECKO_API_KEY: z.string().optional(),

  // P2P Platform Deposit Addresses (legacy shared addresses — fallback only)
  PLATFORM_DEPOSIT_USDT_TRC20: z.string().optional(),
  PLATFORM_DEPOSIT_USDT_BEP20: z.string().optional(),
  PLATFORM_DEPOSIT_USDT_ERC20: z.string().optional(),

  // Wallet HD-derivation custody
  // WALLET_MASTER_KEY: 64-char hex (32 bytes) — AES-256-GCM key wrapping the master seed
  // WALLET_MASTER_SEED_CIPHERTEXT: base64-encoded `iv(12) || authTag(16) || ciphertext` of a BIP39 entropy or seed
  // Generate both via `npm run wallet:bootstrap` — see backend/src/scripts/walletBootstrap.ts
  WALLET_MASTER_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'WALLET_MASTER_KEY must be 64-char hex (32 bytes)').optional(),
  WALLET_MASTER_SEED_CIPHERTEXT: z.string().optional(),

  // Firebase Push Notifications
  FCM_SERVER_KEY: z.string().optional(),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT: z.string().optional(),

  // Cloudflare Turnstile
  TURNSTILE_SECRET_KEY: z.string().optional(),

  // Monitoring
  SENTRY_DSN: z.string().optional(),
  POSTHOG_API_KEY: z.string().optional(),

  // Alerts
  ADMIN_ALERT_EMAIL: z.string().email().optional(),
})

// Production-only required vars: fail fast if missing in prod.
// AWS and SMTP are intentionally excluded here — the server starts without them,
// but KYC uploads and email sending will be unavailable until they are configured.
const productionRequired: string[] = []

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
