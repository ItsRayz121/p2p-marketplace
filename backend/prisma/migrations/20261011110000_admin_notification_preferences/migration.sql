-- Per-admin notification delivery preferences + a preference bucket on each notification record.

-- 1) Bucket column on the shared notification record (nullable; legacy rows are backfilled below).
ALTER TABLE "AdminNotification" ADD COLUMN "prefGroup" TEXT;

-- 2) Backfill — mirrors classifyNotification() in src/lib/adminNotifGroups.ts rule-for-rule.
UPDATE "AdminNotification" SET "prefGroup" = CASE
  WHEN "title" ~* 'new support message|refund address submitted|user report' OR "href" LIKE '/admin/support%' THEN 'support'
  WHEN "title" ~* 'affiliate' OR "href" LIKE '/admin/gas/affiliates%' THEN 'affiliates'
  WHEN "title" ~* 'share & earn|giveaway|promo code'
    OR "href" ~ '^/admin/(gas/share-rewards|promo-giveaways|gas/giveaways|gas/promo-codes|gas/free-codes|tasks)' THEN 'promotions'
  WHEN "category"::text = 'DISPUTE' OR "title" ~* 'dispute' THEN 'disputes'
  WHEN "category"::text = 'KYC' OR "title" ~* 'maker application|new kyc' OR "href" = '/admin/makers' THEN 'kyc'
  WHEN "title" ~* 'instant buy' OR "href" = '/admin/instant-buy' THEN 'payment_review'
  WHEN "category"::text = 'GAS' AND "title" ~* 'proof|exchange transfer|payment detected|ambiguous|payment may be undetected|unattributed' THEN 'payment_review'
  WHEN "category"::text = 'GAS' THEN 'gas_orders'
  WHEN "category"::text IN ('DEPOSIT', 'WITHDRAWAL') THEN 'payment_review'
  WHEN "category"::text = 'TRADE' THEN 'usdt_trades'
  WHEN "category"::text = 'CTM' THEN 'ctm_trades'
  ELSE 'system'
END;

CREATE INDEX "AdminNotification_prefGroup_createdAt_idx" ON "AdminNotification"("prefGroup", "createdAt");

-- 3) Per-admin preferences.
CREATE TABLE "AdminNotificationPreference" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "prefs"     JSONB NOT NULL DEFAULT '{}',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdminNotificationPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminNotificationPreference_userId_key" ON "AdminNotificationPreference"("userId");
