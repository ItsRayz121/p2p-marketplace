import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
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

  // AWS S3
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().default('ap-south-1'),
  AWS_S3_BUCKET: z.string().optional(),

  // Email (SMTP)
  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().default('PakSwap <noreply@pakswap.pk>'),

  // Rate Exchange APIs
  BINANCE_API_KEY: z.string().optional(),
  BINANCE_API_SECRET: z.string().optional(),
  EXCHANGERATE_API_KEY: z.string().optional(),

  // Blockchain Monitoring
  MORALIS_API_KEY: z.string().optional(),
  MORALIS_WEBHOOK_SECRET: z.string().optional(),
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

  // P2P Platform Deposit Addresses
  PLATFORM_DEPOSIT_USDT_TRC20: z.string().optional(),
  PLATFORM_DEPOSIT_USDT_BEP20: z.string().optional(),
  PLATFORM_DEPOSIT_USDT_ERC20: z.string().optional(),

  // Firebase Push Notifications
  FCM_SERVER_KEY: z.string().optional(),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:ops@pakswap.pk'),
  FIREBASE_SERVICE_ACCOUNT: z.string().optional(),

  // Cloudflare Turnstile
  TURNSTILE_SECRET_KEY: z.string().optional(),

  // Monitoring
  SENTRY_DSN: z.string().optional(),
  POSTHOG_API_KEY: z.string().optional(),

  // Alerts
  ADMIN_ALERT_EMAIL: z.string().email().default('ops@pakswap.pk'),
})

// Production-only required vars: fail fast if missing in prod
const productionRequired = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_S3_BUCKET',
  'SMTP_USER',
  'SMTP_PASS',
] as const

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('❌ Invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

if (parsed.data.NODE_ENV === 'production') {
  const missing = productionRequired.filter((key) => !parsed.data[key])
  if (missing.length > 0) {
    console.error(`❌ Missing required production environment variables: ${missing.join(', ')}`)
    process.exit(1)
  }
}

export const env = parsed.data
export type Env = typeof parsed.data
