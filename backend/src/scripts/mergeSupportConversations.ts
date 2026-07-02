/**
 * One-shot backfill: collapse every user's multiple support conversations into a
 * single "box". See mergeDuplicateSupportConversations() for details.
 *
 * NOTE: this connects to whatever DATABASE_URL is in the environment. From a
 * local machine `railway run` injects the INTERNAL host (postgres.railway.internal)
 * which only resolves inside Railway — so prefer the super-admin "Merge duplicate
 * conversations" button in the admin panel, which runs this same logic in-cluster.
 *
 * Usage (inside Railway / with a reachable DATABASE_URL):
 *   npx tsx src/scripts/mergeSupportConversations.ts
 */

import 'dotenv/config'
import '../lib/env'
import { mergeDuplicateSupportConversations } from '../services/supportMaintenance.service'

async function main() {
  const { usersMerged, rowsDeleted } = await mergeDuplicateSupportConversations((msg) => console.log(`  ${msg}`))
  console.log(`Merge complete — ${usersMerged} user(s) consolidated, ${rowsDeleted} duplicate conversation row(s) removed.`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
