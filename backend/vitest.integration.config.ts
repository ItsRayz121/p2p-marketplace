import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Opt-in tests that need a REAL Postgres (race conditions and transactions cannot be shown with mocks).
// Run with:  TEST_DATABASE_URL=postgresql://...@localhost:5432/scratch npm run test:integration
// They are excluded from `npm test` and refuse any database that is not on this machine.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 60_000,
    // Provide the env module's required values; the database itself comes from TEST_DATABASE_URL only.
    env: {
      DATABASE_URL: 'postgresql://unused:unused@localhost:1/unused',
      REDIS_URL: 'redis://localhost:1',
      JWT_SECRET: 'integration-test-jwt-secret-0123456789',
      JWT_REFRESH_SECRET: 'integration-test-refresh-0123456789ab',
      CSRF_SECRET: 'integration-test-csrf-0123456789abcd',
      CNIC_HASH_SECRET: 'integration-test-cnic-0123456789abc',
      TELEGRAM_BOT_TOKEN: '123456:TEST_BOT_TOKEN_FOR_UNIT_TESTS_ONLY',
    },
  },
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
})
