import 'dotenv/config'
import { assertLocalDatabase } from './localOnly'

assertLocalDatabase()

// Usage: npx tsx scripts/local-stack/seed-test-user.ts <email> <password>
// Creates (or leaves alone) one verified, ordinary user in the LOCAL database.
async function main() {
  const [email, password] = process.argv.slice(2)
  if (!email || !password) { console.error('Usage: seed-test-user.ts <email> <password>'); process.exit(1) }
  const { db } = await import('../../src/lib/prisma')
  const { hashPassword } = await import('../../src/lib/hash')
  const username = email.split('@')[0]!.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 30)
  const user = await db.user.upsert({
    where: { email },
    update: {},
    create: { email, fullName: 'Test User', username, passwordHash: await hashPassword(password), isEmailVerified: true },
  })
  console.log(`User ready: ${user.email} (id ${user.id})`)
  await db.$disconnect()
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
