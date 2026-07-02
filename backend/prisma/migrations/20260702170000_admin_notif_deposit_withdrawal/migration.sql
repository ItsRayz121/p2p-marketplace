-- Add DEPOSIT and WITHDRAWAL categories so credited crypto deposits and user
-- withdrawals get their own admin-notification stream (previously deposits were
-- silent and withdrawals were lumped under SYSTEM). PostgreSQL 12+ permits
-- ALTER TYPE ... ADD VALUE inside a transaction as long as the new value is not
-- used in the same transaction (it isn't here).
ALTER TYPE "AdminNotifCategory" ADD VALUE IF NOT EXISTS 'DEPOSIT';
ALTER TYPE "AdminNotifCategory" ADD VALUE IF NOT EXISTS 'WITHDRAWAL';
