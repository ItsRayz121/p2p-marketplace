import sanitizeHtmlLib from 'sanitize-html'
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
 * Hosts an <iframe> is allowed to embed. Kept tight on purpose: only the video
 * providers the editor can actually insert (YouTube, Vimeo, Google Drive,
 * Telegram). Anything else is dropped, regardless of who authored it.
 */
const ALLOWED_IFRAME_HOSTNAMES = [
  'www.youtube.com',
  'youtube.com',
  'www.youtube-nocookie.com',
  'youtube-nocookie.com',
  'player.vimeo.com',
  'drive.google.com',
  't.me',
]

/**
 * Defence-in-depth sanitisation of admin-authored rich HTML before it is stored
 * and later rendered (via dangerouslySetInnerHTML) on public pages. Authors are
 * trusted admins, but we run a real DOM allowlist (sanitize-html) so a
 * copy-pasted/edited snippet can't smuggle in executable code: only known-good
 * tags/attributes survive, <script>/<style>/event-handlers/js-URLs are stripped,
 * and <iframe> is restricted to the embed hosts above. The allowlist preserves
 * everything the TipTap editor emits — including the YouTube wrapper
 * (<div data-youtube-video>), inline embeds (<iframe class="blog-embed">),
 * images (<img class="blog-img">) and captions (<p class="blog-caption">).
 */
export function sanitizeHtml(html: string): string {
  return sanitizeHtmlLib(html, {
    allowedTags: sanitizeHtmlLib.defaults.allowedTags.concat(['img', 'iframe']),
    allowedAttributes: {
      '*': ['class'],
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
      iframe: ['src', 'width', 'height', 'allow', 'allowfullscreen', 'frameborder', 'title', 'loading', 'referrerpolicy'],
      div: ['data-youtube-video'],
    },
    allowedIframeHostnames: ALLOWED_IFRAME_HOSTNAMES,
    allowIframeRelativeUrls: false,
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    // Harden every surviving link, including ones pasted without a rel.
    transformTags: {
      a: sanitizeHtmlLib.simpleTransform('a', { rel: 'noopener noreferrer' }),
    },
  })
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
  coverImageCaption?: string | null | undefined
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
      coverImageCaption: input.coverImageCaption ?? null,
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
      ...(input.coverImageCaption !== undefined ? { coverImageCaption: input.coverImageCaption } : {}),
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
  // NB: view counting lives in recordView(), pinged from the browser on each
  // visit. Incrementing here would only fire once per ISR revalidation window
  // (the public page is cached), badly under-counting real traffic.
  return post
}

/**
 * Per-visit view increment, called from a lightweight browser ping rather than
 * the cached page render so the count tracks actual visits. Silent no-op for
 * unknown/unpublished slugs — it must never throw into a fire-and-forget call.
 */
export async function recordView(slug: string): Promise<void> {
  await db.blogPost
    .updateMany({ where: { slug, status: 'published' }, data: { viewCount: { increment: 1 } } })
    .catch(() => {})
}

/** All published slugs for sitemap generation. */
export async function listPublishedSlugs() {
  return db.blogPost.findMany({
    where: { status: 'published', noindex: false },
    select: { slug: true, updatedAt: true },
    orderBy: { publishedAt: 'desc' },
  })
}
