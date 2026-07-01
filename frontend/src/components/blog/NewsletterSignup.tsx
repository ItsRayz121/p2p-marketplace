'use client'

import { useState } from 'react'
import { Mail, CheckCircle2 } from 'lucide-react'
import { blogApi, ApiError } from '@/lib/api'

/**
 * Email capture for the blog sidebar. Posts to the public (CSRF-exempt)
 * /blog/subscribe endpoint; on success it swaps to a thank-you state. `source`
 * lets us attribute where a signup came from (e.g. a specific post slug).
 */
export function NewsletterSignup({ source }: { source?: string }) {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (status === 'loading') return
    setStatus('loading')
    setError('')
    try {
      await blogApi.subscribe(email.trim(), source)
      setStatus('done')
    } catch (err) {
      setStatus('error')
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.')
    }
  }

  return (
    <div className="rounded-xl border border-border bg-gradient-to-br from-primary/5 to-blue-500/5 p-4">
      <div className="flex items-center gap-2">
        <Mail size={16} className="text-primary" />
        <h3 className="text-sm font-bold text-text-primary">Crypto tips in your inbox</h3>
      </div>

      {status === 'done' ? (
        <p className="mt-2 flex items-center gap-1.5 text-sm text-success">
          <CheckCircle2 size={15} /> You&apos;re on the list — thanks!
        </p>
      ) : (
        <>
          <p className="mt-1 text-xs text-text-muted">
            Guides on USDT, local payments &amp; staying safe in P2P. No spam, unsubscribe anytime.
          </p>
          <form onSubmit={submit} className="mt-3 space-y-2">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@email.com"
              className="w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <button
              type="submit"
              disabled={status === 'loading'}
              className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-bold text-white transition-colors hover:bg-primary-hover disabled:opacity-60"
            >
              {status === 'loading' ? 'Subscribing…' : 'Subscribe'}
            </button>
            {status === 'error' && <p className="text-xs text-rose-500">{error}</p>}
          </form>
        </>
      )}
    </div>
  )
}
