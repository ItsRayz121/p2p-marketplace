'use client'
import Link from 'next/link'
import { ArrowLeft, BadgeCheck, Headphones } from 'lucide-react'
import { SupportChatThread } from '@/components/support/SupportChatThread'

/**
 * Full-page RupChain Official support thread. Opened from the Messages inbox so
 * the official channel behaves like the trader threads (back arrow + header +
 * messages + composer) instead of a floating popup. The quick popup launcher
 * (Help Centre / notifications) still uses the same <SupportChatThread/> body.
 *
 * `support` is a static segment, so it takes precedence over the dynamic
 * [threadId] route (thread ids are cuids and never collide with it).
 */
export default function SupportThreadPage() {
  return (
    // Mirror the trader-thread layout: fill the viewport below the navbar and, on
    // mobile, clear the fixed BottomNav so the composer sits just above it.
    <div className="max-w-2xl mx-auto flex flex-col h-[calc(100dvh-4rem)] pb-[calc(4rem+max(1rem,env(safe-area-inset-bottom)))] -mb-[calc(6rem+env(safe-area-inset-bottom))] lg:h-[calc(100dvh-4rem)] lg:pb-0 lg:mb-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface flex-shrink-0">
        <Link href="/messages" className="p-1 -ml-1 rounded hover:bg-muted" aria-label="Back">
          <ArrowLeft className="w-5 h-5 text-text-muted" />
        </Link>
        <span className="w-10 h-10 rounded-full bg-primary/15 flex items-center justify-center flex-shrink-0">
          <Headphones className="w-5 h-5 text-primary" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-text-primary truncate flex items-center gap-1">
            RupChain Official
            <BadgeCheck className="w-4 h-4 text-sky-500 flex-shrink-0" aria-label="Verified" />
          </p>
          <p className="text-[11px] text-text-muted mt-0.5">Support &amp; account help — we typically reply within a few hours</p>
        </div>
      </div>

      {/* Shared chat body (messages + composer) */}
      <div className="flex-1 min-h-0">
        <SupportChatThread />
      </div>
    </div>
  )
}
