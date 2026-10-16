import 'dotenv/config'
import { execSync } from 'node:child_process'
import { assertLocalDatabase } from './localOnly'

assertLocalDatabase()

// Creates every table straight from prisma/schema.prisma in the LOCAL database. Use this instead of
// `prisma migrate deploy` on an empty database: the migration chain cannot be replayed from scratch
// (see src/lib/__tests__/migrationsChain.unit.test.ts). Pass --reset to wipe the local database first.
const reset = process.argv.includes('--reset') ? ' --force-reset' : ''
execSync(`npx prisma db push --skip-generate${reset}`, { stdio: 'inherit' })
