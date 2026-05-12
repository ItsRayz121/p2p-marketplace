// Global test setup — runs before every test file
// Real DB + Redis connections (no mocks — see DB_TRANSACTION_RULES.md note on why)

import { db } from '../lib/prisma'
import { redis } from '../lib/redis'

beforeAll(async () => {
  await db.$connect()
  await redis.connect()
})

afterAll(async () => {
  await db.$disconnect()
  await redis.quit()
})
