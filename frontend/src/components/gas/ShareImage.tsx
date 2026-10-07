'use client'

import { useEffect, useRef, useState } from 'react'
import { Download, Share2, Copy } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { toast } from '@/lib/toast'

export interface ShareImageCard {
  amount: string
  symbol: string
  chainName: string
  paidWith: 'PKR' | 'USDT'
}

const W = 1200
const H = 675
/** Drop a 1200x675 PNG at public/brand/share-bg.png to replace the built-in background. */
const BG_SRC = '/brand/share-bg.png'
const LOGO_SRC = '/brand/icon-512.png'

const HEADLINES = [
  (c: ShareImageCard) => `I just bought ${c.amount} ${c.symbol} gas`,
  (c: ShareImageCard) => `Topped up ${c.amount} ${c.symbol} for gas`,
  (c: ShareImageCard) => `Got ${c.amount} ${c.symbol} for ${c.chainName} fees`,
]

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    const test = line ? `${line} ${w}` : w
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w } else line = test
  }
  if (line) lines.push(line)
  return lines
}

/**
 * Branded share image: fixed RupChain logo + wordmark, one short headline about the order,
 * and the site address. Rendered client-side on a canvas so it can be downloaded (or shared
 * through the phone share sheet) and attached to the X post.
 */
export function ShareImage({ card, variant, text }: { card: ShareImageCard; variant: number; text?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)
  const [canShareFiles, setCanShareFiles] = useState(false)

  // Detect file sharing after mount so server and client markup match (no hydration warning).
  useEffect(() => {
    try {
      setCanShareFiles(typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File([''], 'x.png', { type: 'image/png' })] }))
    } catch { setCanShareFiles(false) }
  }, [])

  useEffect(() => {
    let live = true
    setReady(false)
    ;(async () => {
      const [bg, logo] = await Promise.all([loadImage(BG_SRC), loadImage(LOGO_SRC)])
      const canvas = canvasRef.current
      if (!live || !canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      // Background: supplied artwork, else a navy to teal gradient with soft glows.
      if (bg) {
        ctx.drawImage(bg, 0, 0, W, H)
      } else {
        const g = ctx.createLinearGradient(0, 0, W, H)
        g.addColorStop(0, '#0D1B2A')
        g.addColorStop(1, '#0b5563')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, W, H)
        const glow = ctx.createRadialGradient(W * 0.85, H * 0.15, 10, W * 0.85, H * 0.15, 420)
        glow.addColorStop(0, 'rgba(34,211,238,0.35)')
        glow.addColorStop(1, 'rgba(34,211,238,0)')
        ctx.fillStyle = glow
        ctx.fillRect(0, 0, W, H)
      }

      // Fixed logo + wordmark (top-left).
      if (logo) {
        ctx.save()
        roundRect(ctx, 64, 56, 84, 84, 19)
        ctx.clip()
        ctx.drawImage(logo, 64, 56, 84, 84)
        ctx.restore()
      }
      ctx.fillStyle = '#ffffff'
      ctx.font = '700 44px system-ui, -apple-system, "Segoe UI", sans-serif'
      ctx.textBaseline = 'middle'
      ctx.fillText('RupChain', 168, 98)

      // Headline (minimal text).
      const headline = HEADLINES[variant % HEADLINES.length]!(card)
      ctx.fillStyle = '#ffffff'
      ctx.font = '800 82px system-ui, -apple-system, "Segoe UI", sans-serif'
      ctx.textBaseline = 'alphabetic'
      const lines = wrapLines(ctx, headline, W - 128)
      let y = 330
      for (const l of lines.slice(0, 3)) { ctx.fillText(l, 64, y); y += 96 }

      ctx.fillStyle = 'rgba(255,255,255,0.78)'
      ctx.font = '500 38px system-ui, -apple-system, "Segoe UI", sans-serif'
      ctx.fillText(`Paid in ${card.paidWith}. Delivered in minutes.`, 64, y + 18)

      // Footer address.
      ctx.fillStyle = '#67e8f9'
      ctx.font = '700 40px system-ui, -apple-system, "Segoe UI", sans-serif'
      ctx.fillText('rupchain.com/gas', 64, H - 60)

      if (live) setReady(true)
    })()
    return () => { live = false }
  }, [card, variant])

  function toBlob(): Promise<Blob | null> {
    return new Promise((resolve) => canvasRef.current?.toBlob((b) => resolve(b), 'image/png'))
  }

  async function download() {
    const blob = await toBlob()
    if (!blob) return toast.error('Could not create the image')
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'rupchain-gas-order.png'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  async function copyImage() {
    const blob = await toBlob()
    if (!blob) return toast.error('Could not create the image')
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      toast.success('Image copied. Paste it into your post.')
    } catch {
      toast.error('Copy is not supported here. Use Download image instead.')
    }
  }

  async function share() {
    const blob = await toBlob()
    if (!blob) return toast.error('Could not create the image')
    const file = new File([blob], 'rupchain-gas-order.png', { type: 'image/png' })
    try {
      // Text + image together: the phone share sheet hands both to the X app.
      await navigator.share({ files: [file], ...(text ? { text } : {}) })
    } catch { /* user cancelled */ }
  }

  return (
    <div className="space-y-2">
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        aria-label="Share image preview"
        className={`w-full h-auto rounded-lg border border-border transition-opacity ${ready ? 'opacity-100' : 'opacity-0'}`}
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={download}><Download className="h-3.5 w-3.5" /> Download image</Button>
        <Button size="sm" variant="secondary" onClick={copyImage}><Copy className="h-3.5 w-3.5" /> Copy image</Button>
        {canShareFiles && <Button size="sm" variant="secondary" onClick={share}><Share2 className="h-3.5 w-3.5" /> Share text + image</Button>}
      </div>
      <p className="text-[11px] text-text-muted">The post link shows this image automatically on X. On a phone, the Share text + image button sends both together.</p>
    </div>
  )
}
