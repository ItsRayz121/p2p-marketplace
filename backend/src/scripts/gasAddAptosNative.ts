/**
 * One-off, idempotent: add the NATIVE APT gas token under the Aptos chain (2026-06-14).
 *
 * Aptos was wired for inbound USDT/USDC fungible-asset delivery only — the chain's
 * own coin (native APT) was deliberately blocked because there was no native-APT
 * delivery path. That path now exists (gas.delivery.ts → deliverAptosNative, via
 * 0x1::aptos_account::transfer), so this script creates the matching token row so
 * native APT appears in the admin Tokens tab AND on the public /gas token step.
 *
 * Native tokens are "always deliverable" once the chain family supports them, so
 * NO `deliveryLive` flip / hot-wallet Go-Live is required (that gate only applies
 * to non-native tokens). The row is created active + visible so it is immediately
 * orderable, exactly like native TON / TRX / BNB.
 *
 * Run on the target DB (e.g. Railway):  npm run gas:add-aptos-native
 * Idempotent — safe to re-run. Reversible via the admin Token config (Hide/Delete).
 */

import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

// Native APT sizing. APT ≈ $1.5, and the Aptos chain caps order value at $1, so
// presets are small. min/max/fee are left null to INHERIT the chain defaults.
const APT_PRESETS = [0.1, 0.3, 0.5]

async function main() {
  console.log('— Add native APT gas token —\n')

  const aptos = await db.gasChainConfig.findFirst({
    where: { OR: [{ backendChainId: 'APT' }, { slug: { in: ['APT', 'APTOS'] } }] },
    include: { tokens: true },
  })
  if (!aptos) {
    console.error('✗ Aptos chain config not found — create it under Gas Chains first, then re-run.')
    process.exit(1)
  }

  // Find an existing native row (any symbol) so a re-run updates instead of duplicating.
  const existing = aptos.tokens.find((t) => t.tokenType === 'native')
  if (existing) {
    await db.gasTokenConfig.update({
      where: { id: existing.id },
      data: {
        name: 'Aptos', symbol: 'APT', tokenType: 'native', contractAddress: null,
        priceSymbol: 'APT', isActive: true, isVisibleToUsers: true, isArchived: false,
        ...(Array.isArray(existing.presetAmounts) && (existing.presetAmounts as unknown[]).length > 0
          ? {}
          : { presetAmounts: APT_PRESETS }),
        logoUrl: existing.logoUrl ?? aptos.logoUrl,
      },
    })
    console.log(`  ✓ Native APT row updated (id ${existing.id}) — active + visible.`)
  } else {
    const created = await db.gasTokenConfig.create({
      data: {
        chainConfigId: aptos.id,
        name: 'Aptos',
        symbol: 'APT',
        tokenType: 'native',
        contractAddress: null,
        priceSymbol: 'APT',
        logoUrl: aptos.logoUrl,
        presetAmounts: APT_PRESETS,
        platformFeeUsdt: null, // inherit chain default
        minAmount: null,       // inherit chain default
        maxUsdValue: null,     // inherit chain default
        isActive: true,
        isVisibleToUsers: true,
        isArchived: false,
        displayOrder: 0, // show first, above USDT/USDC
      },
    })
    console.log(`  ✓ Native APT row created (id ${created.id}) — active + visible.`)
  }

  console.log('\n✅ Done. Native APT is now orderable on /gas (no Go-Live needed for native tokens).')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
