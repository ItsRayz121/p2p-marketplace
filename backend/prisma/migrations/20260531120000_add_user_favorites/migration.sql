-- Create UserFavorite table for favorite traders feature
CREATE TABLE "UserFavorite" (
    "id"              TEXT NOT NULL,
    "userId"          TEXT NOT NULL,
    "favoritedUserId" TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserFavorite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserFavorite_userId_favoritedUserId_key" ON "UserFavorite"("userId", "favoritedUserId");
CREATE INDEX "UserFavorite_userId_idx" ON "UserFavorite"("userId");

ALTER TABLE "UserFavorite" ADD CONSTRAINT "UserFavorite_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserFavorite" ADD CONSTRAINT "UserFavorite_favoritedUserId_fkey"
    FOREIGN KEY ("favoritedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
