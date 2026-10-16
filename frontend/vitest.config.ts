import { defineConfig } from 'vitest/config'
import path from 'node:path'

// UI/component tests only. The existing node:test files in tests/*.test.mts keep running via `npm test`.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    environment: 'jsdom',
    include: ['tests/ui/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/ui/setup.ts'],
    globals: true,
  },
})
