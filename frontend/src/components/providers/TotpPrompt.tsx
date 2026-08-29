'use client'
import { useSyncExternalStore, useState, useEffect, useRef } from 'react'
import { subscribeTotp, isTotpPromptOpen, resolveTotp } from '@/lib/totpPrompt'

// Styled replacement for the native window.prompt used by the TOTP step-up.
// Mounted once at the app root; driven entirely by lib/totpPrompt.ts so any
// API call can trigger it. A single instance serves all concurrent callers.
export function TotpPrompt() {
  const open = useSyncExternalStore(subscribeTotp, isTotpPromptOpen, () => false)
  const [code, setCode] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setCode('')
      // Focus shortly after mount so the field is ready to type into.
      const t = setTimeout(() => inputRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
    return undefined
  }, [open])

  if (!open) return null

  const digits = code.replace(/\D/g, '').slice(0, 6)
  const valid = digits.length === 6

  function submit() {
    if (!valid) return
    resolveTotp(digits)
  }
  function cancel() {
    resolveTotp(null)
  }

  return (
    // pointer-events-auto is REQUIRED: this prompt is frequently triggered by an
    // API call fired from inside a Radix Dialog (admin confirm modals), and Radix
    // sets `body { pointer-events: none }` while its modal is open. Without this
    // override the code field still takes keyboard input but the Confirm button
    // is dead ("stale button"). z-index sits above Radix's z-50 content.
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 pointer-events-auto"
      onClick={cancel}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-surface border border-border shadow-xl p-5 space-y-4 pointer-events-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="space-y-1">
          <h2 className="text-base font-bold text-text-primary">Confirm with 2FA</h2>
          <p className="text-xs text-text-muted">
            Enter the 6-digit code from your authenticator app. You won&apos;t be asked again for a few minutes.
          </p>
        </div>
        <input
          ref={inputRef}
          value={digits}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') cancel() }}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="123456"
          className="w-full text-center tracking-[0.4em] font-mono text-lg px-3 py-2.5 rounded-lg border border-border bg-canvas text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <div className="flex gap-2">
          <button
            onClick={submit}
            disabled={!valid}
            className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            Confirm
          </button>
          <button
            onClick={cancel}
            className="rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-text-secondary hover:bg-surface-alt transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
