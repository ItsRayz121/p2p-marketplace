/**
 * One-off, idempotent fix (2026-06-17): correct the Base chain logo.
 *
 * The Base GasChainConfig.logoUrl pointed at an uploaded image that was the
 * *black/monochrome* Base mark (a black circle with a white bar) — it rendered
 * as a "black stone" on the landing page Crypto Gas Fees tab and the /gas page.
 *
 * This repoints it to the official blue Base symbol (the base-org GitHub
 * organisation avatar — a stable, CDN-served PNG). Reversible: the previous
 * value is printed before the update so it can be restored from the admin
 * Gas → Chains panel or by editing this script.
 *
 * Run on the target DB (Railway):  npm run gas:fix-base-logo
 * Idempotent — safe to run multiple times.
 */

import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

// Official blue Base symbol (base-org GitHub avatar — stable Fastly CDN).
const BASE_LOGO_URL = 'https://avatars.githubusercontent.com/u/108554348'

async function main() {
  console.log('— Fix Base chain logo —\n')

  const base = await db.gasChainConfig.findUnique({ where: { slug: 'BASE' } })
  if (!base) {
    console.warn('⚠ Base chain config not found (slug=BASE) — nothing to do.')
    return
  }

  console.log(`  current logoUrl: ${base.logoUrl ?? '(null)'}`)

  if (base.logoUrl === BASE_LOGO_URL) {
    console.log('  ✓ Already set to the official blue Base logo — no change.')
    return
  }

  await db.gasChainConfig.update({
    where: { id: base.id },
    data: { logoUrl: BASE_LOGO_URL },
  })

  console.log(`  ✓ logoUrl updated → ${BASE_LOGO_URL}`)
  console.log('\n✅ Done. Base now shows the official blue logo on /gas and the landing page.')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
