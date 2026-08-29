'use client'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Download, Loader2, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import { isTelegramMiniApp } from '@/lib/telegram'
import {
  captureCardAsPngBlob,
  downloadBlob,
  blobToDataUrl,
  shareCardImage,
  shareImageInTelegram,
  ShareCancelledError,
} from '@/lib/cardImageExport'

interface CardDownloadButtonProps {
  /** Ref to the outer card element that should be captured. */
  cardRef: RefObject<HTMLElement | null>
  /** Called at click time (not render time) so the filename reflects the
   * card's current data even if it updates while the menu is open. */
  buildFilename: () => string
  className?: string
}

/**
 * Small circular icon button, placed immediately before a card's SELL/BUY
 * badge, that opens a compact menu to download or share the card as a PNG.
 * Self-contained: owns its own open/busy state and is excluded from the
 * generated image via `data-export-exclude`.
 */
export function CardDownloadButton({ cardRef, buildFilename, className }: CardDownloadButtonProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // When set, the generated PNG is shown full-screen so the viewer can
  // long-press → "Save to Photos". This is the fallback for the Telegram
  // Mini App WebView, which silently ignores blob/anchor downloads.
  const [manualSave, setManualSave] = useState<{ src: string; name: string } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const runExport = useCallback(
    async (mode: 'download' | 'share') => {
      if (busy) return
      const node = cardRef.current
      if (!node) return
      setMenuOpen(false)
      setBusy(true)
      try {
        const blob = await captureCardAsPngBlob(node)
        const filename = buildFilename()

        // Telegram Mini App: blob/anchor downloads are a silent no-op in its
        // WebView, so never claim success from downloadBlob() here. Try a
        // direct share first; if that isn't available, fall back to a
        // long-press-to-save preview of the image.
        if (isTelegramMiniApp()) {
          try {
            const result = await shareImageInTelegram(blob, filename)
            if (result === 'shared') {
              toast.success('Offer image shared')
              return
            }
          } catch (err) {
            if (err instanceof ShareCancelledError) return
            throw err
          }
          const src = await blobToDataUrl(blob)
          setManualSave({ src, name: filename })
          return
        }

        if (mode === 'share') {
          try {
            const result = await shareCardImage(blob, filename)
            toast.success(result === 'shared' ? 'Offer image ready to share' : 'Offer image downloaded')
          } catch (err) {
            if (err instanceof ShareCancelledError) return
            throw err
          }
        } else {
          downloadBlob(blob, filename)
          toast.success('Offer image downloaded')
        }
      } catch (err) {
        console.error('[CardDownloadButton] export failed', err)
        toast.error('Unable to generate the image. Please try again.')
      } finally {
        setBusy(false)
      }
    },
    [busy, cardRef, buildFilename],
  )

  return (
    <div ref={wrapRef} className={`relative flex-shrink-0 ${className ?? ''}`} data-export-exclude="true">
      <button
        type="button"
        onClick={() => !busy && setMenuOpen((v) => !v)}
        disabled={busy}
        title="Download offer"
        aria-label="Download offer as image"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className="flex items-center justify-center w-[34px] h-[34px] sm:w-9 sm:h-9 rounded-full bg-slate-100 dark:bg-slate-700/40 border border-slate-200 dark:border-slate-600/60 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600/60 active:scale-95 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {busy ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} strokeWidth={2} />}
      </button>

      {menuOpen && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1.5 z-20 w-48 rounded-lg border border-border bg-surface shadow-card-md overflow-hidden py-1 animate-fade-in"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => runExport('download')}
            className="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-surface-alt transition-colors"
          >
            Download as Image
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => runExport('share')}
            className="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-surface-alt transition-colors"
          >
            Share Image
          </button>
        </div>
      )}

      {manualSave && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Save offer image"
          className="fixed inset-0 z-[300] flex flex-col items-center justify-center gap-4 bg-black/85 p-4 animate-fade-in"
          onClick={() => setManualSave(null)}
        >
          <button
            type="button"
            onClick={() => setManualSave(null)}
            aria-label="Close"
            className="absolute right-4 top-4 flex items-center justify-center w-9 h-9 rounded-full bg-white/15 text-white hover:bg-white/25 transition-colors"
          >
            <X size={20} />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={manualSave.src}
            alt={manualSave.name}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[70vh] max-w-full rounded-xl shadow-2xl"
          />
          <p className="max-w-xs text-center text-sm font-medium text-white">
            Press and hold the image, then choose <span className="whitespace-nowrap">“Save to Photos”</span> /
            <span className="whitespace-nowrap"> “Download image”</span>.
          </p>
        </div>
      )}
    </div>
  )
}
