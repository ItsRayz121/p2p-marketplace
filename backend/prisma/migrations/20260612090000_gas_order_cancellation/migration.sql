-- Gas order cancellation + abuse-ladder support.
-- Adds a user-initiated `cancelled` terminal status, cancellation metadata on the
-- order, and an event table that drives the escalating cooldown ladder.

-- ── New terminal status ───────────────────────────────────────────────────────
ALTER TYPE "GasFeeOrderStatus" ADD VALUE IF NOT EXISTS 'cancelled';

-- ── Order cancellation metadata ───────────────────────────────────────────────
ALTER TABLE "GasFeeOrder" ADD COLUMN "cancelledAt" TIMESTAMP(3);
ALTER TABLE "GasFeeOrder" ADD COLUMN "cancelReason" TEXT;

-- ── Cancellation event log (drives the 7-day rolling cooldown ladder) ─────────
CREATE TABLE "GasCancellationEvent" (
  "id"        TEXT NOT NULL,
  "identity"  TEXT NOT NULL,
  "userId"    TEXT,
  "ipAddress" TEXT,
  "orderId"   TEXT NOT NULL,
  "orderRef"  TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GasCancellationEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GasCancellationEvent_identity_createdAt_idx"
  ON "GasCancellationEvent"("identity", "createdAt");
