'use client'
import { useEffect, useRef, useState } from 'react'
import { Play, Pause } from 'lucide-react'
import { voiceNoteDuration } from '@/lib/utils'

// Only one voice note plays at a time across the whole page.
let activeAudio: HTMLAudioElement | null = null

function fmt(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Inline voice-message player. The audio element is created lazily on the first
 * tap, so merely scrolling past a voice note never downloads it — Cloudinary
 * bandwidth is only spent when someone presses play.
 */
export function VoiceNotePlayer({ url, mine }: { url: string; mine?: boolean }) {
  const knownDuration = voiceNoteDuration(url)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState<number | null>(knownDuration)
  const [failed, setFailed] = useState(false)

  useEffect(() => () => {
    const a = audioRef.current
    if (a) {
      a.pause()
      if (activeAudio === a) activeAudio = null
    }
  }, [])

  const toggle = () => {
    if (failed) return
    let a = audioRef.current
    if (!a) {
      const audio = new Audio()
      audio.preload = 'none'
      audio.src = url.split('#')[0]!
      audio.ontimeupdate = () => setCurrent(audio.currentTime)
      audio.onloadedmetadata = () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration)
      }
      audio.onended = () => { setPlaying(false); setCurrent(0) }
      audio.onpause = () => setPlaying(false)
      audio.onplay = () => setPlaying(true)
      audio.onerror = () => { setFailed(true); setPlaying(false) }
      audioRef.current = audio
      a = audio
    }
    if (a.paused) {
      if (activeAudio && activeAudio !== a) activeAudio.pause()
      activeAudio = a
      void a.play().catch(() => setFailed(true))
    } else {
      a.pause()
    }
  }

  const pct = duration ? Math.min(100, (current / duration) * 100) : 0

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current
    if (!a || !duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    a.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * duration
  }

  return (
    <div className="flex items-center gap-2.5 min-w-[11rem] max-w-full py-0.5">
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
        className={`flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${mine ? 'bg-white/20 text-white' : 'bg-primary/10 text-primary'}`}
      >
        {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
      </button>
      <div className="flex-1 min-w-0">
        <div
          onClick={seek}
          className={`h-1.5 rounded-full cursor-pointer ${mine ? 'bg-white/30' : 'bg-border'}`}
          role="progressbar"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className={`h-full rounded-full ${mine ? 'bg-white' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
        </div>
        <p className={`mt-1 text-[10px] tabular-nums ${mine ? 'text-white/70' : 'text-text-muted'}`}>
          {failed
            ? 'Cannot play on this device'
            : playing || current > 0
              ? `${fmt(current)} / ${duration ? fmt(duration) : '--:--'}`
              : duration ? fmt(duration) : 'Voice message'}
        </p>
      </div>
    </div>
  )
}
