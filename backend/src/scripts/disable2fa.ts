/**
 * Emergency 2FA reset script
 *
 * Usage:
 *   npx ts-node src/scripts/disable2fa.ts <email>
 *
 * Example:
 *   npx ts-node src/scripts/disable2fa.ts fazalelahi057@gmail.com
 *
 * This disables 2FA for the specified user and clears their TOTP secret.
 * Run only from the Railway shell or locally against the production DB.
 */

import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

async function main() {
  const email = process.argv[2]
  if (!email) {
    console.error('Usage: npx ts-node src/scripts/disable2fa.ts <email>')
    process.exit(1)
  }

  const db = new PrismaClient()

  try {
    const user = await db.user.findUnique({
      where: { email },
      select: { id: true, email: true, role: true, twoFaEnabled: true },
    })

    if (!user) {
      console.error(`No user found with email: ${email}`)
      process.exit(1)
    }

    console.log(`Found user: ${user.email} (role: ${user.role}, 2FA enabled: ${user.twoFaEnabled})`)

    if (!user.twoFaEnabled) {
      console.log('2FA is already disabled for this user.')
      process.exit(0)
    }

    await db.user.update({
      where: { id: user.id },
      data: { twoFaEnabled: false, twoFaSecret: null },
    })

    console.log(`✓ 2FA disabled for ${user.email}. You can now log in with email + password only.`)
  } finally {
    await db.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
