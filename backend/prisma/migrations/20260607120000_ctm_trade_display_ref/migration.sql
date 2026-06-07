-- Add human-readable display reference for CTM trades (CTM-YYYYMMDD-NNNN).
-- The cuid "tradeRef" stays the canonical URL/routing key; displayRef is what
-- users see so raw database IDs are never exposed.

ALTER TABLE "CtmTrade" ADD COLUMN "displayRef" TEXT;

-- Backfill existing trades with a stable per-day sequence ordered by creation time.
WITH ranked AS (
  SELECT
    "id",
    'CTM-' || to_char("createdAt", 'YYYYMMDD') || '-' ||
      lpad(
        (row_number() OVER (
          PARTITION BY to_char("createdAt", 'YYYYMMDD')
          ORDER BY "createdAt", "id"
        ))::text,
        4, '0'
      ) AS ref
  FROM "CtmTrade"
)
UPDATE "CtmTrade" t
SET "displayRef" = r.ref
FROM ranked r
WHERE t."id" = r."id";

CREATE UNIQUE INDEX "CtmTrade_displayRef_key" ON "CtmTrade"("displayRef");
