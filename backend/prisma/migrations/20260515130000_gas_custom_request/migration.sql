-- Create GasCustomRequestStatus enum
CREATE TYPE "GasCustomRequestStatus" AS ENUM ('pending', 'reviewing', 'completed', 'rejected');

-- Create GasCustomRequest table
CREATE TABLE "GasCustomRequest" (
    "id" TEXT NOT NULL,
    "blockchainName" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "amount" TEXT,
    "purpose" TEXT NOT NULL,
    "urgency" TEXT NOT NULL DEFAULT 'normal',
    "details" TEXT,
    "contactEmail" TEXT,
    "ipAddress" TEXT,
    "status" "GasCustomRequestStatus" NOT NULL DEFAULT 'pending',
    "adminNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GasCustomRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GasCustomRequest_status_idx" ON "GasCustomRequest"("status");
CREATE INDEX "GasCustomRequest_createdAt_idx" ON "GasCustomRequest"("createdAt");
