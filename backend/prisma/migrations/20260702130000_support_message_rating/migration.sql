-- Satisfaction rating on support-chat "system" messages (1=bad, 2=okay, 3=great)
ALTER TABLE "SupportMessage" ADD COLUMN "rating" INTEGER;
