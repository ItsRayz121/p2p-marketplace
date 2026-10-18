import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Listings, deposits, withdrawals and transfers must never become portfolio purchases or sales, and the
 * portfolio must never write to custody, listing, order or settlement tables. Wallet and listing figures are
 * read ONLY as context for the cutover's reconciliation record.
 */
const SRC = path.resolve(__dirname, '../../..')
const FILES = [
  'routes/portfolio.routes.ts', 'services/portfolioPeriod.service.ts', 'services/portfolioSnapshot.service.ts', 'services/portfolioDump.service.ts',
  'services/portfolioImport.service.ts', 'services/portfolioUsdtImport.service.ts', 'services/portfolioRestore.service.ts', 'services/portfolioMarks.service.ts',
]
const WRITE = /\b(?:db|tx)\.(wallet|transaction|ctmListing|ctmTrade|ctmRequest|trade|ad|withdrawal|dispute)\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\b/

describe('the portfolio never writes outside its own tables', () => {
  it.each(FILES)('%s', (f) => {
    expect(readFileSync(path.join(SRC, f), 'utf8')).not.toMatch(WRITE)
  })
  it('wallet and listing tables are touched only by the cutover context read (read-only)', () => {
    const src = readFileSync(path.join(SRC, 'services/portfolioPeriod.service.ts'), 'utf8')
    expect(src.match(/db\.(wallet|ctmListing)\.(\w+)/g)).toEqual(['db.wallet.findMany', 'db.ctmListing.findMany'])
    for (const f of FILES.filter((x) => x !== 'services/portfolioPeriod.service.ts')) {
      expect(readFileSync(path.join(SRC, f), 'utf8')).not.toMatch(/\b(?:db|tx)\.(wallet|ctmListing)\./)
    }
  })
  it('nothing in the importers reads listings: a listing is inventory context, never a purchase or sale', () => {
    for (const f of ['services/portfolioImport.service.ts', 'services/portfolioUsdtImport.service.ts']) {
      expect(readFileSync(path.join(SRC, f), 'utf8')).not.toMatch(/ctmListing|\.listing\./)
    }
  })
})
