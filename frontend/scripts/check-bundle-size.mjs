// Bundle-size guard. Run after `next build`:  npm run check:bundle
//
// For each route in BUDGETS it sums the gzipped size of every JS chunk the App
// Router loads for that page and compares it to a budget in KB. It also fails if
// the heavy wallet stack (wagmi / WalletConnect / AppKit) shows up in a route's
// chunks that has no business loading it — that regression (a wallet provider
// imported into a shared layout) is what made every page download it before.
//
// Exit code is non-zero on a violation only when BUNDLE_ENFORCE=1, so CI can turn
// it on once the budgets below have settled. Otherwise it just prints the table.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const NEXT_DIR = path.resolve(process.cwd(), '.next')
const MANIFEST = path.join(NEXT_DIR, 'app-build-manifest.json')

// Route key (as in app-build-manifest.json) -> gzipped JS budget in KB.
// Measured 2026-09-30: / 147, dashboard 138, wallet 167, gas 169, markets 130.
// Budgets sit ~15% above that. Raise one deliberately (and say why in the commit)
// rather than letting it creep.
const BUDGETS = {
  '/page': 170,
  '/(platform)/dashboard/page': 160,
  '/(platform)/wallet/page': 190,
  '/gas/page': 195,
  '/markets/page': 150,
}

// Substrings that only appear in the wallet stack's chunks.
const WALLET_SIGNATURES = ['WagmiProvider', '@reown/appkit', 'walletconnect']
// Routes allowed to contain them.
const WALLET_ALLOWED = new Set([])

if (!fs.existsSync(MANIFEST)) {
  console.error(`No ${path.relative(process.cwd(), MANIFEST)} — run "next build" first.`)
  process.exit(2)
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
const pages = manifest.pages ?? {}
const gzCache = new Map()

function gzipKb(file) {
  if (gzCache.has(file)) return gzCache.get(file)
  const buf = fs.readFileSync(path.join(NEXT_DIR, file))
  const kb = zlib.gzipSync(buf).length / 1024
  gzCache.set(file, { kb, text: file.endsWith('.js') ? buf.toString('utf8') : '' })
  return gzCache.get(file)
}

let failed = false
const rows = []

for (const [route, budget] of Object.entries(BUDGETS)) {
  const files = (pages[route] ?? []).filter((f) => f.endsWith('.js'))
  if (files.length === 0) {
    rows.push([route, 'not found', String(budget), 'skip'])
    continue
  }
  const unique = [...new Set(files)]
  let total = 0
  let walletHit = null
  for (const f of unique) {
    const { kb, text } = gzipKb(f)
    total += kb
    if (!WALLET_ALLOWED.has(route) && !walletHit) {
      const sig = WALLET_SIGNATURES.find((s) => text.includes(s))
      if (sig) walletHit = `${sig} in ${f}`
    }
  }
  const over = total > budget
  if (over || walletHit) failed = true
  rows.push([route, `${total.toFixed(0)} KB`, `${budget} KB`, over ? 'OVER BUDGET' : walletHit ? `WALLET LEAK: ${walletHit}` : 'ok'])
}

const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i].length), ['Route', 'Size (gzip)', 'Budget', 'Status'][i].length))
const line = (r) => r.map((c, i) => c.padEnd(widths[i])).join('  ')
console.log(line(['Route', 'Size (gzip)', 'Budget', 'Status']))
for (const r of rows) console.log(line(r))

if (failed) {
  console.error('\nBundle guard: one or more routes are over budget or load the wallet stack.')
  if (process.env.BUNDLE_ENFORCE === '1') process.exit(1)
  console.error('(BUNDLE_ENFORCE is not set, so this is a warning only.)')
}
