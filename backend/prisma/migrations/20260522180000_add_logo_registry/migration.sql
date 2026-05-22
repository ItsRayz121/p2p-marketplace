-- CreateTable
CREATE TABLE "LogoRegistry" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logoUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LogoRegistry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LogoRegistry_type_idx" ON "LogoRegistry"("type");

-- CreateIndex
CREATE UNIQUE INDEX "LogoRegistry_type_slug_key" ON "LogoRegistry"("type", "slug");
