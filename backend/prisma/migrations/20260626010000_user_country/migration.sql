-- Geo-IP country for users (derived from registrationIp). Display + analytics only.
ALTER TABLE "User" ADD COLUMN "country" TEXT;
ALTER TABLE "User" ADD COLUMN "countryCode" TEXT;
