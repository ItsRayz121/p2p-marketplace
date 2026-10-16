import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The browser (local-only guest tracker) runs the SAME calculation engine as the server. The files
 * are copied rather than shared across packages, so this guard fails the build if either copy is
 * edited without the other. Every number a guest sees is then produced by code the server tests cover.
 */
const FE = path.resolve(__dirname, '../../../../../frontend/src/lib/portfolio/engine')
const BE = path.resolve(__dirname, '..')

describe('calculation engine: server and browser copies are identical', () => {
  it.each(['decimal', 'fifo', 'figures', 'currency', 'summaryBuilder', 'performance'])('%s.ts', (name) => {
    const be = readFileSync(path.join(BE, `${name}.ts`), 'utf8')
    const fe = readFileSync(path.join(FE, `${name}.ts`), 'utf8')
    expect(fe).toBe(be)
  })
})
