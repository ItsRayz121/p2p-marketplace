'use client'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { appealApi, type AppealMe, ApiError } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Spinner } from '@/components/ui/Spinner'
import { ShieldX, Clock, UploadCloud, X } from 'lucide-react'

const STATUS_COPY: Record<string, { title: string; tone: string }> = {
  suspended: { title: 'Your account is suspended', tone: 'warning' },
  temporarily_banned: { title: 'Your account is temporarily banned', tone: 'danger' },
  permanently_banned: { title: 'Your account is banned', tone: 'danger' },
  under_review: { title: 'Your account is under review', tone: 'default' },
  active: { title: 'Your account is active', tone: 'success' },
}

const APPEAL_STATUS: Record<string, { label: string; variant: 'warning' | 'success' | 'danger' | 'info' }> = {
  pending: { label: 'Under review', variant: 'warning' },
  approved: { label: 'Approved', variant: 'success' },
  rejected: { label: 'Rejected', variant: 'danger' },
  more_info_requested: { label: 'More info requested', variant: 'info' },
}

function fmt(d: string | null) {
  if (!d) return ''
  try { return new Date(d).toLocaleString() } catch { return d }
}

function RestrictedInner() {
  const searchParams = useSearchParams()
  const [token, setToken] = useState<string | null>(null)
  const [data, setData] = useState<AppealMe | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [explanation, setExplanation] = useState('')
  const [evidence, setEvidence] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Resolve token: URL (Google flow) wins, else sessionStorage (email login).
  useEffect(() => {
    const urlToken = searchParams.get('token')
    if (urlToken) {
      sessionStorage.setItem('appealToken', urlToken)
      setToken(urlToken)
    } else {
      setToken(sessionStorage.getItem('appealToken'))
    }
  }, [searchParams])

  const load = useCallback(async (t: string) => {
    try {
      const res = await appealApi.me(t)
      setData(res)
      setLoadError(null)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setLoadError('expired')
      else setLoadError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (token === null) return
    if (!token) { setLoading(false); setLoadError('missing'); return }
    load(token)
  }, [token, load])

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !token) return
    if (evidence.length >= 5) { setFormError('Up to 5 images.'); return }
    setUploading(true); setFormError(null)
    try {
      const { url, fields, publicUrl } = await appealApi.presignEvidence(token, file.type)
      const form = new FormData()
      Object.entries(fields).forEach(([k, v]) => form.append(k, String(v)))
      form.append('file', file)
      const res = await fetch(url, { method: 'POST', body: form })
      if (!res.ok) throw new Error('Upload failed')
      setEvidence((prev) => [...prev, publicUrl])
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function submit() {
    if (!token) return
    if (explanation.trim().length < 20) { setFormError('Please write at least 20 characters explaining your appeal.'); return }
    setSubmitting(true); setFormError(null)
    try {
      await appealApi.submit(token, { explanation: explanation.trim(), ...(evidence.length ? { evidenceUrls: evidence } : {}) })
      setSubmitted(true)
      setExplanation(''); setEvidence([])
      await load(token)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to submit appeal')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return <div className="min-h-[60vh] flex items-center justify-center"><Spinner size="lg" /></div>
  }

  if (loadError === 'missing' || loadError === 'expired') {
    return (
      <div className="max-w-md mx-auto mt-16 text-center px-4">
        <ShieldX className="w-12 h-12 text-danger mx-auto mb-4" />
        <h1 className="text-xl font-bold text-text-primary mb-2">Session needed</h1>
        <p className="text-text-muted text-sm mb-6">
          {loadError === 'expired' ? 'Your appeal session expired.' : 'We couldn’t find an active restriction session.'} Please sign in again to continue.
        </p>
        <Link href="/login"><Button>Back to sign in</Button></Link>
      </div>
    )
  }

  if (loadError || !data) {
    return (
      <div className="max-w-md mx-auto mt-16 text-center px-4">
        <p className="text-danger mb-4">{loadError}</p>
        <Link href="/login"><Button variant="secondary">Back to sign in</Button></Link>
      </div>
    )
  }

  // If access has been restored, point them back to login.
  if (data.status === 'active' || !data.canAppeal) {
    return (
      <div className="max-w-md mx-auto mt-16 text-center px-4">
        <h1 className="text-xl font-bold text-text-primary mb-2">Your access has been restored</h1>
        <p className="text-text-muted text-sm mb-6">You can now sign in normally.</p>
        <Link href="/login"><Button>Sign in</Button></Link>
      </div>
    )
  }

  const copy = STATUS_COPY[data.status] ?? STATUS_COPY.suspended!
  const activeAppeal = data.appeals.find((a) => a.status === 'pending' || a.status === 'more_info_requested')

  return (
    <div className="max-w-2xl mx-auto px-4 py-10 space-y-6">
      {/* Restriction banner */}
      <div className={`rounded-xl border p-5 ${copy.tone === 'danger' ? 'border-danger/30 bg-danger/5' : 'border-amber-300 bg-amber-50'}`}>
        <div className="flex items-start gap-3">
          <ShieldX className={`w-6 h-6 mt-0.5 ${copy.tone === 'danger' ? 'text-danger' : 'text-amber-600'}`} />
          <div>
            <h1 className="text-lg font-bold text-text-primary">{copy.title}</h1>
            {data.reason && <p className="text-sm text-text-secondary mt-1">Reason: {data.reason}</p>}
            {data.until && (
              <p className="text-xs text-text-muted mt-1 flex items-center gap-1"><Clock size={12} /> Automatically lifts on {fmt(data.until)}</p>
            )}
          </div>
        </div>
      </div>

      {/* Existing appeals */}
      {data.appeals.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-text-primary">Your appeals</h2>
          {data.appeals.map((a) => (
            <div key={a.id} className="border border-border rounded-xl p-4 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Badge variant={APPEAL_STATUS[a.status]?.variant ?? 'default'} size="sm">{APPEAL_STATUS[a.status]?.label ?? a.status}</Badge>
                <span className="text-xs text-text-muted">{fmt(a.createdAt)}</span>
              </div>
              <p className="text-sm text-text-secondary whitespace-pre-wrap">{a.explanation}</p>
              {a.decisionNote && (
                <div className="text-xs bg-surface-alt rounded-lg px-3 py-2">
                  <span className="text-text-muted">Response: </span><span className="text-text-secondary">{a.decisionNote}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Appeal form */}
      {submitted && !activeAppeal ? (
        <div className="rounded-xl border border-success/30 bg-success/5 p-5 text-center">
          <p className="text-sm text-text-secondary">Your appeal has been submitted. Our team will review it and you’ll be notified of the outcome.</p>
        </div>
      ) : activeAppeal ? (
        <div className="rounded-xl border border-border bg-surface p-5 text-center">
          <p className="text-sm text-text-secondary">You have an appeal under review. We’ll notify you once it’s been decided.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-surface p-5 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Submit an appeal</h2>
            <p className="text-xs text-text-muted mt-0.5">Explain why you believe this action should be reconsidered. You can attach evidence.</p>
          </div>
          <textarea
            value={explanation}
            onChange={(e) => setExplanation(e.target.value)}
            rows={5}
            placeholder="Explain your situation (minimum 20 characters)..."
            className="w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary resize-none"
          />

          {/* Evidence */}
          <div>
            <div className="flex flex-wrap gap-2 mb-2">
              {evidence.map((u, i) => (
                <div key={i} className="relative w-16 h-16 rounded-lg overflow-hidden border border-border">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={u} alt={`Evidence ${i + 1}`} className="w-full h-full object-cover" />
                  <button onClick={() => setEvidence((p) => p.filter((_, idx) => idx !== i))} className="absolute top-0 right-0 bg-danger text-white rounded-bl p-0.5"><X size={12} /></button>
                </div>
              ))}
            </div>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handleUpload} className="hidden" />
            <Button size="sm" variant="secondary" loading={uploading} disabled={evidence.length >= 5} onClick={() => fileRef.current?.click()}>
              <UploadCloud size={14} /> Add evidence
            </Button>
            <span className="text-xs text-text-muted ml-2">{evidence.length}/5 images</span>
          </div>

          {formError && <p className="text-sm text-danger">{formError}</p>}

          <div className="flex gap-2">
            <Button loading={submitting} disabled={explanation.trim().length < 20} onClick={submit}>Submit appeal</Button>
            <Link href="/login"><Button variant="ghost">Back to sign in</Button></Link>
          </div>
        </div>
      )}
    </div>
  )
}

export default function RestrictedPage() {
  return (
    <Suspense fallback={<div className="min-h-[60vh] flex items-center justify-center"><Spinner size="lg" /></div>}>
      <RestrictedInner />
    </Suspense>
  )
}
