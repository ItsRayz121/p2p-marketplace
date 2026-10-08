'use client'
import { useRef } from 'react'
import { ImagePlus, X } from 'lucide-react'
import { useFileUpload } from '@/hooks/useFileUpload'
import { UploadProgress } from '@/components/ui/UploadProgress'
import { isTrustedImageUrl } from '@/lib/utils'
import { toast } from '@/lib/toast'

/**
 * Logo picker for a task: uploads to our image storage and reports the URL (or null when removed).
 * Square-ish logos work best; JPG/PNG/WebP up to 10 MB.
 */
export function TaskLogoField({
  value,
  onChange,
  label = 'Logo (optional)',
  compact = false,
}: {
  value: string | null | undefined
  onChange: (url: string | null) => void | Promise<void>
  label?: string
  compact?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const { upload, uploading, progress } = useFileUpload('giveaway-image')

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      await onChange(await upload(file))
    } catch (err) {
      toast.error('Logo upload failed', err instanceof Error ? err.message : undefined)
    }
  }

  const has = isTrustedImageUrl(value ?? null)
  return (
    <div>
      {!compact && <span className="mb-1 block text-xs font-semibold text-text-muted">{label}</span>}
      <div className="flex items-center gap-3">
        <span className={`flex flex-shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-canvas ${compact ? 'h-9 w-9' : 'h-14 w-14'}`}>
          {has ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value!} alt="" className="h-full w-full object-cover" />
          ) : (
            <ImagePlus className="h-5 w-5 text-text-muted" aria-hidden />
          )}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={pick} />
          <button
            type="button"
            onClick={() => input.current?.click()}
            disabled={uploading}
            className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text-primary hover:bg-surface-alt disabled:opacity-50"
          >
            {uploading ? 'Uploading…' : has ? 'Replace logo' : 'Upload logo'}
          </button>
          {has && !uploading && (
            <button type="button" onClick={() => void onChange(null)} className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-danger" aria-label="Remove logo">
              <X className="h-3 w-3" aria-hidden /> Remove
            </button>
          )}
        </div>
      </div>
      {uploading && progress && <div className="mt-2 max-w-xs"><UploadProgress progress={progress} /></div>}
    </div>
  )
}
