import { parseBackup, MAX_BACKUP_BYTES, type ExportData } from '../exportFile'
import { decryptBackup, isEncryptedBackup } from './encryptedBackup'

export type LoadedBackup =
  | { status: 'ok'; data: ExportData }
  | { status: 'needs-passphrase' }
  | { status: 'error'; error: string }

/** Read a chosen file as text. (FileReader works everywhere, including older Safari.) */
export function readFileAsText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result ?? ''))
    r.onerror = () => reject(r.error ?? new Error('Could not read the file'))
    r.readAsText(file)
  })
}

/**
 * Turn the text of a backup file into validated data. Plain and encrypted backups are both
 * accepted; an encrypted one asks for the passphrase first. Nothing is partly loaded: either the
 * whole file is valid or it is rejected.
 */
export async function loadBackup(text: string, passphrase?: string): Promise<LoadedBackup> {
  if (text.length > MAX_BACKUP_BYTES * 1.5) return { status: 'error', error: 'This file is too large to be a portfolio backup.' }
  let plain = text
  if (isEncryptedBackup(text)) {
    if (!passphrase) return { status: 'needs-passphrase' }
    const d = await decryptBackup(text, passphrase)
    if (!d.ok) return { status: 'error', error: d.error }
    plain = d.text
  }
  const parsed = parseBackup(plain)
  return parsed.ok ? { status: 'ok', data: parsed.data } : { status: 'error', error: parsed.error }
}
