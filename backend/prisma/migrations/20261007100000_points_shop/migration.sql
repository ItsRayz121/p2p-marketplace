CREATE TABLE "PointsPerk" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "discountPct" DOUBLE PRECISION,
    "pointsSpent" DECIMAL(18,4) NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PointsPerk_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PointsPerk_userId_kind_idx" ON "PointsPerk"("userId", "kind");
CREATE INDEX "PointsPerk_userId_expiresAt_idx" ON "PointsPerk"("userId", "expiresAt");

ALTER TABLE "PointsPerk" ADD CONSTRAINT "PointsPerk_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
