// Global test setup — runs before every test file
// Real DB + Redis connections (no mocks — see DB_TRANSACTION_RULES.md note on why)

import { db } from '../lib/prisma'
import { redis } from '../lib/redis'

beforeAll(async () => {
  await db.$connect()
  // ioredis throws "already connecting/connected" if connect() is called twice.
  // Only connect when the client is idle (status 'wait') so files sharing the
  // singleton across a worker don't crash on a redundant connect.
  if (redis.status === 'wait') {
    await redis.connect()
  }
})

afterAll(async () => {
  await db.$disconnect()
  if (redis.status === 'ready' || redis.status === 'connecting' || redis.status === 'connect') {
    await redis.quit().catch(() => {})
  }
})
