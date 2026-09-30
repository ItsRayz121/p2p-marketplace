-- Shareable payment page. Private by default: nothing is exposed until the owner
-- enables their profile AND flags individual methods as shared.
ALTER TABLE "PaymentMethod" ADD COLUMN "shared" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "PaymentShareProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentShareProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentShareProfile_userId_key" ON "PaymentShareProfile"("userId");
CREATE UNIQUE INDEX "PaymentShareProfile_slug_key" ON "PaymentShareProfile"("slug");

ALTER TABLE "PaymentShareProfile" ADD CONSTRAINT "PaymentShareProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
