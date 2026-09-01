-- Seller "payment not received" / reject-proof flow (USDT + CTM).
--
-- When the buyer has uploaded payment proof but the seller never received the
-- money (fake screenshot, wrong amount, wrong account, still pending in the
-- banking rails), the seller can bounce the proof back to the unpaid rung with a
-- justification instead of wrongly confirming or opening a full dispute. The
-- buyer then re-uploads correct proof or opens a dispute if the seller is lying.
--
-- proofRejectionCount is capped by PlatformConfig `trade_proof_reject_max`
-- (default 2). The rejection AFTER the cap auto-opens a dispute instead of
-- bouncing, so a stalling seller can't trap a buyer who really paid.

ALTER TABLE "Trade"    ADD COLUMN IF NOT EXISTS "proofRejectionCount"   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Trade"    ADD COLUMN IF NOT EXISTS "lastProofRejectedAt"   TIMESTAMP(3);
ALTER TABLE "Trade"    ADD COLUMN IF NOT EXISTS "lastProofRejectReason" TEXT;

ALTER TABLE "CtmTrade" ADD COLUMN IF NOT EXISTS "proofRejectionCount"   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CtmTrade" ADD COLUMN IF NOT EXISTS "lastProofRejectedAt"   TIMESTAMP(3);
ALTER TABLE "CtmTrade" ADD COLUMN IF NOT EXISTS "lastProofRejectReason" TEXT;
