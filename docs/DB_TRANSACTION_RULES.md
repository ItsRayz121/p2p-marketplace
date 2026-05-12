# DB_TRANSACTION_RULES.md — PakSwap Database Transaction Safety
## Atomic Operation Catalog · Version 1.0 · 2026-05-12

> **Relationship to FULL_SPEC.md:** This is a satellite document. FULL_SPEC.md Section 32 contains the summary rule. This file contains every operation that requires `db.$transaction()`, with implementation patterns and the race conditions they prevent.
>
> **Rule (non-negotiable):** Any service method that reads a balance/limit/counter AND writes to it in the same logical operation MUST use `db.$transaction()`. No exceptions.

---

## Table of Contents

| Section | Topic |
|---------|-------|
| 1 | Why This Matters — The Race Condition Problem |
| 2 | Prisma Transaction Patterns |
| 3 | Critical Operations Catalog |
| 4 | Non-Obvious Operations That Also Need Transactions |
| 5 | Operations That Do NOT Need Transactions |
| 6 | Testing Transaction Safety |
| 7 | Redis Atomic Operations |
| 8 | Quick Reference Table |

---

## 1. Why This Matters — The Race Condition Problem

PostgreSQL without explicit transactions allows concurrent requests to interleave. Consider the daily trading limit check:

```
Time 0ms:  Request A reads dailyBuyUsed = 45,000 PKR, limit = 50,000 PKR → 5,000 remaining
Time 1ms:  Request B reads dailyBuyUsed = 45,000 PKR (same value, A hasn't written yet)
Time 2ms:  Request A: 45,000 + 5,000 = 50,000 ≤ 50,000 → passes limit check
Time 2ms:  Request B: 45,000 + 5,000 = 50,000 ≤ 50,000 → passes limit check
Time 3ms:  Request A writes dailyBuyUsed = 50,000 ✓
Time 4ms:  Request B writes dailyBuyUsed = 50,000 (overwrites A's value!)
```

Result: User executed TWO 5,000 PKR trades but dailyBuyUsed only shows 50,000 PKR (should be 55,000). User spent 5,000 PKR more than their limit. This is real financial loss.

**The fix:** Read and write inside a transaction with row-level locking (`SELECT FOR UPDATE`). Only one transaction can hold the lock at a time — the second one waits.

---

## 2. Prisma Transaction Patterns

### Pattern A: Read-Lock-Modify (for balance/limit operations)

```typescript
await db.$transaction(async (tx) => {
  // Lock the row so no other transaction can read it until this commits
  const [user] = await tx.$queryRaw<User[]>`
    SELECT "dailyBuyUsed", "dailyBuyLimit" 
    FROM "User" 
    WHERE id = ${userId} 
    FOR UPDATE
  `
  // Now safe to check and update — no other request can interleave
  if (user.dailyBuyUsed + amount > user.dailyBuyLimit) {
    throw new AppError('DAILY_LIMIT_EXCEEDED')
  }
  await tx.user.update({
    where: { id: userId },
    data: { dailyBuyUsed: { increment: amount } },
  })
  const trade = await tx.trade.create({ data: tradeData })
  return trade
})
```

### Pattern B: Atomic Increment (for counters, no lock needed)

```typescript
// Safe: Prisma's `increment` maps to SQL `SET col = col + N` which is atomic per row
await db.tradeStats.upsert({
  where: { userId },
  create: { userId, totalTrades: 1, completedTrades: 1 },
  update: {
    totalTrades: { increment: 1 },
    completedTrades: { increment: 1 },
  },
})
// NOTE: use this ONLY when you don't need to check the value before incrementing.
// If you check AND increment, use Pattern A instead.
```

### Pattern C: Status Guard (for state machine transitions)

```typescript
await db.$transaction(async (tx) => {
  const entity = await tx.entity.findUnique({
    where: { id },
    select: { status: true },
  })
  // Check current state inside transaction — prevents two concurrent transitions
  if (entity.status !== 'expected_state') {
    throw new AppError('INVALID_STATE_TRANSITION')
  }
  await tx.entity.update({
    where: { id },
    data: { status: 'new_state' },
  })
})
```

### Transaction Configuration

```typescript
// For operations involving wallet balances, use a longer timeout and serializable isolation:
await db.$transaction(
  async (tx) => { /* ... */ },
  {
    maxWait: 5000,    // Wait up to 5s to acquire a connection
    timeout: 10000,   // Transaction must complete within 10s
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable, // For financial ops
  }
)
```

---

## 3. Critical Operations Catalog

### 3.1 Trade Creation — Daily Limit Race Condition

**File:** `services/trade/trade.service.ts`
**Race condition prevented:** Two simultaneous trades both pass the limit check and both get created, causing user to exceed their daily KYC limit.

```typescript
async function createTrade(userId: string, adId: string, amount: number): Promise<Trade> {
  return await db.$transaction(async (tx) => {
    // Step 1: Lock user row
    const [user] = await tx.$queryRaw<Pick<User, 'dailyBuyUsed' | 'dailyBuyLimit' | 'kycLevel'>[]>`
      SELECT "dailyBuyUsed", "dailyBuyLimit", "kycLevel"
      FROM "User"
      WHERE id = ${userId}
      FOR UPDATE
    `

    // Step 2: Validate limit atomically
    if (user.dailyBuyUsed + amount > user.dailyBuyLimit) {
      throw new AppError('DAILY_LIMIT_EXCEEDED', `Daily limit: PKR ${user.dailyBuyLimit}`)
    }

    // Step 3: Lock the ad to check availability
    const [ad] = await tx.$queryRaw<Pick<Ad, 'status' | 'availableAmount'>[]>`
      SELECT status, "availableAmount"
      FROM "Ad"
      WHERE id = ${adId}
      FOR UPDATE
    `
    if (ad.status !== 'active') throw new AppError('AD_UNAVAILABLE')
    if (ad.availableAmount < amount) throw new AppError('INSUFFICIENT_AD_LIQUIDITY')

    // Step 4: Create trade and update limit together
    const trade = await tx.trade.create({ data: { userId, adId, amount, status: 'payment_pending' } })
    await tx.user.update({
      where: { id: userId },
      data: { dailyBuyUsed: { increment: amount } },
    })
    await tx.ad.update({
      where: { id: adId },
      data: { availableAmount: { decrement: amount } },
    })

    return trade
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
}
```

---

### 3.2 Collateral Lock — Insufficient Balance Race Condition

**File:** `services/collateral/collateral.service.ts`
**Race condition prevented:** User creates two trades simultaneously; both pass the balance check but together would over-lock their collateral.

```typescript
async function lockCollateral(userId: string, coin: string, amount: number): Promise<CollateralLock> {
  return await db.$transaction(async (tx) => {
    // Lock wallet row
    const [wallet] = await tx.$queryRaw<Pick<Wallet, 'balance' | 'lockedBalance'>[]>`
      SELECT balance, "lockedBalance"
      FROM "Wallet"
      WHERE "userId" = ${userId} AND coin = ${coin}
      FOR UPDATE
    `

    const available = wallet.balance - wallet.lockedBalance
    if (available < amount) {
      throw new AppError('INSUFFICIENT_COLLATERAL', `Available: ${available} ${coin}`)
    }

    await tx.wallet.update({
      where: { userId_coin: { userId, coin } },
      data: { lockedBalance: { increment: amount } },
    })

    const lock = await tx.collateralLock.create({
      data: { userId, coin, amount, status: 'locked' },
    })

    return lock
  })
}
```

---

### 3.3 Withdrawal Approval (Two-Person Rule) — Double-Spend & Double-Approval Race Condition

**File:** `services/withdrawal/withdrawal.service.ts`
**Race condition prevented:**
- (a) Two admins approve simultaneously → balance deducted twice
- (b) Same admin approves both first and second approval

```typescript
async function approveWithdrawal(withdrawalId: string, adminId: string): Promise<Withdrawal> {
  return await db.$transaction(async (tx) => {
    // Lock withdrawal row — prevents two concurrent approvals
    const [withdrawal] = await tx.$queryRaw<Withdrawal[]>`
      SELECT *
      FROM "Withdrawal"
      WHERE id = ${withdrawalId}
      FOR UPDATE
    `

    // Validate state
    const validStates = ['pending', 'first_approved']
    if (!validStates.includes(withdrawal.status)) {
      throw new AppError('INVALID_WITHDRAWAL_STATE', `Current state: ${withdrawal.status}`)
    }

    // Prevent same-admin double approval
    if (withdrawal.firstApprovedBy === adminId) {
      throw new AppError('SAME_ADMIN_CANNOT_APPROVE_TWICE', 'A different admin must give second approval')
    }

    const isSecondApproval = withdrawal.status === 'first_approved'

    if (isSecondApproval) {
      // Lock wallet and deduct atomically
      const [wallet] = await tx.$queryRaw<Wallet[]>`
        SELECT balance FROM "Wallet"
        WHERE "userId" = ${withdrawal.userId} AND coin = ${withdrawal.coin}
        FOR UPDATE
      `
      if (wallet.balance < withdrawal.amount) {
        throw new AppError('INSUFFICIENT_BALANCE', 'Balance changed since first approval')
      }

      await tx.wallet.update({
        where: { userId_coin: { userId: withdrawal.userId, coin: withdrawal.coin } },
        data: { balance: { decrement: withdrawal.amount } },
      })
      await tx.withdrawal.update({
        where: { id: withdrawalId },
        data: { status: 'approved', secondApprovedBy: adminId, secondApprovedAt: new Date() },
      })
    } else {
      await tx.withdrawal.update({
        where: { id: withdrawalId },
        data: { status: 'first_approved', firstApprovedBy: adminId, firstApprovedAt: new Date() },
      })
    }

    return await tx.withdrawal.findUnique({ where: { id: withdrawalId } })
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
}
```

---

### 3.4 Referral Reward Claim — Daily Cap Race Condition

**File:** `services/referral/referral.service.ts`
**Race condition prevented:** Multiple referral rewards complete simultaneously; all pass the daily cap check and all get paid, exceeding the cap.

```typescript
async function claimReferralReward(rewardId: string): Promise<ReferralReward> {
  return await db.$transaction(async (tx) => {
    // Lock reward row
    const [reward] = await tx.$queryRaw<ReferralReward[]>`
      SELECT * FROM "ReferralReward"
      WHERE id = ${rewardId}
      FOR UPDATE
    `

    if (reward.status !== 'pending') {
      throw new AppError('REWARD_ALREADY_PROCESSED')
    }

    // Check daily cap (read inside transaction for consistency)
    const todayStart = startOfDayPKT()
    const todayPaidCount = await tx.referralReward.count({
      where: {
        referrerId: reward.referrerId,
        status: 'paid',
        paidAt: { gte: todayStart },
      },
    })

    const MAX_DAILY_REFERRAL_REWARDS = 10 // from platformConfig
    if (todayPaidCount >= MAX_DAILY_REFERRAL_REWARDS) {
      throw new AppError('REFERRAL_DAILY_CAP_REACHED')
    }

    // Atomically mark as paid and credit wallet
    await tx.referralReward.update({
      where: { id: rewardId },
      data: { status: 'paid', paidAt: new Date() },
    })

    await tx.wallet.update({
      where: { userId_coin: { userId: reward.referrerId, coin: 'USDT' } },
      data: { balance: { increment: reward.amount } },
    })

    return await tx.referralReward.findUnique({ where: { id: rewardId } })
  })
}
```

---

### 3.5 Instant Buy Balance Credit — Duplicate Webhook Race Condition

**File:** `services/instantBuy/payment.service.ts`
**Race condition prevented:** Webhook fires twice (network retry) → balance credited twice.

```typescript
async function creditInstantBuyPayment(orderId: string, txHash: string): Promise<void> {
  // First check Redis dedup (fast path — avoids DB transaction overhead on duplicates)
  const alreadyProcessed = await redis.get(`webhook_event:${txHash}`)
  if (alreadyProcessed) {
    logger.info({ txHash }, 'Webhook duplicate — skipping')
    return
  }

  await db.$transaction(async (tx) => {
    // Lock order row
    const [order] = await tx.$queryRaw<InstantBuyOrder[]>`
      SELECT * FROM "InstantBuyOrder"
      WHERE id = ${orderId}
      FOR UPDATE
    `

    if (order.status !== 'pending') {
      logger.warn({ orderId, status: order.status }, 'Order not pending on payment credit')
      return
    }

    await tx.instantBuyOrder.update({
      where: { id: orderId },
      data: { status: 'payment_detected', paymentTxHash: txHash },
    })
  })

  // Mark dedup after successful transaction (24h TTL)
  await redis.set(`webhook_event:${txHash}`, orderId, 'EX', 86400)
}
```

---

### 3.6 Trade Cancellation — State Transition Race Condition

**File:** `services/trade/trade.service.ts`
**Race condition prevented:** Admin confirms payment at the same instant buyer cancels → trade ends up in inconsistent state (both confirmed AND cancelled).

```typescript
async function cancelTrade(tradeId: string, cancelledBy: string, reason: string): Promise<Trade> {
  return await db.$transaction(async (tx) => {
    const [trade] = await tx.$queryRaw<Trade[]>`
      SELECT * FROM "Trade" WHERE id = ${tradeId} FOR UPDATE
    `

    const cancellableStates = ['payment_pending', 'payment_uploaded']
    if (!cancellableStates.includes(trade.status)) {
      throw new AppError('TRADE_CANNOT_BE_CANCELLED', `Trade is in ${trade.status} state`)
    }

    await tx.trade.update({
      where: { id: tradeId },
      data: { status: 'cancelled', cancelledBy, cancelReason: reason, cancelledAt: new Date() },
    })

    // Restore daily limit
    await tx.user.update({
      where: { id: trade.buyerId },
      data: { dailyBuyUsed: { decrement: trade.amount } },
    })

    // Restore ad availability
    await tx.ad.update({
      where: { id: trade.adId },
      data: { availableAmount: { increment: trade.amount } },
    })

    return await tx.trade.findUnique({ where: { id: tradeId } })
  })
}
```

---

### 3.7 Merchant Collateral Seizure — Balance Integrity

**File:** `services/collateral/seizure.service.ts`
**Race condition prevented:** Collateral seizure runs while merchant is also withdrawing remaining balance → balance goes negative.

```typescript
async function seizeCollateral(merchantId: string, seizureAmount: number, reason: string): Promise<void> {
  return await db.$transaction(async (tx) => {
    // Lock both wallet and collateral lock rows
    const [wallet] = await tx.$queryRaw<Wallet[]>`
      SELECT * FROM "Wallet"
      WHERE "userId" = ${merchantId} AND coin = 'USDT'
      FOR UPDATE
    `

    const activeCollateral = await tx.collateralLock.findMany({
      where: { userId: merchantId, status: 'locked' },
    })

    const totalLocked = activeCollateral.reduce((sum, c) => sum + Number(c.amount), 0)
    if (totalLocked < seizureAmount) {
      // Seize what's available + notify admin
      seizureAmount = totalLocked
    }

    await tx.wallet.update({
      where: { userId_coin: { userId: merchantId, coin: 'USDT' } },
      data: {
        lockedBalance: { decrement: seizureAmount },
        balance: { decrement: seizureAmount },
      },
    })

    await tx.collateralLock.updateMany({
      where: { userId: merchantId, status: 'locked' },
      data: { status: 'seized' },
    })

    await tx.auditLog.create({
      data: { action: 'COLLATERAL_SEIZED', targetId: merchantId, metadata: { seizureAmount, reason } },
    })
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
}
```

---

## 4. Non-Obvious Operations That Also Need Transactions

### 4.1 KYC Level Upgrade — Limit Update Must Be Atomic

When admin approves KYC Level 2, the daily limits must update in the same transaction as the KYC status:

```typescript
await db.$transaction(async (tx) => {
  await tx.user.update({
    where: { id: userId },
    data: {
      kycLevel: 2,
      kycStatus: 'approved',
      dailyBuyLimit: KYC_LEVEL_2_DAILY_LIMIT,    // Atomic with KYC approval
      dailySellLimit: KYC_LEVEL_2_DAILY_LIMIT,
      kycApprovedAt: new Date(),
      kycApprovedBy: adminId,
    },
  })
  await tx.kycSubmission.update({
    where: { id: submissionId },
    data: { status: 'approved', reviewedBy: adminId, reviewedAt: new Date() },
  })
})
```

### 4.2 Badge Recalculation — Prevent Notification Without Badge

If badge update and notification are separate operations, a crash between them sends a notification for a badge that wasn't saved:

```typescript
await db.$transaction(async (tx) => {
  const newBadge = computeNewBadge(tradeStats)
  const currentBadge = await tx.user.findUnique({ where: { id: userId }, select: { badge: true } })

  if (currentBadge.badge !== newBadge) {
    await tx.user.update({ where: { id: userId }, data: { badge: newBadge } })
    await tx.notification.create({
      data: { userId, type: 'BADGE_UPGRADE', metadata: { from: currentBadge.badge, to: newBadge } },
    })
  }
})
```

### 4.3 Deposit Credit — Idempotent Credit with Status Guard

```typescript
await db.$transaction(async (tx) => {
  const [order] = await tx.$queryRaw<InstantBuyOrder[]>`
    SELECT * FROM "InstantBuyOrder" WHERE id = ${orderId} FOR UPDATE
  `
  // If already credited, skip silently
  if (order.status !== 'pending') return

  await tx.wallet.update({
    where: { userId_coin: { userId: order.userId, coin: order.coin } },
    data: { balance: { increment: order.amount } },
  })
  await tx.instantBuyOrder.update({
    where: { id: orderId },
    data: { status: 'credited', creditedAt: new Date() },
  })
})
```

---

## 5. Operations That Do NOT Need Transactions

These are safe to run without `db.$transaction()`:

| Operation | Why It's Safe |
|-----------|--------------|
| `ad.create()` — create a new ad | No concurrent read-modify-write; just insert |
| `user.findMany()` — read-only queries | Reads are always safe |
| `notification.create()` — create notification | Append-only; no balance involved |
| `auditLog.create()` — create audit log | Append-only; no balance involved |
| `tradeStats.update({ totalTrades: { increment: 1 } })` | Atomic increment; no pre-check needed |
| `platformConfig.update()` — admin config changes | Single-row update by super_admin only |
| `user.update({ lastSeenAt: new Date() })` | Last-write-wins is acceptable |

---

## 6. Testing Transaction Safety

### Unit Test: Concurrent Limit Check

```typescript
// tests/unit/trade.service.test.ts
describe('trade creation concurrent limit check', () => {
  it('prevents double-spend when two trades submitted simultaneously within limit', async () => {
    // Setup: user with PKR 10,000 remaining of daily limit
    const user = await createTestUser({ dailyBuyLimit: 50000, dailyBuyUsed: 40000 })
    const ad = await createTestAd({ amount: 10000 })

    // Fire two trades simultaneously
    const [result1, result2] = await Promise.allSettled([
      tradeService.createTrade(user.id, ad.id, 10000),
      tradeService.createTrade(user.id, ad.id, 10000),
    ])

    // Exactly one should succeed
    const successes = [result1, result2].filter(r => r.status === 'fulfilled')
    const failures = [result1, result2].filter(r => r.status === 'rejected')

    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect((failures[0] as PromiseRejectedResult).reason.code).toBe('DAILY_LIMIT_EXCEEDED')

    // Daily used should be exactly 50,000
    const updatedUser = await db.user.findUnique({ where: { id: user.id } })
    expect(updatedUser.dailyBuyUsed).toBe(50000)
  })
})
```

### Integration Test: Withdrawal Double-Approval

```typescript
describe('withdrawal two-person approval', () => {
  it('rejects same admin approving twice', async () => {
    const withdrawal = await createTestWithdrawal({ status: 'first_approved', firstApprovedBy: 'admin-1' })

    await expect(
      withdrawalService.approveWithdrawal(withdrawal.id, 'admin-1')
    ).rejects.toThrow('SAME_ADMIN_CANNOT_APPROVE_TWICE')
  })
})
```

---

## 7. Redis Atomic Operations

Some counters live in Redis instead of PostgreSQL. These also need atomic operations.

### Pattern: INCR + Check

```typescript
// Redis INCR is atomic — safe for rate limiting counters
const key = `daily_trades:${userId}:${todayDate()}`
const count = await redis.incr(key)
await redis.expire(key, 86400) // Set TTL on first increment

if (count > MAX_DAILY_TRADES) {
  await redis.decr(key) // Roll back
  throw new AppError('DAILY_TRADE_LIMIT')
}
```

### Pattern: SET NX (Mutex Lock)

```typescript
// Prevent two workers from processing same job simultaneously
const lockKey = `processing:${orderId}`
const acquired = await redis.set(lockKey, '1', 'EX', 60, 'NX') // NX = only set if not exists

if (!acquired) {
  logger.info({ orderId }, 'Another worker is processing this order — skipping')
  return
}

try {
  // Do work
} finally {
  await redis.del(lockKey) // Always release lock
}
```

---

## 8. Quick Reference Table

| Operation | File | Transaction Type | Race Prevented |
|-----------|------|-----------------|----------------|
| Create trade | `trade.service.ts` | Pattern A (SELECT FOR UPDATE) | Daily limit double-spend |
| Lock collateral | `collateral.service.ts` | Pattern A (SELECT FOR UPDATE) | Negative collateral balance |
| First approval (withdrawal) | `withdrawal.service.ts` | Pattern C (status guard) | Duplicate first approval |
| Second approval (withdrawal) | `withdrawal.service.ts` | Pattern A + C | Double-spend + same-admin |
| Claim referral reward | `referral.service.ts` | Pattern A (daily cap check) | Cap exceeded concurrently |
| Credit instant buy payment | `payment.service.ts` | Pattern C + Redis dedup | Duplicate webhook credit |
| Cancel trade | `trade.service.ts` | Pattern C (state guard) | Cancel-while-confirming |
| Seize collateral | `seizure.service.ts` | Pattern A (SELECT FOR UPDATE) | Negative balance on seizure |
| KYC level upgrade | `kyc.service.ts` | Simple transaction | Limit update atomicity |
| Badge recalculation | `badge.service.ts` | Simple transaction | Badge/notification split-brain |

---

*Document version: 1.0*
*Created: 2026-05-12*
*Next review: before first production deploy*
*Related: FULL_SPEC.md Section 32, GAS_FEE_SPEC.md Section 10*
