-- Structured support messages: admin-issued refund-address requests + user answers.
ALTER TABLE "SupportMessage" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'text';
ALTER TABLE "SupportMessage" ADD COLUMN "metadata" JSONB;

-- Refund destination the user supplies via the in-chat form (pre-fills admin manual refund).
ALTER TABLE "GasFeeOrder" ADD COLUMN "suggestedRefundAddress" TEXT;
ALTER TABLE "GasFeeOrder" ADD COLUMN "suggestedRefundNetwork" TEXT;
