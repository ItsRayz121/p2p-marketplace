'use client'
import type { UploadProgress as UploadProgressData } from '@/hooks/useFileUpload'

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1)
}

/**
 * Thin upload progress bar with a live "uploaded MB / total MB" readout.
 * Fed by the `progress` value from useFileUpload — render only while it's non-null.
 * Before the first network tick (pct 0) it still shows the total size so the user
 * sees how big the file is straight away.
 */
export function UploadProgress({ progress, className = '' }: { progress: UploadProgressData; className?: string }) {
  const { loaded, total, pct } = progress
  return (
    <div className={`w-full ${className}`}>
      <div className="flex items-center justify-between text-[10px] text-text-muted mb-1">
        <span>Uploading… {pct}%</span>
        <span className="tabular-nums">{mb(loaded)} / {mb(total)} MB</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
          style={{ width: `${Math.max(pct, 4)}%` }}
        />
      </div>
    </div>
  )
}
