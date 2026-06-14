-- Interactive refund window for delivery-failed gas orders.
-- Adds an `awaiting_refund` holding state (delivery failed, system still retrying;
-- user can request an immediate refund once the window elapses) plus the
-- `refundEligibleAt` timestamp that gates the user-facing "Request Refund" button.

-- ── New holding status (delivery failed → awaiting refund window) ─────────────
ALTER TYPE "GasFeeOrderStatus" ADD VALUE IF NOT EXISTS 'awaiting_refund';

-- ── Refund-eligibility gate ───────────────────────────────────────────────────
ALTER TABLE "GasFeeOrder" ADD COLUMN "refundEligibleAt" TIMESTAMP(3);
