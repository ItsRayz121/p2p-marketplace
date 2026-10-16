import 'dotenv/config'
import { assertLocalDatabase } from './localOnly'

assertLocalDatabase()

// Imported only after the safety check above. Starts the API alone: no payment workers, blockchain
// watchers or gas wallet, so it needs none of those secrets.
async function main() {
  const { buildApp } = await import('../../src/app')
  const { connectRedis } = await import('../../src/lib/redis')
  const { db } = await import('../../src/lib/prisma')
  await connectRedis()
  await db.$connect()
  const app = await buildApp()
  await app.listen({ port: 3001, host: '127.0.0.1' })
  console.log('API listening on http://127.0.0.1:3001')
}

main().catch((e) => { console.error(e); process.exit(1) })
