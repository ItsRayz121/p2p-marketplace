# GAS_FEE_SPEC.md — PakSwap Global Gas Fee Supply System
## Complete Infrastructure Specification · Version 1.0 · 2026-05-12

> **Relationship to FULL_SPEC.md:** This is a satellite document. FULL_SPEC.md Section 31 contains the architectural summary. This file contains the complete specification. All developers building the gas fee system MUST read both.

---

## Table of Contents

| Section | Topic |
|---------|-------|
| 1 | Product Overview & Business Model |
| 2 | MVP Scope (TRC20/TRON Only) |
| 3 | Supported Chains Roadmap |
| 4 | Pricing Model & Revenue Analysis |
| 5 | User-Facing Order Flow |
| 6 | Backend Order Lifecycle |
| 7 | Database Schema |
| 8 | API Contracts |
| 9 | Hot Wallet Architecture |
| 10 | Automated Payout Pipeline |
| 11 | Abuse Prevention & Rate Limiting |
| 12 | Failure Recovery & Refund Logic |
| 13 | Admin Panel Integration |
| 14 | Monitoring & Alerting |
| 15 | Environment Variables |
| 16 | Phase Roadmap |

---

## 1. Product Overview & Business Model

### What It Is

The Gas Fee Supply System allows anyone globally (no account required for small orders) to buy native blockchain gas tokens instantly. User selects a chain, enters a wallet address, pays USDT — receives gas within 60 seconds.

### Why It Exists

- Pakistani USDT holders frequently need TRX/ETH/BNB to pay gas fees for DeFi/P2P transactions
- They hold USDT but cannot easily buy small amounts of gas tokens from exchanges
- This is a high-frequency, low-friction product that generates steady automated revenue

### Business Model

```
User pays USDT → Platform sends native gas → Platform keeps markup
```

- Platform markup: 30–50% on cost
- No KYC for orders ≤ $10 USD equivalent
- KYC required for orders > $25 USD (links to PakSwap KYC system)
- Fully automated after setup — zero operator time at scale

### Separation from P2P System

| Aspect | P2P Marketplace | Gas Fee System |
|--------|----------------|----------------|
| Funds held by platform | No (peer-to-peer) | Yes (platform holds float) |
| KYC required | Yes (always) | No (for small orders) |
| Manual operation | Yes (admin reviews) | No (fully automated) |
| Hot wallets | One per coin | One per chain (gas float) |
| User account required | Yes | No (guest orders allowed) |

---

## 2. MVP Scope — TRC20/TRON Gas Only

**Phase 1 gas fee system supports only:**
- **Payment in:** USDT/TRC20
- **Gas out:** TRX (Tron native gas)

**Why TRC20 first:**
- TRC20 USDT is the dominant stablecoin in Pakistan (lowest fees, fastest confirmation)
- TRX sends are near-instant (3-second block time)
- TronWeb SDK is simple to automate without Fireblocks
- Platform already has a TRC20 deposit address from the P2P system
- Solves the most common user pain: buying TRX to pay for TRC20 USDT transfers

**MVP tiers:**

| Tier | TRX Amount | Platform Charges (USDT) | Platform Cost (USDT) | Margin |
|------|-----------|------------------------|---------------------|--------|
| Small | 10 TRX | $1.20 | ~$0.80 | $0.40 (50%) |
| Medium | 50 TRX | $5.50 | ~$4.00 | $1.50 (38%) |
| Large | 100 TRX | $10.00 | ~$7.50 | $2.50 (33%) |

> **Note:** TRX prices fluctuate. Platform recalculates cost at order time using real-time TRX/USD price. The platform charges a fixed USDT amount per tier; the TRX amount delivered varies slightly with price.

**MVP exclusions (Phase 2+):**
- ETH gas (requires Ethereum hot wallet + higher Fireblocks complexity)
- BNB gas (BEP20)
- SOL gas
- MATIC/POL gas
- No card payments (USDT only for MVP)

---

## 3. Supported Chains Roadmap

| Phase | Chain | Native Token | Payment Accepted | Notes |
|-------|-------|-------------|-----------------|-------|
| Phase 1 | TRON | TRX | USDT/TRC20 | MVP |
| Phase 2 | BSC | BNB | USDT/TRC20 + BEP20 | High demand in Pakistan |
| Phase 2 | Ethereum | ETH | USDT/TRC20 | Requires Fireblocks for automation |
| Phase 3 | Solana | SOL | USDT/TRC20 | Fast, growing market |
| Phase 3 | Polygon | MATIC/POL | USDT/TRC20 | Low value, high volume |
| Phase 4 | Arbitrum | ETH (Arb) | USDT/TRC20 | DeFi users |
| Phase 4 | Base | ETH (Base) | USDT/TRC20 | Coinbase ecosystem |
| Phase 4 | TON | TON | USDT/TRC20 | Telegram users |

---

## 4. Pricing Model & Revenue Analysis

### Price Calculation at Order Time

```typescript
// services/gasFee/pricing.service.ts

async function calculateGasFeeOrder(chain: Chain, tier: GasFeeTier): Promise<GasFeeQuote> {
  const nativePrice = await getNativeTokenPriceUSD(chain) // Real-time from CoinGecko/Binance
  const nativeAmount = TIER_NATIVE_AMOUNTS[chain][tier] // e.g., 10 TRX
  const costUSD = nativeAmount * nativePrice
  const chargeUSD = costUSD * MARKUP_MULTIPLIER[chain] // e.g., 1.5x = 50% markup
  const chargeUSDT = Math.ceil(chargeUSD * 100) / 100 // Round up to nearest cent

  return {
    chain,
    tier,
    nativeAmount,
    nativePriceUSD: nativePrice,
    costUSD,
    chargeUSDT,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5-minute price lock
  }
}
```

### Markup Table (Phase 1)

```typescript
const MARKUP_MULTIPLIER: Record<Chain, number> = {
  TRON: 1.50, // 50% markup
}

const TIER_NATIVE_AMOUNTS: Record<Chain, Record<GasFeeTier, number>> = {
  TRON: { SMALL: 10, MEDIUM: 50, LARGE: 100 },
}
```

### Revenue Projection

| Daily Orders | Avg Margin/Order | Monthly Revenue |
|-------------|-----------------|-----------------|
| 100 | $0.90 | $2,700 |
| 500 | $0.90 | $13,500 |
| 1,000 | $0.90 | $27,000 |

At 500 orders/day (realistic after 3 months): **$13,500/month fully automated.**

### Price Lock Policy

- Quote valid for **5 minutes** from generation
- After 5 minutes: order expires, user must re-request
- Platform absorbs price movement within the 5-minute window
- If TRX price moves >5% while order is payment_pending → auto-expire immediately (add to job)

---

## 5. User-Facing Order Flow

### Page: `/gas` (No Login Required)

```
Step 1: Select Chain
  [TRON/TRX]  (Phase 1 only)
  [ETH - Coming Soon]  [BNB - Coming Soon]

Step 2: Select Amount
  [ ] 10 TRX — Pay 1.20 USDT
  [ ] 50 TRX — Pay 5.50 USDT
  [x] 100 TRX — Pay 10.00 USDT

Step 3: Enter Destination Address
  [TRC20 address input]
  ✓ Address validated (TRC20 format check)

Step 4: Select Payment Network
  [x] USDT/TRC20 (recommended — fastest)
  [ ] USDT/BEP20 (Phase 2)

Step 5: Create Order
  → POST /api/gas-fee/orders
  → Returns: { orderRef, paymentAddress, paymentAmount, expiresAt }

Step 6: Payment Screen
  ┌─────────────────────────────────┐
  │ Send exactly 10.00 USDT/TRC20  │
  │ To: TXxxxx...xxxx              │
  │ [Copy Address]                  │
  │                                 │
  │ Order expires in: 04:32         │
  │ ⚡ Gas will arrive within 60s   │
  └─────────────────────────────────┘
  → Polls GET /api/gas-fee/orders/:orderRef every 5s

Step 7: Confirmation Screen
  ✅ 100 TRX delivered!
  TX: https://tronscan.org/tx/xxxxx
  [Order Another] [Share]
```

### Guest vs Authenticated Orders

| Feature | Guest | Logged In |
|---------|-------|-----------|
| Order limit per day | $10 USD | $100 USD |
| Order history | Session only | Persistent |
| KYC requirement | None ≤$10 | None ≤$25 |
| Refund address required | No (manual) | Auto from wallet |

---

## 6. Backend Order Lifecycle

### State Machine

```
created → payment_pending → payment_detected → sending → delivered
                         ↓                              ↓
                      expired                        failed → refunded
```

### State Definitions

| State | Meaning | Max Duration |
|-------|---------|-------------|
| `created` | Order created, waiting for user to send payment | 5 minutes |
| `payment_pending` | User acknowledged, polling for payment | 5 minutes |
| `payment_detected` | Webhook confirmed USDT received | — |
| `sending` | Platform hot wallet sending TRX | 2 minutes |
| `delivered` | TRX confirmed at destination address | Terminal |
| `expired` | Quote expired before payment detected | Terminal |
| `failed` | Sending failed (insufficient balance, network error) | → triggers recovery |
| `refunded` | USDT returned to sender (if detected after expiry, or failed) | Terminal |

### Order Creation Flow

```typescript
// POST /api/gas-fee/orders
// Auth: None required for guest orders

async function createGasFeeOrder(input: CreateGasFeeOrderInput): Promise<GasFeeOrderResponse> {
  // 1. Validate destination address format for the chain
  validateChainAddress(input.chain, input.toAddress)

  // 2. Get real-time price quote
  const quote = await calculateGasFeeOrder(input.chain, input.tier)

  // 3. Check guest daily limit
  if (!input.userId) {
    const todayGuestSpend = await getGuestDailySpend(input.ipAddress)
    if (todayGuestSpend + quote.chargeUSDT > GUEST_DAILY_LIMIT_USD) {
      throw new AppError('GUEST_LIMIT_EXCEEDED', 'Guest orders limited to $10/day. Create an account for higher limits.')
    }
  }

  // 4. Create order (idempotency key prevents duplicate on retry)
  const order = await db.gasFeeOrder.create({
    data: {
      orderRef: generateOrderRef('GF'),
      userId: input.userId ?? null,
      chain: input.chain,
      tier: input.tier,
      gasAmountNative: quote.nativeAmount,
      gasAmountUSD: quote.costUSD,
      priceAtOrder: quote.nativePriceUSD,
      paymentCoin: 'USDT',
      paymentNetwork: input.paymentNetwork,
      paymentAmount: quote.chargeUSDT,
      toAddress: input.toAddress,
      fromHotWallet: await getActiveGasHotWallet(input.chain),
      status: 'payment_pending',
      expiresAt: quote.expiresAt,
    },
  })

  // 5. Enqueue expiry job
  await gasFeeQueue.add('expire-order', { orderId: order.id }, {
    delay: 5 * 60 * 1000,
    jobId: `gas-expire-${order.id}`,
  })

  return {
    orderRef: order.orderRef,
    paymentAddress: GAS_FEE_DEPOSIT_ADDRESS[input.paymentNetwork],
    paymentAmount: order.paymentAmount,
    expiresAt: order.expiresAt,
  }
}
```

### Payment Detection

Payment detected via same Moralis/Tatum webhook as P2P system. The webhook handler checks incoming USDT transfers against all open gas fee orders:

```typescript
// In webhook handler (after P2P order check):
const gasOrder = await db.gasFeeOrder.findFirst({
  where: {
    status: 'payment_pending',
    paymentAmount: { gte: incomingAmount * 0.99 }, // 1% tolerance
    paymentNetwork: network,
    expiresAt: { gt: new Date() },
  },
  orderBy: { createdAt: 'asc' }, // Oldest matching order first
})

if (gasOrder) {
  await db.gasFeeOrder.update({
    where: { id: gasOrder.id },
    data: { status: 'payment_detected', paymentTxHash: txHash },
  })
  await gasFeeQueue.add('send-gas', { orderId: gasOrder.id }, { priority: 1 })
}
```

> **Attribution rule:** Same-amount ambiguity: if two orders have the same paymentAmount and are both pending, attribute to the oldest. Log both in admin reconciliation queue for manual review.

---

## 7. Database Schema

```prisma
// Add to schema.prisma

enum GasChain {
  TRON
  BSC
  ETH
  SOL
  MATIC
  ARB
  BASE
  TON
}

enum GasFeeTier {
  SMALL
  MEDIUM
  LARGE
}

enum GasFeeOrderStatus {
  created
  payment_pending
  payment_detected
  sending
  delivered
  expired
  failed
  refunded
}

model GasFeeOrder {
  id                String            @id @default(cuid())
  orderRef          String            @unique
  userId            String?           // null for guest orders
  user              User?             @relation(fields: [userId], references: [id])
  ipAddress         String?           // for guest rate limiting

  chain             GasChain
  tier              GasFeeTier
  gasAmountNative   Decimal           @db.Decimal(18, 8) // e.g., 100.00000000 TRX
  gasAmountUSD      Decimal           @db.Decimal(10, 4) // cost to platform in USD
  priceAtOrder      Decimal           @db.Decimal(18, 8) // native token price at order time

  paymentCoin       String            @default("USDT")
  paymentNetwork    String            // "TRC20" | "BEP20"
  paymentAmount     Decimal           @db.Decimal(10, 4) // USDT charged to user
  paymentTxHash     String?           // incoming USDT tx hash

  toAddress         String            // destination address for gas
  fromHotWallet     String            // which platform hot wallet sent from
  deliveryTxHash    String?           // outgoing native gas tx hash
  deliveryConfirmed Boolean           @default(false)

  status            GasFeeOrderStatus @default(created)
  failureReason     String?
  retryCount        Int               @default(0)
  expiresAt         DateTime

  createdAt         DateTime          @default(now())
  updatedAt         DateTime          @updatedAt
  deliveredAt       DateTime?
  refundedAt        DateTime?

  @@index([status, expiresAt])
  @@index([userId])
  @@index([orderRef])
  @@index([paymentTxHash])
}

model GasHotWallet {
  id          String   @id @default(cuid())
  chain       GasChain @unique
  address     String
  isActive    Boolean  @default(true)
  // Private key stored in AWS Secrets Manager — NEVER in DB
  // secretArn: stored in environment variable GAS_WALLET_SECRET_ARN_{CHAIN}
  createdAt   DateTime @default(now())

  @@index([chain, isActive])
}
```

---

## 8. API Contracts

### POST /api/gas-fee/orders

Create a new gas fee order.

**Auth:** None required (guest allowed)

**Idempotency:** Requires `Idempotency-Key: {uuid}` header (same as FULL_SPEC.md Section 27.6). If the same key is submitted twice within 24 hours, the second request returns the existing order without creating a duplicate. Stored in Redis: `idempotency:{key}` with 24h TTL.

**Request:**
```typescript
{
  chain: GasChain               // "TRON" for MVP
  tier: GasFeeTier              // "SMALL" | "MEDIUM" | "LARGE"
  toAddress: string             // destination wallet address
  paymentNetwork: string        // "TRC20" for MVP
  userId?: string               // if logged in
}
```

**Response 201:**
```typescript
{
  success: true,
  data: {
    orderRef: string            // "GF-20240512-XXXX"
    paymentAddress: string      // platform's USDT deposit address
    paymentAmount: string       // "10.00" USDT
    paymentNetwork: string      // "TRC20"
    gasAmountNative: string     // "100" TRX
    chain: string               // "TRON"
    expiresAt: string           // ISO timestamp (5 min from now)
  }
}
```

**Error responses:**
```
400 INVALID_ADDRESS      — destination address fails chain format validation
400 CHAIN_NOT_SUPPORTED  — chain not yet enabled
400 GUEST_LIMIT_EXCEEDED — guest daily limit reached
503 GAS_UNAVAILABLE      — hot wallet balance below minimum threshold
```

---

### GET /api/gas-fee/orders/:orderRef

Poll order status.

**Auth:** None required

**Response 200:**
```typescript
{
  success: true,
  data: {
    orderRef: string
    status: GasFeeOrderStatus
    chain: string
    gasAmountNative: string
    toAddress: string
    deliveryTxHash?: string     // present when delivered
    deliveredAt?: string        // ISO timestamp
    failureReason?: string      // present when failed
    expiresAt: string
  }
}
```

---

### GET /api/gas-fee/prices

Get current prices for all enabled tiers.

**Auth:** None required

**Response 200:**
```typescript
{
  success: true,
  data: {
    TRON: {
      nativePriceUSD: "0.12",
      updatedAt: "2024-05-12T10:00:00Z",
      tiers: {
        SMALL:  { nativeAmount: "10",  chargeUSDT: "1.20" },
        MEDIUM: { nativeAmount: "50",  chargeUSDT: "5.50" },
        LARGE:  { nativeAmount: "100", chargeUSDT: "10.00" },
      }
    }
  }
}
```

---

### GET /api/gas-fee/orders/:orderRef/refund-status

Check refund status for expired/failed orders.

**Auth:** None required

---

## 9. Hot Wallet Architecture

### Phase 1 (TRC20/TRON MVP)

```
Gas Fee Hot Wallet (TRON):
  - Address: stored in GasHotWallet table
  - Private key: stored in AWS Secrets Manager
  - Secret name: "pakswap/gas-hot-wallet/tron"
  - Holds: TRX float for outgoing gas deliveries
  - Receives: USDT/TRC20 payments from users (SAME deposit address as P2P? NO — separate!)
```

> **CRITICAL:** Gas fee deposit addresses MUST be separate from P2P deposit addresses. Mixing creates reconciliation chaos. Create a separate USDT/TRC20 deposit address for gas fee payments.

### Hot Wallet Minimum Balance Thresholds

```typescript
const GAS_HOT_WALLET_THRESHOLDS: Record<GasChain, { pauseBelow: number; alertBelow: number }> = {
  TRON: {
    alertBelow: 5000,  // Alert admin when below 5,000 TRX
    pauseBelow: 1000,  // Auto-pause new orders when below 1,000 TRX (10 large orders)
  },
}
```

### Accessing Private Key for Automated Sends

```typescript
// services/gasFee/hotWallet.service.ts
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'

async function getGasWalletPrivateKey(chain: GasChain): Promise<string> {
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION })
  const secret = await client.send(new GetSecretValueCommand({
    SecretId: `pakswap/gas-hot-wallet/${chain.toLowerCase()}`,
  }))
  return JSON.parse(secret.SecretString!).privateKey
}
```

---

## 10. Automated Payout Pipeline

### BullMQ Job: `send-gas`

```typescript
// jobs/gasFee/sendGas.job.ts

async function sendGasJob(job: Job<{ orderId: string }>) {
  const { orderId } = job.data

  // Idempotency: check if already sent
  const alreadySent = await redis.get(`gas_sent:${orderId}`)
  if (alreadySent) return { skipped: true }

  const order = await db.gasFeeOrder.findUnique({ where: { id: orderId } })
  if (!order || order.status !== 'payment_detected') {
    logger.warn({ orderId, status: order?.status }, 'Gas send job: unexpected order state')
    return
  }

  // Mark as sending
  await db.gasFeeOrder.update({ where: { id: orderId }, data: { status: 'sending' } })

  try {
    const txHash = await sendNativeGas({
      chain: order.chain,
      toAddress: order.toAddress,
      amount: order.gasAmountNative,
    })

    await db.gasFeeOrder.update({
      where: { id: orderId },
      data: { status: 'delivered', deliveryTxHash: txHash, deliveredAt: new Date() },
    })

    // Mark idempotency
    await redis.set(`gas_sent:${orderId}`, txHash, 'EX', 86400)

  } catch (error) {
    const retryable = isRetryableError(error)

    await db.gasFeeOrder.update({
      where: { id: orderId },
      data: {
        status: retryable && order.retryCount < 3 ? 'payment_detected' : 'failed',
        retryCount: { increment: 1 },
        failureReason: error.message,
      },
    })

    if (!retryable || order.retryCount >= 3) {
      await alertAdmin('GAS_DELIVERY_FAILED', { orderId, error: error.message })
    }

    throw error // BullMQ will retry based on job options
  }
}

// Job options
gasFeeQueue.process('send-gas', sendGasJob, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 10000 }, // 10s, 20s, 40s
})
```

### TronWeb Send Implementation

```typescript
// services/gasFee/chains/tron.service.ts
import TronWeb from 'tronweb'

async function sendTRX(toAddress: string, amount: Decimal): Promise<string> {
  const privateKey = await getGasWalletPrivateKey('TRON')

  const tronWeb = new TronWeb({
    fullHost: process.env.TRON_FULL_NODE_URL, // e.g., https://api.trongrid.io
    privateKey,
  })

  // Validate address before sending
  if (!tronWeb.isAddress(toAddress)) throw new AppError('INVALID_TRON_ADDRESS')

  // Convert TRX to SUN (1 TRX = 1,000,000 SUN)
  const amountSun = tronWeb.toSun(amount.toNumber())

  const tx = await tronWeb.trx.sendTransaction(toAddress, amountSun)

  if (!tx.result) throw new Error(`TRX send failed: ${JSON.stringify(tx)}`)

  return tx.txid
}
```

---

## 11. Abuse Prevention & Rate Limiting

### Guest Order Limits

```typescript
// Per IP address, stored in Redis:
const GUEST_DAILY_LIMIT_USD = 10
const GUEST_HOURLY_ORDERS = 3
const GUEST_SAME_ADDRESS_DAILY = 2 // Max 2 orders to same destination per day (guest)

// Redis keys:
// guest_spend:{ip}:{date}     → total USD spent today (TTL: 24h)
// guest_orders:{ip}:{hour}    → order count this hour (TTL: 1h)
// gas_dest:{toAddress}:{date} → orders to this address today (TTL: 24h)
```

### Authenticated User Limits

```typescript
const AUTH_DAILY_LIMIT_USD = 100
const AUTH_HOURLY_ORDERS = 10
```

### Suspicious Patterns → Auto-Flag

```typescript
// Flag for admin review (do NOT block, just flag):
// 1. Same destination address in >5 orders from different IPs in 1 hour
// 2. Guest orders that exactly match $10 limit multiple times per day (different IPs, same destination)
// 3. Orders where payment comes from a known exchange hot wallet address

async function checkGasFeeAbuse(order: GasFeeOrder): Promise<void> {
  const destOrderCount = await redis.incr(`gas_dest:${order.toAddress}:${todayDate()}`)
  if (destOrderCount > 5) {
    await flagForReview(order.id, 'HIGH_DESTINATION_FREQUENCY')
  }
}
```

---

## 12. Failure Recovery & Refund Logic

### Scenario 1: Payment Received After Order Expiry

```
User sends USDT but order already expired (status = expired).
Webhook still fires → no matching pending order found.
→ Create "unattributed gas payment" record
→ Admin sees in /admin/gas/unattributed
→ Admin manually refunds or attributes to new order
```

### Scenario 2: Delivery Failed — Max Retries Exceeded

```
send-gas job fails 3 times → order.status = 'failed'
→ Alert admin immediately
→ Admin manually:
  a) Top up hot wallet and retry via /admin/gas/orders/:id/retry
  b) Or mark as 'refunded' and send USDT back manually
→ System records failureReason and adminNote
```

### Scenario 3: Hot Wallet Balance Below Pause Threshold

```
GasHotWallet.balance < pauseBelow (1,000 TRX)
→ New orders for that chain return 503 GAS_UNAVAILABLE
→ Admin alerted via email + dashboard badge
→ Existing pending orders continue processing (no cancellation)
→ Admin tops up hot wallet → sets isActive = true → orders resume
```

### Scenario 4: TRX Price Drops 10%+ Mid-Order

```
Order created at TRX = $0.12
Payment detected; TRX now $0.10
Platform absorbs the loss (within the 5-minute window, this is expected)
If gap is >20%: Log for review but still deliver (user experience > small loss)
```

### Refund Process

```typescript
// Manual refund by admin:
// POST /api/admin/gas-fee/orders/:id/refund

async function refundGasFeeOrder(orderId: string, adminId: string): Promise<void> {
  const order = await db.gasFeeOrder.findUnique({ where: { id: orderId } })
  if (!['failed', 'expired'].includes(order.status)) throw new AppError('CANNOT_REFUND_IN_THIS_STATE')

  // Admin manually sends USDT back from hot wallet (no automation in Phase 1)
  // Admin records the refund TX hash

  await db.gasFeeOrder.update({
    where: { id: orderId },
    data: { status: 'refunded', refundedAt: new Date() },
  })

  await db.auditLog.create({
    data: { action: 'GAS_FEE_REFUND', adminId, targetId: orderId, metadata: { orderId } },
  })
}
```

---

## 13. Admin Panel Integration

### New Admin Pages

**`/admin/gas`** — Gas fee operations dashboard

```
Metrics bar:
  [Total Orders Today: 47]  [Revenue Today: $42.30]  [Pending: 2]  [Failed: 0]

TRX Hot Wallet Balance:
  [Current: 8,450 TRX]  [≈ $1,014 USD]  [Status: ✅ Healthy]
  [Alert threshold: 5,000 TRX]  [Pause threshold: 1,000 TRX]

Recent Orders (last 50):
  OrderRef | Chain | Tier | Amount | Status | Created | Actions
  GF-001   | TRON  | LG   | 10USDT | ✅ Delivered | 2min ago | [View]
  GF-002   | TRON  | SM   | 1.20USDT | ⏳ Sending | 1min ago | [View]

[Unattributed Payments Tab] [Failed Orders Tab] [All Orders Tab]
```

**`/admin/gas/orders/:orderRef`** — Order detail

```
Order: GF-20240512-4729
Status: DELIVERED ✅

Chain: TRON | Tier: LARGE | TRX Sent: 100 TRX
Payment: 10.00 USDT/TRC20 received at TX: abc...xyz
Delivery: TX: def...uvw | Confirmed: Yes
Destination: TXxxxx...xxxx
Duration: 18 seconds

[Retry] [Refund] [Add Admin Note]
```

### Admin Actions

| Action | Route | Auth Level |
|--------|-------|-----------|
| View all orders | GET /admin/gas/orders | admin |
| View order detail | GET /admin/gas/orders/:ref | admin |
| Retry failed order | POST /admin/gas/orders/:id/retry | admin |
| Manual refund | POST /admin/gas/orders/:id/refund | admin |
| Update hot wallet balance | POST /admin/gas/wallets/:chain/balance | super_admin |
| Pause/resume chain | POST /admin/gas/chains/:chain/toggle | super_admin |
| View unattributed payments | GET /admin/gas/unattributed | admin |
| Attribute payment to order | POST /admin/gas/unattributed/:id/attribute | admin |

---

## 14. Monitoring & Alerting

### BullMQ Queue: `gas-fee`

Jobs in this queue (all priority 1 — user is waiting):

| Job | Trigger | Timeout |
|-----|---------|---------|
| `send-gas` | Payment detected | 2 minutes |
| `expire-order` | 5 minutes after creation | — |
| `check-delivery` | 60s after send-gas | — |
| `monitor-balances` | Every 5 minutes (repeatable) | — |

### Alert Rules

```typescript
// alerts/gasFee.alerts.ts

// CRITICAL — page immediately
if (hotWalletBalance < pauseBelow) alertAdmin('GAS_WALLET_CRITICAL', { chain, balance })
if (order.retryCount >= 3) alertAdmin('GAS_DELIVERY_MAX_RETRIES', { orderId })

// HIGH — within 1 hour
if (hotWalletBalance < alertBelow) alertAdmin('GAS_WALLET_LOW', { chain, balance })
if (unattributedPayments.count > 5) alertAdmin('GAS_UNATTRIBUTED_BACKLOG', { count })

// INFO — daily digest
dailyDigest.add({ metric: 'gas_orders', count: todayOrders, revenue: todayRevenue })
```

### Delivery Confirmation Job

```typescript
// jobs/gasFee/checkDelivery.job.ts
// Runs 60 seconds after send-gas completes

async function checkGasDelivery(job: Job<{ orderId: string; txHash: string }>) {
  const confirmed = await checkTxConfirmation(job.data.txHash, 'TRON')

  if (confirmed) {
    await db.gasFeeOrder.update({
      where: { id: job.data.orderId },
      data: { deliveryConfirmed: true },
    })
  } else {
    // Re-check in 60s (max 10 retries = 10 minutes)
    if (job.attemptsMade < 10) throw new Error('NOT_CONFIRMED_YET')
    else alertAdmin('GAS_DELIVERY_UNCONFIRMED', { orderId: job.data.orderId })
  }
}
```

---

## 15. Environment Variables

```bash
# Gas Fee System — TRC20/TRON MVP
TRON_FULL_NODE_URL=https://api.trongrid.io
TRON_SOLIDITY_NODE_URL=https://api.trongrid.io
TRON_EVENT_SERVER_URL=https://api.trongrid.io
TRONGRID_API_KEY=your_trongrid_api_key

# AWS Secrets Manager (private keys stored here, NOT in .env)
GAS_WALLET_SECRET_ARN_TRON=arn:aws:secretsmanager:...

# Deposit addresses (public — safe in env)
GAS_FEE_DEPOSIT_ADDRESS_TRC20=TXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Gas hot wallet thresholds
GAS_WALLET_ALERT_THRESHOLD_TRON=5000
GAS_WALLET_PAUSE_THRESHOLD_TRON=1000

# Rate limits
GAS_GUEST_DAILY_LIMIT_USD=10
GAS_AUTH_DAILY_LIMIT_USD=100

# Pricing
GAS_MARKUP_MULTIPLIER_TRON=1.50

# Price feed (reuse from P2P system)
# BINANCE_API_KEY already defined in main .env
# Add CoinGecko as fallback:
COINGECKO_API_KEY=your_coingecko_key
```

---

## 16. Phase Roadmap

### Phase 1 (MVP — Weeks 1-3 after P2P launch)

- [ ] TRC20/TRON only (TRX gas)
- [ ] Manual refund process (admin sends USDT back)
- [ ] Guest orders (no account required) up to $10/day
- [ ] Admin dashboard `/admin/gas`
- [ ] Hot wallet balance monitoring + alerting
- [ ] 3 fixed tiers (10/50/100 TRX)

### Phase 2 (3-6 months after P2P launch)

- [ ] BSC/BNB gas (BEP20 USDT payment)
- [ ] Ethereum ETH gas (Fireblocks required for automation)
- [ ] Automated refunds (platform auto-returns USDT for failed orders)
- [ ] Authenticated user order history page
- [ ] Higher tiers (200 TRX, 500 TRX for high-volume users)
- [ ] API for merchant integration (other apps can call PakSwap gas API)

### Phase 3 (6-12 months)

- [ ] Solana, Polygon, Arbitrum, Base, TON support
- [ ] Card payment (Stripe/local gateway) for non-crypto users
- [ ] Bulk orders for merchants (1,000+ TRX in single order)
- [ ] White-label API for exchanges and wallets
- [ ] Subscription model (100 TRX/day auto-delivery for monthly fee)

---

*Document version: 1.0*
*Created: 2026-05-12*
*Next review: after Phase 1 launch*
*Related: FULL_SPEC.md Section 31, DB_TRANSACTION_RULES.md*
