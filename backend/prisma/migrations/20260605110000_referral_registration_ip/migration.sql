-- Add registration IP tracking for referral suspicious-pattern detection
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "registrationIp" TEXT;
