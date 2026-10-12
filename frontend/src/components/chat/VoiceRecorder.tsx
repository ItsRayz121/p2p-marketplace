'use client'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Mic, Trash2, Send } from 'lucide-react'
import { useFileUpload } from '@/hooks/useFileUpload'
import { toast } from '@/lib/toast'

export interface VoiceRecorderHandle {
  /** Start recording in tap mode (cancel/send buttons) — used by the "+" menu entry. */
  start: () => void
}

interface Props {
  /** Hard cap on clip length in seconds (60 for DMs, 120 for channels). */
  maxSeconds: number
  disabled?: boolean
  /** Called with the uploaded clip URL (carries `#d=<seconds>`). The parent posts it as a message. */
  onSend: (url: string) => void | Promise<void>
  /** Shown instead of the mic button when `showMic` is false (the parent's normal Send button). */
  children?: React.ReactNode
  showMic: boolean
  micClassName?: string
}

const HOLD_MS = 350
const CANCEL_DRAG_PX = 80
const MIN_SECONDS = 1

function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t))
}

function fmt(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}

/**
 * Voice-message recorder. Three ways in, all the same recorder:
 *  - tap the mic        -> recording bar with cancel / send buttons
 *  - press-and-hold mic -> records while held; release sends, drag left to cancel
 *  - `ref.start()`      -> same as tap, for the "+" attachment menu
 * Speech is encoded at ~24 kbps (about 180 KB per minute) and uploaded straight to
 * Cloudinary, so the clip never touches the API server. The parent composer row
 * must be `relative` — the recording bar overlays it.
 */
export const VoiceRecorder = forwardRef<VoiceRecorderHandle, Props>(function VoiceRecorder(
  { maxSeconds, disabled, onSend, children, showMic, micClassName },
  ref,
) {
  const { upload } = useFileUpload('voice-note')
  const [phase, setPhase] = useState<'idle' | 'recording' | 'uploading'>('idle')
  const [mode, setMode] = useState<'tap' | 'hold'>('tap')
  const [elapsed, setElapsed] = useState(0)
  const [willCancel, setWillCancel] = useState(false)

  const recRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startedAtRef = useRef(0)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const discardRef = useRef(false)
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const holdFiredRef = useRef(false)
  const downXRef = useRef(0)
  const startingRef = useRef(false)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  // rec.onstop outlives the render it was created in; reading onSend through a ref
  // makes sure the parent's CURRENT send() (fresh reply target, thread state) is used.
  const onSendRef = useRef(onSend)
  onSendRef.current = onSend

  const cleanup = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    recRef.current = null
  }, [])

  // Unmount (navigating away mid-recording) discards the clip and releases the mic.
  useEffect(() => () => {
    discardRef.current = true
    if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop()
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current)
    cleanup()
  }, [cleanup])

  const finish = useCallback((send: boolean) => {
    const rec = recRef.current
    if (!rec || rec.state === 'inactive') return
    discardRef.current = !send
    rec.stop() // rec.onstop (set in start) uploads or discards
  }, [])

  const start = useCallback(async (m: 'tap' | 'hold') => {
    if (phaseRef.current !== 'idle' || startingRef.current || disabled) return
    const mime = pickMime()
    if (!navigator.mediaDevices?.getUserMedia || !mime) {
      toast.error('Voice messages unavailable', 'This browser cannot record audio.')
      return
    }
    startingRef.current = true
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      // A hold released while the permission prompt was open must not start a ghost recording.
      if (m === 'hold' && !holdFiredRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 24000 })
      recRef.current = rec
      chunksRef.current = []
      discardRef.current = false
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      rec.onstop = async () => {
        const secs = Math.round((Date.now() - startedAtRef.current) / 1000)
        const blob = new Blob(chunksRef.current, { type: mime.split(';')[0] })
        const discard = discardRef.current
        cleanup()
        if (discard) {
          setPhase('idle'); setElapsed(0); setWillCancel(false)
          return
        }
        if (secs < MIN_SECONDS || blob.size === 0) {
          setPhase('idle'); setElapsed(0); setWillCancel(false)
          toast.error('Too short', 'Voice messages must be at least 1 second.')
          return
        }
        setPhase('uploading')
        try {
          const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'
          const url = await upload(new File([blob], `voice.${ext}`, { type: blob.type }))
          await onSendRef.current(`${url}#d=${Math.min(secs, maxSeconds)}`)
        } catch (err) {
          toast.error('Voice message failed', err instanceof Error ? err.message : 'Please try again')
        } finally {
          setPhase('idle'); setElapsed(0); setWillCancel(false)
        }
      }
      startedAtRef.current = Date.now()
      rec.start(1000)
      setMode(m)
      setPhase('recording')
      setElapsed(0)
      tickRef.current = setInterval(() => {
        const s = Math.floor((Date.now() - startedAtRef.current) / 1000)
        setElapsed(s)
        if (s >= maxSeconds) finish(true)
      }, 250)
    } catch (err) {
      const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
      toast.error(
        denied ? 'Microphone blocked' : 'Could not start recording',
        denied ? 'Allow microphone access in your browser settings.' : 'Please try again.',
      )
      cleanup()
    } finally {
      startingRef.current = false
    }
  }, [cleanup, disabled, finish, maxSeconds, upload])

  useImperativeHandle(ref, () => ({ start: () => void start('tap') }), [start])

  // --- mic button: tap vs press-and-hold -----------------------------------
  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled || phaseRef.current !== 'idle') return
    e.currentTarget.setPointerCapture(e.pointerId)
    downXRef.current = e.clientX
    holdFiredRef.current = false
    holdTimerRef.current = setTimeout(() => {
      holdFiredRef.current = true
      void start('hold')
    }, HOLD_MS)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!holdFiredRef.current || phaseRef.current !== 'recording') return
    setWillCancel(e.clientX - downXRef.current < -CANCEL_DRAG_PX)
  }
  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const timerPending = holdTimerRef.current !== null
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null }
    if (holdFiredRef.current) {
      holdFiredRef.current = false
      if (phaseRef.current === 'recording') finish(e.clientX - downXRef.current >= -CANCEL_DRAG_PX)
    } else if (timerPending && phaseRef.current === 'idle') {
      void start('tap') // released before the hold threshold = a tap
    }
  }
  const onPointerCancel = () => {
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null }
    if (holdFiredRef.current) {
      holdFiredRef.current = false
      if (phaseRef.current === 'recording') finish(false)
    }
  }

  const active = phase !== 'idle'

  return (
    <>
      {/* The mic button stays mounted while a hold-recording is live: unmounting it
          would drop the pointer capture and the release (= send) would never fire. */}
      {showMic ? (
        <button
          type="button"
          disabled={disabled}
          aria-label="Record voice message (tap, or hold to record)"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onContextMenu={(e) => e.preventDefault()}
          style={{ touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none' }}
          className={`${micClassName ?? 'p-2.5 rounded-full bg-primary text-white disabled:opacity-50 flex-shrink-0'} relative z-20 ${active && (mode === 'tap' || phase === 'uploading') ? 'invisible' : ''}`}
        >
          <Mic className="w-4 h-4" />
        </button>
      ) : (!active && children)}

      {active && (
        <div className="absolute inset-0 z-10 flex items-center gap-3 bg-surface px-3" role="status" aria-live="polite">
          {phase === 'uploading' ? (
            <p className="flex-1 text-sm text-text-muted">Sending voice message…</p>
          ) : (
            <>
              {mode === 'tap' && (
                <button type="button" onClick={() => finish(false)} aria-label="Cancel recording" className="p-2 rounded-full text-danger hover:bg-danger/10">
                  <Trash2 className="w-5 h-5" />
                </button>
              )}
              <span className={`inline-block w-2.5 h-2.5 rounded-full bg-danger ${willCancel ? '' : 'animate-pulse'}`} />
              <span className="text-sm font-semibold tabular-nums text-text-primary">{fmt(elapsed)}</span>
              <span className="text-xs text-text-muted">/ {fmt(maxSeconds)}</span>
              <p className={`flex-1 text-right text-xs ${willCancel ? 'text-danger font-semibold' : 'text-text-muted'}`}>
                {mode === 'hold' ? (willCancel ? 'Release to cancel' : '← Slide to cancel') : 'Recording…'}
              </p>
              {mode === 'tap' && (
                <button type="button" onClick={() => finish(true)} aria-label="Send voice message" className="p-2.5 rounded-full bg-primary text-white flex-shrink-0">
                  <Send className="w-4 h-4" />
                </button>
              )}
            </>
          )}
        </div>
      )}
    </>
  )
})
