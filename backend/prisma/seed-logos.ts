/**
 * Seed script: populate LogoRegistry with static Clearbit logo URLs for all
 * Pakistani payment methods and banks.
 *
 * Run with:
 *   npx tsx prisma/seed-logos.ts
 *
 * Idempotent — upserts by (type, slug). Safe to re-run; existing admin-uploaded
 * logos are NOT overwritten (update only fires when logoUrl has changed).
 */

import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

// Sources: icon.horse (icon CDN), t2.gstatic.com (Google favicon at 128px),
//          cdn.worldvectorlogo.com (vector SVG CDN) — all verified working.
const LOGOS: Array<{ type: string; slug: string; logoUrl: string }> = [
  // ── Payment Methods ────────────────────────────────────────────────────────
  { type: 'payment_method', slug: 'jazzcash',  logoUrl: 'https://icon.horse/icon/jazzcash.com.pk' },
  { type: 'payment_method', slug: 'easypaisa', logoUrl: 'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://easypaisa.com.pk&size=128' },
  { type: 'payment_method', slug: 'sadapay',   logoUrl: 'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://sadapay.pk&size=128' },
  { type: 'payment_method', slug: 'nayapay',   logoUrl: 'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://nayapay.com&size=128' },

  // ── Banks ──────────────────────────────────────────────────────────────────
  { type: 'bank', slug: 'hbl',                logoUrl: 'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://hbl.com&size=128' },
  { type: 'bank', slug: 'mcb',                logoUrl: 'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://mcb.com.pk&size=128' },
  { type: 'bank', slug: 'ubl',                logoUrl: 'https://cdn.worldvectorlogo.com/logos/ubl-united-bank-limited-pakistan.svg' },
  { type: 'bank', slug: 'allied',             logoUrl: 'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://abl.com&size=128' },
  { type: 'bank', slug: 'bank_alfalah',       logoUrl: 'https://icon.horse/icon/bankalfalah.com' },
  { type: 'bank', slug: 'meezan',             logoUrl: 'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://meezanbank.com&size=128' },
  { type: 'bank', slug: 'nbp',                logoUrl: 'https://icon.horse/icon/nbp.com.pk' },
  { type: 'bank', slug: 'standard_chartered', logoUrl: 'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://sc.com&size=128' },
  { type: 'bank', slug: 'askari',             logoUrl: 'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://askaribank.com.pk&size=128' },
  { type: 'bank', slug: 'faysal',             logoUrl: 'https://icon.horse/icon/faysalbank.com' },
  { type: 'bank', slug: 'js_bank',            logoUrl: 'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://jsbl.com&size=128' },
  { type: 'bank', slug: 'bank_of_punjab',     logoUrl: 'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://bop.com.pk&size=128' },
  { type: 'bank', slug: 'silk_bank',          logoUrl: 'https://icon.horse/icon/silkbank.com.pk' },
  { type: 'bank', slug: 'soneri',             logoUrl: 'https://icon.horse/icon/soneribank.com' },
  // summit_bank omitted — domain summitbank.com.pk no longer resolves (bank defunct)

  // ── Wallet Providers ───────────────────────────────────────────────────────
  { type: 'wallet_provider', slug: 'trustwallet', logoUrl: 'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://trustwallet.com&size=128' },
  { type: 'wallet_provider', slug: 'metamask',    logoUrl: 'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://metamask.io&size=128' },
  { type: 'wallet_provider', slug: 'phantom',     logoUrl: 'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://phantom.app&size=128' },
]

async function main() {
  console.log(`Seeding ${LOGOS.length} logos into LogoRegistry…`)

  let inserted = 0
  let skipped = 0

  for (const entry of LOGOS) {
    const existing = await db.logoRegistry.findFirst({
      where: { type: entry.type, slug: entry.slug },
    })

    if (existing) {
      if (existing.logoUrl !== entry.logoUrl) {
        await db.logoRegistry.update({
          where: { id: existing.id },
          data: { logoUrl: entry.logoUrl },
        })
        console.log(`  updated  [${entry.type}] ${entry.slug}`)
        inserted++
      } else {
        skipped++
      }
    } else {
      await db.logoRegistry.create({ data: entry })
      console.log(`  created  [${entry.type}] ${entry.slug}`)
      inserted++
    }
  }

  console.log(`\nDone. ${inserted} upserted, ${skipped} already up-to-date.`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
