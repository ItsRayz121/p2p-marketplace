import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    typecheck: { tsconfig: './tsconfig.test.json' },
    setupFiles: ['./src/test/setup.ts'],
    // Provide the Telegram bot token BEFORE any module (and the env schema)
    // loads — the env module parses process.env at import time, which happens
    // via setup.ts's prisma/redis imports before any test's beforeAll runs.
    // Must equal TEST_BOT_TOKEN in src/lib/__tests__/telegram.test.ts.
    env: {
      TELEGRAM_BOT_TOKEN: '123456:TEST_BOT_TOKEN_FOR_UNIT_TESTS_ONLY',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/test/**', 'src/**/*.d.ts'],
    },
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
})
