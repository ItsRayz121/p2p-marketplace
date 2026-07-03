'use client'

import { useEffect, useState, useCallback } from 'react'
import { Mail, Download, Search } from 'lucide-react'
import { blogApi, ApiError, type NewsletterSubscriber } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '')
const PAGE_SIZE = 50

function fmtDate(d: string): string {
  return new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function AdminSubscribersPage() {
  const [rows, setRows] = useState<NewsletterSubscriber[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await blogApi.adminSubscribers({ page, pageSize: PAGE_SIZE, q: search || undefined })
      setRows(res.subscribers)
      setTotal(res.total)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load subscribers')
    } finally {
      setLoading(false)
    }
  }, [page, search])

  useEffect(() => { void load() }, [load])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  function submitSearch(e: React.FormEvent) {
    e.preventDefault()
    setPage(1)
    setSearch(q.trim())
  }

  async function exportCsv() {
    if (exporting) return
    setExporting(true)
    try {
      const token = useAuthStore.getState().accessToken
      const res = await fetch(`${API_BASE}/api/v1/blog/subscribers/export`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: 'include',
      })
      if (!res.ok) throw new Error('Export failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `newsletter-subscribers-${new Date().toISOString().slice(0, 10)}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      window.alert('Could not export CSV. Try again.')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
            <Mail size={22} className="text-primary" /> Newsletter Subscribers
          </h1>
          <p className="text-sm text-text-muted">Emails captured from the blog signup box.</p>
        </div>
        <button
          onClick={exportCsv}
          disabled={exporting || total === 0}
          className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-semibold text-text-secondary hover:bg-surface-alt disabled:opacity-50"
        >
          <Download size={15} /> {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
      </div>

      <div className="admin-toolbar mb-4 flex flex-wrap items-center gap-3">
        <form onSubmit={submitSearch} className="relative flex-1 min-w-[200px] max-w-sm">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search email…"
            className="w-full rounded-lg border border-border bg-canvas py-2 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </form>
        <span className="text-sm text-text-muted">{total.toLocaleString('en-US')} total</span>
      </div>

      {loading ? (
        <div className="py-16 text-center text-sm text-text-muted">Loading…</div>
      ) : error ? (
        <div className="py-16 text-center text-sm text-rose-500">{error}</div>
      ) : rows.length === 0 ? (
        <div className="py-16 text-center text-text-muted">
          <p className="text-sm">{search ? 'No matching subscribers.' : 'No subscribers yet — signups from the blog will appear here.'}</p>
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border border-border bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-alt/50 text-left text-xs font-semibold uppercase tracking-wide text-text-muted">
                  <th className="px-4 py-3">Email</th>
                  <th className="hidden px-4 py-3 sm:table-cell">Source</th>
                  <th className="hidden px-4 py-3 sm:table-cell">Country</th>
                  <th className="px-4 py-3 text-right">Subscribed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-surface-alt/40">
                    <td className="px-4 py-3 font-medium text-text-primary">
                      <a href={`mailto:${r.email}`} className="hover:text-primary hover:underline">{r.email}</a>
                    </td>
                    <td className="hidden px-4 py-3 text-text-muted sm:table-cell">{r.source ?? '—'}</td>
                    <td className="hidden px-4 py-3 text-text-muted sm:table-cell">{r.country ?? '—'}</td>
                    <td className="px-4 py-3 text-right text-text-muted">{fmtDate(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="mt-6 flex items-center justify-center gap-3">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-text-secondary hover:bg-surface-alt disabled:opacity-50"
              >
                ← Previous
              </button>
              <span className="text-sm text-text-muted">Page {page} of {totalPages}</span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-text-secondary hover:bg-surface-alt disabled:opacity-50"
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
