/** Every local-stack script calls this first: it refuses to run against any database that is not on this machine. */
export function assertLocalDatabase(): void {
  const raw = process.env.DATABASE_URL ?? ''
  let host = ''
  try { host = new URL(raw).hostname } catch { /* handled below */ }
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== '[::1]') {
    console.error(`Refusing to run: DATABASE_URL must point at localhost (got "${host || 'nothing'}"). Check backend/.env.`)
    process.exit(1)
  }
}
