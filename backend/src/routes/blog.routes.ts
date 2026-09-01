import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requireRole } from '../middleware/auth.middleware'
import { AppError } from '../lib/errors'
import { resolveClientIp } from '../lib/requestContext'
import { logger } from '../lib/logger'
import {
  createPost, updatePost, deletePost, listAdmin, getAdminById,
  listPublic, getPublicBySlug, recordView, subscribeNewsletter,
  listSubscribers, listAllSubscribers,
} from '../services/blog.service'

const adminGuard = [authenticate, requireRole('admin', 'super_admin')]

// Private / loopback ranges we never bother geolocating.
const PRIVATE_IP = /^(127\.|10\.|192\.168\.|169\.254\.|::1|fc00:|fe80:|172\.(1[6-9]|2\d|3[01])\.)/i

/**
 * Best-effort country for a newsletter signup. Prefers Cloudflare's zero-latency
 * `cf-ipcountry` header; otherwise does one short IP-geolocation lookup. Always
 * resolves (never throws) — geo is a nice-to-have, not a gate on subscribing.
 */
async function resolveSignupCountry(headers: Record<string, unknown>, ip?: string): Promise<string | undefined> {
  const cf = headers['cf-ipcountry']
  if (typeof cf === 'string' && cf.trim() && !['XX', 'T1'].includes(cf.trim().toUpperCase())) {
    return cf.trim().toUpperCase()
  }
  if (!ip || PRIVATE_IP.test(ip)) return undefined
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 1500)
    const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/country_name/`, { signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) return undefined
    const name = (await res.text()).trim()
    return name && name.length > 0 && name.length <= 60 && !name.startsWith('{') ? name : undefined
  } catch {
    return undefined
  }
}

// Length caps carry a field-named message so a rejected save tells the editor
// exactly which box is too long, not just a bare "at most N characters".
const cap = (label: string, max: number) =>
  z.string().max(max, `${label} must be ${max} characters or fewer`)

const upsertSchema = z.object({
  title: cap('Title', 200).min(1, 'Title is required'),
  slug: cap('Slug', 100).optional(),
  excerpt: cap('Excerpt', 500).nullish(),
  bodyHtml: cap('Article body', 200_000),
  coverImageUrl: z.string().url().max(600).nullish(),
  coverImageAlt: cap('Cover image alt text', 200).nullish(),
  coverImageCaption: cap('Cover image caption', 300).nullish(),
  status: z.enum(['draft', 'published']).optional(),
  tags: z.array(cap('Each tag', 40)).max(20, 'No more than 20 tags').optional(),
  category: cap('Category', 60).nullish(),
  subcategory: cap('Subcategory', 60).nullish(),
  authorName: cap('Author name', 80).optional(),
  metaTitle: cap('Meta title', 200).nullish(),
  metaDescription: cap('Meta description', 320).nullish(),
  focusKeyword: cap('Focus keyword', 80).nullish(),
  ogImageUrl: z.string().url().max(600).nullish(),
  canonicalUrl: z.string().url().max(600).nullish(),
  noindex: z.boolean().optional(),
})

export async function blogRoutes(app: FastifyInstance) {
  // ── Public ──────────────────────────────────────────────────────────────
  app.get('/blog', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    const data = await listPublic({
      page: q.page ? Number(q.page) : undefined,
      pageSize: q.pageSize ? Number(q.pageSize) : undefined,
      category: q.category,
      subcategory: q.subcategory,
      tag: q.tag,
      q: q.q,
    })
    return reply.send({ success: true, data })
  })

  app.get('/blog/post/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string }
    const post = await getPublicBySlug(slug)
    return reply.send({ success: true, data: post })
  })

  // Browser-pinged per-visit view counter — deliberately outside the cached
  // page render so it tracks real visits rather than ISR revalidations.
  app.post('/blog/post/:slug/view', async (req, reply) => {
    const { slug } = req.params as { slug: string }
    await recordView(slug)
    return reply.send({ success: true })
  })

  // Public newsletter opt-in from the blog sidebar (CSRF-exempt; guest form).
  app.post('/blog/subscribe', async (req, reply) => {
    const parsed = z
      .object({ email: z.string().min(3).max(200), source: z.string().max(120).optional() })
      .safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Enter a valid email address', 400)
    const ip = resolveClientIp(req.headers as Record<string, unknown>, req.ip)
    let country: string | undefined
    try {
      country = await resolveSignupCountry(req.headers as Record<string, unknown>, ip)
    } catch (e) {
      logger.warn({ err: e }, 'newsletter geo lookup failed')
    }
    await subscribeNewsletter(parsed.data.email, parsed.data.source, { country, ipAddress: ip })
    return reply.send({ success: true })
  })

  // ── Admin ───────────────────────────────────────────────────────────────
  app.get('/blog/admin', { preHandler: adminGuard }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    const data = await listAdmin({
      status: q.status,
      page: q.page ? Number(q.page) : undefined,
      pageSize: q.pageSize ? Number(q.pageSize) : undefined,
    })
    return reply.send({ success: true, data })
  })

  // Newsletter subscribers — list + CSV export for the admin panel.
  app.get('/blog/subscribers', { preHandler: adminGuard }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    const data = await listSubscribers({
      page: q.page ? Number(q.page) : undefined,
      pageSize: q.pageSize ? Number(q.pageSize) : undefined,
      q: q.q,
    })
    return reply.send({ success: true, data })
  })

  app.get('/blog/subscribers/export', { preHandler: adminGuard }, async (_req, reply) => {
    const rows = await listAllSubscribers()
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`
    const csv = [
      'email,source,country,subscribed_at',
      ...rows.map((r) => [esc(r.email), esc(r.source ?? ''), esc(r.country ?? ''), esc(r.createdAt.toISOString())].join(',')),
    ].join('\n')
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="newsletter-subscribers-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(csv)
  })

  app.get('/blog/admin/:id', { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const post = await getAdminById(id)
    return reply.send({ success: true, data: post })
  })

  app.post('/blog/admin', { preHandler: adminGuard }, async (req, reply) => {
    const parsed = upsertSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const post = await createPost(parsed.data, req.user!.id)
    return reply.send({ success: true, data: post })
  })

  app.patch('/blog/admin/:id', { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = upsertSchema.partial().safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const post = await updatePost(id, parsed.data)
    return reply.send({ success: true, data: post })
  })

  app.delete('/blog/admin/:id', { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const data = await deletePost(id)
    return reply.send({ success: true, data })
  })
}
