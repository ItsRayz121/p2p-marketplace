import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Unit tests that mock every dependency they touch (*.unit.test.ts). Unlike the default config this
// does not run src/test/setup.ts, so it needs no DATABASE_URL / Redis and can never reach a real database.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.unit.test.ts'],
    testTimeout: 30_000,
  },
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
})
