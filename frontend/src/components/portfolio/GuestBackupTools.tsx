'use client'

import { useId, useState } from 'react'
import { downloadTextFile } from '@/lib/portfolio/exportFile'
import type { ExportData } from '@/lib/portfolio/exportFile'
import { encryptBackup, passphraseProblem } from '@/lib/portfolio/local/encryptedBackup'
import { loadBackup, readFileAsText } from '@/lib/portfolio/local/backupFile'

interface Props {
  /** Plain JSON text of everything on this device. */
  backupText: () => string
  counts: () => { assets: number; events: number }
  onRestore: (data: ExportData) => Promise<void>
  onClear: () => Promise<void>
}

const stamp = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const field = 'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary'
const btn = 'px-3 py-2 text-sm font-semibold rounded-lg border border-border text-text-primary hover:bg-surface-hover disabled:opacity-60'

/** Backup, restore and erase for the local-only tracker. Nothing here uses the network. */
export function GuestBackupTools({ backupText, counts, onRestore, onClear }: Props) {
  const uid = useId()
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [encError, setEncError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [pending, setPending] = useState<{ text: string; needsPass: boolean } | null>(null)
  const [restorePass, setRestorePass] = useState('')
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [ready, setReady] = useState<ExportData | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  function plainBackup() {
    downloadTextFile(`rupchain-portfolio-backup-${stamp()}.json`, backupText(), 'application/json')
  }

  async function encryptedBackup() {
    setEncError(null)
    const problem = passphraseProblem(pass)
    if (problem) return setEncError(problem)
    if (pass !== pass2) return setEncError('The two passphrases do not match.')
    setBusy(true)
    try {
      downloadTextFile(`rupchain-portfolio-encrypted-${stamp()}.json`, await encryptBackup(backupText(), pass), 'application/json')
      setPass(''); setPass2('')
    } catch (e) {
      setEncError(e instanceof Error ? e.message : 'Could not encrypt the backup.')
    } finally {
      setBusy(false)
    }
  }

  async function chooseFile(file: File | undefined) {
    setRestoreError(null); setReady(null); setPending(null); setNotice(null); setRestorePass('')
    if (!file) return
    try {
      const text = await readFileAsText(file)
      const r = await loadBackup(text)
      if (r.status === 'ok') setReady(r.data)
      else if (r.status === 'needs-passphrase') setPending({ text, needsPass: true })
      else setRestoreError(r.error)
    } catch {
      setRestoreError('Could not read that file.')
    }
  }

  async function unlock() {
    if (!pending) return
    setBusy(true); setRestoreError(null)
    try {
      const r = await loadBackup(pending.text, restorePass)
      if (r.status === 'ok') { setReady(r.data); setPending(null) }
      else setRestoreError(r.status === 'error' ? r.error : 'Enter the passphrase.')
    } finally { setBusy(false) }
  }

  async function restore() {
    if (!ready) return
    setBusy(true)
    try {
      await onRestore(ready)
      setNotice(`Restored ${ready.assets.length} ${ready.assets.length === 1 ? 'token' : 'tokens'} and ${ready.events.length} ${ready.events.length === 1 ? 'entry' : 'entries'}.`)
      setReady(null)
    } catch (e) {
      setRestoreError(e instanceof Error ? e.message : 'Could not restore the backup.')
    } finally { setBusy(false) }
  }

  const here = counts()

  return (
    <section aria-labelledby={`${uid}-h`} className="rounded-xl border border-border bg-surface p-4 space-y-5">
      <div>
        <h2 id={`${uid}-h`} className="text-base font-semibold text-text-primary">Back up and restore</h2>
        <p className="text-xs text-text-muted mt-1">
          Your records exist only in this browser. If you clear site data, use a private window or lose this device, they are gone, and RupChain cannot recover them. Save a backup file somewhere safe.
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-text-primary">Download a backup</h3>
        <button type="button" onClick={plainBackup} className={btn}>Download plain backup (readable by anyone who has the file)</button>
        <div className="space-y-2 pt-2">
          <label htmlFor={`${uid}-p1`} className="text-sm font-medium text-text-primary block">Passphrase for an encrypted backup</label>
          <input id={`${uid}-p1`} type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} className={field} />
          <label htmlFor={`${uid}-p2`} className="text-sm font-medium text-text-primary block">Repeat the passphrase</label>
          <input id={`${uid}-p2`} type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} className={field} />
          <p className="text-xs text-text-muted">
            The passphrase is never stored or sent anywhere. If you forget it, the encrypted file cannot be opened. Encryption protects the file; it does not protect this device from other software on it.
          </p>
          {encError && <p role="alert" className="text-sm text-danger">{encError}</p>}
          <button type="button" disabled={busy} onClick={encryptedBackup} className={btn}>{busy ? 'Encrypting…' : 'Download encrypted backup'}</button>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-text-primary">Restore from a backup</h3>
        <label htmlFor={`${uid}-file`} className="text-sm text-text-primary block">Choose a backup file (.json)</label>
        <input id={`${uid}-file`} type="file" accept=".json,application/json" onChange={(e) => void chooseFile(e.target.files?.[0])} className="text-sm" />
        {pending && (
          <div className="space-y-2">
            <label htmlFor={`${uid}-rp`} className="text-sm font-medium text-text-primary block">This backup is encrypted. Passphrase</label>
            <input id={`${uid}-rp`} type="password" autoComplete="off" value={restorePass} onChange={(e) => setRestorePass(e.target.value)} className={field} />
            <button type="button" disabled={busy || !restorePass} onClick={unlock} className={btn}>Unlock backup</button>
          </div>
        )}
        {ready && (
          <div role="status" className="space-y-2 rounded-lg border border-border p-3">
            <p className="text-sm text-text-primary">
              This backup has {ready.assets.length} {ready.assets.length === 1 ? 'token' : 'tokens'} and {ready.events.length} {ready.events.length === 1 ? 'entry' : 'entries'}.
            </p>
            {(here.assets > 0 || here.events > 0) && (
              <p className="text-sm text-amber-800">
                Restoring replaces what is on this device now ({here.assets} {here.assets === 1 ? 'token' : 'tokens'}, {here.events} {here.events === 1 ? 'entry' : 'entries'}). Download a backup first if you want to keep it.
              </p>
            )}
            <button type="button" disabled={busy} onClick={restore} className={btn}>Restore this backup</button>
          </div>
        )}
        {restoreError && <p role="alert" className="text-sm text-danger">{restoreError}</p>}
        {notice && <p role="status" className="text-sm text-text-primary">{notice}</p>}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-text-primary">Erase everything on this device</h3>
        {confirmClear ? (
          <div className="flex flex-wrap gap-3 items-center text-sm">
            <span className="text-danger">This deletes every token, entry and price stored in this browser. It cannot be undone.</span>
            <button type="button" className="font-medium text-danger hover:underline" onClick={async () => { await onClear(); setConfirmClear(false); setNotice('Everything on this device was erased.') }}>Yes, erase everything</button>
            <button type="button" className="text-text-muted hover:underline" onClick={() => setConfirmClear(false)}>Keep my data</button>
          </div>
        ) : (
          <button type="button" className="text-sm text-text-muted hover:text-danger hover:underline" onClick={() => setConfirmClear(true)}>Erase everything on this device</button>
        )}
      </div>
    </section>
  )
}
