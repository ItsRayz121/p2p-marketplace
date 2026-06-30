import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** URL-safe slug from a title: lowercase, alnum + hyphens, collapsed. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')        // non-alnum → hyphen
    .replace(/^-+|-+$/g, '')            // trim hyphens
    .slice(0, 80) || 'post'
}

/** Ensure the slug is unique, appending -2, -3… if it collides. */
async function uniqueSlug(base: string, ignoreId?: string): Promise<string> {
  let slug = base
  let n = 1
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await db.blogPost.findUnique({ where: { slug } })
    if (!existing || existing.id === ignoreId) return slug
    n += 1
    slug = `${base}-${n}`
  }
}

/** Strip HTML tags and estimate reading time at ~200 wpm (min 1). */
export function estimateReadingMinutes(html: string): number {
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  const words = text ? text.split(' ').length : 0
  return Math.max(1, Math.round(words / 200))
}

/**
 * Minimal defence-in-depth sanitisation of admin-authored rich HTML before it
 * is stored and later rendered on public pages. Authors are trusted admins, but
 * we still strip <script>/<style> blocks, inline event handlers, and
 * javascript: URLs so a copy-pasted snippet can't smuggle in executable code.
 */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<\s*(script|style|iframe(?![^>]*\b(youtube|youtube-nocookie|player\.vimeo|drive\.google|t\.me|telegram)\b))[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1=$2#$2')
}

// ─── Types ──────────────────────────────────────────────────────────────────

// `| undefined` on every optional member so Zod-inferred inputs (which model
// optionals as `T | undefined`) assign cleanly under exactOptionalPropertyTypes.
export interface BlogPostInput {
  title: string
  slug?: string | undefined
  excerpt?: string | null | undefined
  bodyHtml: string
  coverImageUrl?: string | null | undefined
  coverImageAlt?: string | null | undefined
  status?: 'draft' | 'published' | undefined
  tags?: string[] | undefined
  category?: string | null | undefined
  authorName?: string | undefined
  metaTitle?: string | null | undefined
  metaDescription?: string | null | undefined
  focusKeyword?: string | null | undefined
  ogImageUrl?: string | null | undefined
  canonicalUrl?: string | null | undefined
  noindex?: boolean | undefined
}

// ─── Admin operations ─────────────────────────────────────────────────────────

export async function createPost(input: BlogPostInput, authorId?: string) {
  const base = slugify(input.slug?.trim() || input.title)
  const slug = await uniqueSlug(base)
  const status = input.status ?? 'draft'
  const bodyHtml = sanitizeHtml(input.bodyHtml)

  return db.blogPost.create({
    data: {
      slug,
      title: input.title.trim(),
      excerpt: input.excerpt ?? null,
      bodyHtml,
      coverImageUrl: input.coverImageUrl ?? null,
      coverImageAlt: input.coverImageAlt ?? null,
      status,
      publishedAt: status === 'published' ? new Date() : null,
      tags: input.tags ?? [],
      category: input.category ?? null,
      authorId: authorId ?? null,
      authorName: input.authorName?.trim() || 'RupChain',
      metaTitle: input.metaTitle ?? null,
      metaDescription: input.metaDescription ?? null,
      focusKeyword: input.focusKeyword ?? null,
      ogImageUrl: input.ogImageUrl ?? null,
      canonicalUrl: input.canonicalUrl ?? null,
      noindex: input.noindex ?? false,
      readingMinutes: estimateReadingMinutes(bodyHtml),
    },
  })
}

// Update accepts every field as optional — including the otherwise-required
// title/bodyHtml — with explicit `undefined` for exactOptionalPropertyTypes.
export type BlogPostUpdate = Partial<Omit<BlogPostInput, 'title' | 'bodyHtml'>> & {
  title?: string | undefined
  bodyHtml?: string | undefined
}

export async function updatePost(id: string, input: BlogPostUpdate) {
  const existing = await db.blogPost.findUnique({ where: { id } })
  if (!existing) throw new AppError('NOT_FOUND', 'Post not found', 404)

  const bodyHtml = input.bodyHtml !== undefined ? sanitizeHtml(input.bodyHtml) : undefined
  // Re-slug only when the caller explicitly sends a new slug.
  const slug = input.slug !== undefined ? await uniqueSlug(slugify(input.slug || existing.title), id) : undefined

  // First publish stamps publishedAt; unpublishing clears it; re-publish keeps original.
  let publishedAt = existing.publishedAt
  if (input.status === 'published' && !existing.publishedAt) publishedAt = new Date()
  if (input.status === 'draft') publishedAt = null

  return db.blogPost.update({
    where: { id },
    data: {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(slug !== undefined ? { slug } : {}),
      ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
      ...(bodyHtml !== undefined ? { bodyHtml, readingMinutes: estimateReadingMinutes(bodyHtml) } : {}),
      ...(input.coverImageUrl !== undefined ? { coverImageUrl: input.coverImageUrl } : {}),
      ...(input.coverImageAlt !== undefined ? { coverImageAlt: input.coverImageAlt } : {}),
      ...(input.status !== undefined ? { status: input.status, publishedAt } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.authorName !== undefined ? { authorName: input.authorName.trim() || 'RupChain' } : {}),
      ...(input.metaTitle !== undefined ? { metaTitle: input.metaTitle } : {}),
      ...(input.metaDescription !== undefined ? { metaDescription: input.metaDescription } : {}),
      ...(input.focusKeyword !== undefined ? { focusKeyword: input.focusKeyword } : {}),
      ...(input.ogImageUrl !== undefined ? { ogImageUrl: input.ogImageUrl } : {}),
      ...(input.canonicalUrl !== undefined ? { canonicalUrl: input.canonicalUrl } : {}),
      ...(input.noindex !== undefined ? { noindex: input.noindex } : {}),
    },
  })
}

export async function deletePost(id: string) {
  await db.blogPost.delete({ where: { id } }).catch(() => {
    throw new AppError('NOT_FOUND', 'Post not found', 404)
  })
  return { id }
}

export async function listAdmin(opts: { status?: string | undefined; page?: number | undefined; pageSize?: number | undefined }) {
  const page = Math.max(1, opts.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20))
  const where = opts.status && opts.status !== 'all' ? { status: opts.status } : {}
  const [posts, total] = await Promise.all([
    db.blogPost.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.blogPost.count({ where }),
  ])
  return { posts, total, page, pageSize }
}

export async function getAdminById(id: string) {
  const post = await db.blogPost.findUnique({ where: { id } })
  if (!post) throw new AppError('NOT_FOUND', 'Post not found', 404)
  return post
}

// ─── Public operations ──────────────────────────────────────────────────────

export async function listPublic(opts: { page?: number | undefined; pageSize?: number | undefined; category?: string | undefined; tag?: string | undefined; q?: string | undefined }) {
  const page = Math.max(1, opts.page ?? 1)
  const pageSize = Math.min(50, Math.max(1, opts.pageSize ?? 12))
  const where: Record<string, unknown> = { status: 'published', noindex: false }
  if (opts.category) where.category = opts.category
  if (opts.tag) where.tags = { has: opts.tag }
  if (opts.q) {
    where.OR = [
      { title: { contains: opts.q, mode: 'insensitive' } },
      { excerpt: { contains: opts.q, mode: 'insensitive' } },
    ]
  }
  const [posts, total] = await Promise.all([
    db.blogPost.findMany({
      where,
      orderBy: { publishedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        slug: true, title: true, excerpt: true, coverImageUrl: true, coverImageAlt: true,
        category: true, tags: true, authorName: true, publishedAt: true, readingMinutes: true,
      },
    }),
    db.blogPost.count({ where }),
  ])
  return { posts, total, page, pageSize }
}

export async function getPublicBySlug(slug: string) {
  const post = await db.blogPost.findUnique({ where: { slug } })
  if (!post || post.status !== 'published') throw new AppError('NOT_FOUND', 'Post not found', 404)
  // Fire-and-forget view increment — never block the read on it.
  db.blogPost.update({ where: { id: post.id }, data: { viewCount: { increment: 1 } } }).catch(() => {})
  return post
}

/** All published slugs for sitemap generation. */
export async function listPublishedSlugs() {
  return db.blogPost.findMany({
    where: { status: 'published', noindex: false },
    select: { slug: true, updatedAt: true },
    orderBy: { publishedAt: 'desc' },
  })
}
