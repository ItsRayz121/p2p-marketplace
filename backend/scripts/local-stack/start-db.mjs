// Starts a throwaway Postgres for local testing (see README.md). Run from a folder where
// `npm i embedded-postgres` has been done. Data lives in ./rupchain-local-pg and survives restarts.
import fs from 'node:fs'

let EmbeddedPostgres
try {
  EmbeddedPostgres = (await import('embedded-postgres')).default
} catch {
  console.error('embedded-postgres is not installed here. Run: npm init -y && npm i embedded-postgres')
  process.exit(1)
}

const dir = './rupchain-local-pg'
const pg = new EmbeddedPostgres({
  databaseDir: dir, user: 'postgres', password: 'pw', port: 54329, persistent: true,
  // UTF-8 is required: the default encoding on Windows breaks the migrations.
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
})
if (!fs.existsSync(`${dir}/PG_VERSION`)) await pg.initialise()
await pg.start()
try { await pg.createDatabase('rup') } catch { /* already exists */ }
console.log('Postgres ready on localhost:54329 (database "rup", user "postgres", password "pw"). Ctrl+C to stop.')
setInterval(() => {}, 1 << 30)
