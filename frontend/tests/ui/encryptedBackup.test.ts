import { describe, it, expect } from 'vitest'
import { decryptBackup, encryptBackup, isEncryptedBackup, passphraseProblem, ENC_FORMAT } from '@/lib/portfolio/local/encryptedBackup'

// Fewer iterations keep the test fast; the production default is exercised once below.
const FAST = 100_000
const secret = JSON.stringify({ note: 'my holdings', n: [1, 2, 3], unicode: 'مرحبا ✓' })

describe('encrypted backup', () => {
  it('round-trips with the right passphrase', async () => {
    const file = await encryptBackup(secret, 'correct horse battery', FAST)
    const r = await decryptBackup(file, 'correct horse battery')
    expect(r).toEqual({ ok: true, text: secret })
  })
  it('the file does not contain the plaintext', async () => {
    const file = await encryptBackup(secret, 'correct horse battery', FAST)
    expect(file).not.toContain('my holdings')
    expect(file).not.toContain('holdings')
    expect(JSON.parse(file).format).toBe(ENC_FORMAT)
  })
  it('a wrong passphrase is refused with a generic message', async () => {
    const file = await encryptBackup(secret, 'correct horse battery', FAST)
    expect(await decryptBackup(file, 'wrong passphrase!')).toEqual({ ok: false, error: 'Wrong passphrase, or the file is damaged.' })
  })
  it('the passphrase is normalised so the same text typed differently still unlocks', async () => {
    const file = await encryptBackup(secret, 'café-passphrase', FAST)
    expect((await decryptBackup(file, 'café-passphrase')).ok).toBe(true)
  })
  it('each file is different (fresh random salt and IV), even for the same data and passphrase', async () => {
    const a = JSON.parse(await encryptBackup(secret, 'correct horse battery', FAST))
    const b = JSON.parse(await encryptBackup(secret, 'correct horse battery', FAST))
    expect(a.kdf.salt).not.toBe(b.kdf.salt)
    expect(a.cipher.iv).not.toBe(b.cipher.iv)
    expect(a.data).not.toBe(b.data)
  })
  it('any change to the file is detected (ciphertext, settings or salt)', async () => {
    const good = JSON.parse(await encryptBackup(secret, 'correct horse battery', FAST))
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1)
    const tampered = [
      { ...good, data: flip(good.data) },
      { ...good, kdf: { ...good.kdf, iterations: good.kdf.iterations + 1 } },
      { ...good, kdf: { ...good.kdf, salt: flip(good.kdf.salt) } },
      { ...good, cipher: { ...good.cipher, iv: flip(good.cipher.iv) } },
    ]
    for (const t of tampered) expect((await decryptBackup(JSON.stringify(t), 'correct horse battery')).ok).toBe(false)
  })
  it('rejects files that are not encrypted backups', async () => {
    for (const bad of ['{nope', '{"format":"other"}', '[]', '{"format":"rupchain-portfolio-encrypted","version":2}']) {
      expect((await decryptBackup(bad, 'whatever123')).ok).toBe(false)
    }
  })
  it('a hostile file cannot demand an absurd amount of work', async () => {
    const good = JSON.parse(await encryptBackup(secret, 'correct horse battery', FAST))
    const started = Date.now()
    const r = await decryptBackup(JSON.stringify({ ...good, kdf: { ...good.kdf, iterations: 2_000_000_000 } }), 'correct horse battery')
    expect(r.ok).toBe(false)
    expect(Date.now() - started).toBeLessThan(2000) // rejected up front, not computed
  })
  it('refuses a weak passphrase before doing anything', async () => {
    await expect(encryptBackup(secret, 'short', FAST)).rejects.toThrow(/at least 8/)
    expect(passphraseProblem('short')).toMatch(/at least 8/)
    expect(passphraseProblem('long enough passphrase')).toBeNull()
  })
  it('recognises an encrypted file by its format only', () => {
    expect(isEncryptedBackup(JSON.stringify({ format: ENC_FORMAT }))).toBe(true)
    expect(isEncryptedBackup('{"format":"rupchain-portfolio-backup"}')).toBe(false)
    expect(isEncryptedBackup('not json')).toBe(false)
  })
  it('works with the production iteration count', async () => {
    const file = await encryptBackup('x', 'a long enough passphrase')
    expect(JSON.parse(file).kdf.iterations).toBe(600_000)
    expect((await decryptBackup(file, 'a long enough passphrase')).ok).toBe(true)
  }, 30_000)
})
