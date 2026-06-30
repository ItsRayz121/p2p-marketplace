-- Optional visible caption shown beneath the blog cover image (separate from
-- the hidden coverImageAlt used for SEO/accessibility).
ALTER TABLE "BlogPost" ADD COLUMN "coverImageCaption" TEXT;
