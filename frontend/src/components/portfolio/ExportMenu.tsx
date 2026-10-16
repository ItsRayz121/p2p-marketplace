'use client'

import { useState } from 'react'
import {
  buildBackup, buildCsv, downloadTextFile, exportFileName, type ExportData,
} from '@/lib/portfolio/exportFile'

interface Props {
  load: () => Promise<ExportData>
}

/** Downloads everything the user recorded. Files are built in the browser from the user's own data. */
export function ExportMenu({ load }: Props) {
  const [busy, setBusy] = useState<'csv' | 'json' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run(kind: 'csv' | 'json') {
    setBusy(kind)
    setError(null)
    try {
      const data = await load()
      if (kind === 'csv') downloadTextFile(exportFileName('csv'), buildCsv(data), 'text/csv')
      else downloadTextFile(exportFileName('json'), buildBackup(data), 'application/json')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not prepare the file. Please try again.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 text-xs">
      <span className="text-text-muted">Export</span>
      <button type="button" disabled={busy !== null} onClick={() => run('csv')} className="font-medium text-primary hover:underline disabled:opacity-60">
        {busy === 'csv' ? 'Preparing…' : 'Download CSV'}
      </button>
      <button type="button" disabled={busy !== null} onClick={() => run('json')} className="font-medium text-primary hover:underline disabled:opacity-60">
        {busy === 'json' ? 'Preparing…' : 'Download backup (JSON)'}
      </button>
      {error && <span role="alert" className="text-danger">{error}</span>}
    </div>
  )
}
