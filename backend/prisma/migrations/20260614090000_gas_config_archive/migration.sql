-- Archive flag for gas chain + token configs. Archived rows are removed from the
-- main admin list into an "Archived" section (implies hidden from users) and kept
-- so they can be unarchived or permanently deleted later. Default false.
ALTER TABLE "GasChainConfig" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GasTokenConfig" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;
