// Card-level "download/share as image" support for P2P offer cards.
// Shared by the CTM (ctm/page.tsx) and USDT (marketplace/page.tsx) listing
// cards so both get identical export behavior from one implementation.
import { toBlob } from 'html-to-image'

// 1x1 transparent GIF — used so a logo that fails to embed (e.g. blocked by
// CORS) renders as blank space instead of a broken-image glyph.
const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7'

/** Attribute used to mark elements (e.g. the download button itself) that
 * must never appear in the exported image. Applied via the `filter` option
 * during html-to-image's clone pass, so the live DOM is never touched. */
export const EXPORT_EXCLUDE_ATTR = 'data-export-exclude'

function sanitizeFilenameSegment(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60)
}

/** Builds a sanitized filename like `rozipay-p2p-very-fazal-elahi-2026-08-12.png`. */
export function buildOfferFilename(symbol: string, sellerName: string): string {
  const date = new Date().toISOString().slice(0, 10)
  const segments = [symbol, sellerName].map(sanitizeFilenameSegment).filter(Boolean)
  const suffix = segments.length ? `${segments.join('-')}-` : ''
  return `rozipay-p2p-${suffix}${date}.png`
}

async function waitForFonts(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts?.ready) return
  try {
    await document.fonts.ready
  } catch {
    // Font-loading readiness is best-effort — never block the export on it.
  }
}

/**
 * Captures a single DOM node (a card) as a PNG blob, excluding any descendant
 * marked with `data-export-exclude="true"`. Never mutates the live DOM — the
 * exclusion happens on a clone created internally by html-to-image.
 */
export async function captureCardAsPngBlob(node: HTMLElement): Promise<Blob> {
  await waitForFonts()

  const pixelRatio = Math.max(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 2)

  // html-to-image sizes its intermediate SVG foreignObject from the node's
  // integer offsetWidth/offsetHeight, which can round a fraction of a css
  // pixel short of the node's true (float) content box — clipping the last
  // line of a card whose height happens to land just past that rounding.
  // Measuring via getBoundingClientRect + rounding UP (with a small buffer)
  // guarantees the capture box is never smaller than the rendered card.
  const rect = node.getBoundingClientRect()
  const width = Math.ceil(rect.width)
  const height = Math.ceil(rect.height) + 2

  const blob = await toBlob(node, {
    cacheBust: true,
    pixelRatio,
    width,
    height,
    imagePlaceholder: TRANSPARENT_PIXEL,
    filter: (domNode) =>
      !(domNode instanceof HTMLElement && domNode.getAttribute(EXPORT_EXCLUDE_ATTR) === 'true'),
  })

  if (!blob) throw new Error('Card image generation returned no data')
  return blob
}

/** Triggers a browser download of `blob` as `filename`, revoking the object
 * URL once the download has had a chance to start. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function canShareFile(file: File): boolean {
  if (typeof navigator === 'undefined' || !navigator.share || !navigator.canShare) return false
  try {
    return navigator.canShare({ files: [file] })
  } catch {
    return false
  }
}

export class ShareCancelledError extends Error {}

/** Reads a blob into a `data:` URL — used to show the generated PNG in an
 * <img> the viewer can long-press to save (the only reliable save path inside
 * the Telegram Mini App WebView, which ignores `blob:` anchor downloads). */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image data'))
    reader.readAsDataURL(blob)
  })
}

/**
 * Telegram's in-app WebView (Android WebView + iOS WKWebView) silently drops
 * programmatic `blob:`/`data:` anchor downloads — no download manager, no
 * error — so `downloadBlob()` is a no-op there even though it "succeeds".
 * This tries the one path Telegram sometimes honors: a direct Web Share API
 * call with the file (NOT gated on `navigator.canShare`, which reports false
 * in Telegram even when `share` works). Resolves 'shared' on success, throws
 * `ShareCancelledError` if the user dismisses the sheet, and resolves
 * 'needs-manual' when sharing isn't available — the caller then shows the
 * long-press-to-save preview.
 */
export async function shareImageInTelegram(
  blob: Blob,
  filename: string,
): Promise<'shared' | 'needs-manual'> {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
    return 'needs-manual'
  }
  const file = new File([blob], filename, { type: 'image/png' })
  try {
    await navigator.share({ files: [file] })
    return 'shared'
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ShareCancelledError()
    }
    return 'needs-manual'
  }
}

/**
 * Shares `blob` via the Web Share API when the browser supports sharing
 * files; otherwise falls back to a direct download. Throws
 * `ShareCancelledError` when the user dismisses the native share sheet, so
 * the caller can skip showing a toast for that case.
 */
export async function shareCardImage(blob: Blob, filename: string): Promise<'shared' | 'downloaded'> {
  const file = new File([blob], filename, { type: 'image/png' })
  if (canShareFile(file)) {
    try {
      await navigator.share({ files: [file] })
      return 'shared'
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ShareCancelledError()
      }
      // Any other share failure (e.g. no share target chosen) — fall back to download.
    }
  }
  downloadBlob(blob, filename)
  return 'downloaded'
}
