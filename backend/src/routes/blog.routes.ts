import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requireRole } from '../middleware/auth.middleware'
import { AppError } from '../lib/errors'
import {
  createPost, updatePost, deletePost, listAdmin, getAdminById,
  listPublic, getPublicBySlug, recordView, subscribeNewsletter,
  listSubscribers, listAllSubscribers,
} from '../services/blog.service'

const adminGuard = [authenticate, requireRole('admin', 'super_admin')]

const upsertSchema = z.object({
  title: z.string().min(1).max(200),
  slug: z.string().max(100).optional(),
  excerpt: z.string().max(500).nullish(),
  bodyHtml: z.string().max(200_000),
  coverImageUrl: z.string().url().max(600).nullish(),
  coverImageAlt: z.string().max(200).nullish(),
  coverImageCaption: z.string().max(300).nullish(),
  status: z.enum(['draft', 'published']).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  category: z.string().max(60).nullish(),
  authorName: z.string().max(80).optional(),
  metaTitle: z.string().max(200).nullish(),
  metaDescription: z.string().max(320).nullish(),
  focusKeyword: z.string().max(80).nullish(),
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
    await subscribeNewsletter(parsed.data.email, parsed.data.source)
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
      'email,source,subscribed_at',
      ...rows.map((r) => [esc(r.email), esc(r.source ?? ''), esc(r.createdAt.toISOString())].join(',')),
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
