-- Blog posts gain an optional subcategory (e.g. a specific CTM token or gas chain)
-- nested under the top-level category. Filterable, so it gets its own index.
ALTER TABLE "BlogPost" ADD COLUMN "subcategory" TEXT;

CREATE INDEX "BlogPost_subcategory_idx" ON "BlogPost"("subcategory");
