export const NAME_MAX = 80
export const SYMBOL_MAX = 16
export const URL_MAX = 2048
export const NETWORK_MAX = 40
export const CONTRACT_MAX = 128

export interface CustomAssetInput {
  name: string
  symbol?: string
  sourceUrl?: string
  network?: string
  contractAddress?: string
}

export interface CustomAssetValue {
  name: string
  symbol: string | null
  sourceUrl: string | null
  network: string | null
  contractAddress: string | null
}

export type CustomAssetField = keyof CustomAssetInput
export type CustomAssetResult =
  | { ok: true; value: CustomAssetValue }
  | { ok: false; errors: Partial<Record<CustomAssetField, string>> }

// Invisible code points (as numbers, so this file contains no invisible characters itself):
// C0/C1 controls, soft hyphen, Arabic letter mark, zero-width and directional marks, line/paragraph
// separators, bidi embeddings/overrides/isolates, word joiner and invisible operators, BOM.
// They can make two different names look identical or reorder the text around them.
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], [0x007f, 0x009f], [0x00ad, 0x00ad], [0x061c, 0x061c], [0x180e, 0x180e],
  [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff],
]

function isInvisible(cp: number): boolean {
  return INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)
}

function hasInvisible(s: string): boolean {
  for (const ch of s) if (isInvisible(ch.codePointAt(0)!)) return true
  return false
}

/** Normalise user text for storage/display: NFC, no invisible characters, collapsed whitespace. */
export function cleanText(raw: string): string {
  let out = ''
  for (const ch of raw.normalize('NFC')) out += isInvisible(ch.codePointAt(0)!) ? ' ' : ch
  return out.replace(/\s+/g, ' ').trim()
}

const SYMBOL_RE = /^[\p{L}\p{N}._$-]+$/u
const NETWORK_RE = /^[A-Za-z0-9 ._()/+-]+$/
const CONTRACT_RE = /^[A-Za-z0-9:._-]+$/

/**
 * Source links are display-only and never fetched. Only http/https without embedded credentials
 * is accepted; anything else (javascript:, data:, vbscript:, file:, ftp:, scheme-less text) is
 * rejected rather than guessed at.
 */
export function parseSourceUrl(raw: string): { ok: true; href: string } | { ok: false; error: string } {
  const s = raw.trim()
  if (s.length > URL_MAX) return { ok: false, error: `Link is too long (max ${URL_MAX} characters).` }
  // new URL() silently strips tabs/newlines, which would let "java<newline>script:" style input
  // through unnoticed, so any whitespace or invisible character inside the link is an error.
  if (/\s/.test(s) || hasInvisible(s)) {
    return { ok: false, error: 'Link cannot contain spaces or hidden characters.' }
  }
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return { ok: false, error: 'Enter a full link starting with http:// or https://.' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: 'Only http:// or https:// links are allowed.' }
  }
  if (u.username || u.password) {
    return { ok: false, error: 'Link cannot contain a username or password.' }
  }
  if (!u.hostname) return { ok: false, error: 'Enter a full link starting with http:// or https://.' }
  // The stored form can be longer than what was typed (non-ASCII characters are percent-encoded), and
  // it is the stored form that must fit.
  if (u.href.length > URL_MAX) return { ok: false, error: `Link is too long (max ${URL_MAX} characters).` }
  return { ok: true, href: u.href }
}

export function validateCustomAsset(input: CustomAssetInput): CustomAssetResult {
  const errors: Partial<Record<CustomAssetField, string>> = {}

  const name = cleanText(input.name ?? '')
  if (!name) errors.name = 'Enter the token name.'
  else if (Array.from(name).length > NAME_MAX) errors.name = `Name is too long (max ${NAME_MAX} characters).`

  const symbol = cleanText(input.symbol ?? '')
  if (symbol) {
    if (Array.from(symbol).length > SYMBOL_MAX) errors.symbol = `Symbol is too long (max ${SYMBOL_MAX} characters).`
    else if (!SYMBOL_RE.test(symbol)) errors.symbol = 'Use letters, numbers, . _ - or $ only.'
  }

  let sourceUrl: string | null = null
  if ((input.sourceUrl ?? '').trim()) {
    const r = parseSourceUrl(input.sourceUrl ?? '')
    if (r.ok) sourceUrl = r.href
    else errors.sourceUrl = r.error
  }

  const network = cleanText(input.network ?? '')
  if (network) {
    if (network.length > NETWORK_MAX) errors.network = `Network is too long (max ${NETWORK_MAX} characters).`
    else if (!NETWORK_RE.test(network)) errors.network = 'Use letters, numbers and simple punctuation only.'
  }

  const contract = (input.contractAddress ?? '').trim()
  if (contract) {
    if (contract.length > CONTRACT_MAX) errors.contractAddress = `Contract is too long (max ${CONTRACT_MAX} characters).`
    else if (!CONTRACT_RE.test(contract)) errors.contractAddress = 'Use letters, numbers and : . _ - only.'
    else if (!network && !errors.network) errors.network = 'Enter the network this contract is on.'
  }

  if (Object.keys(errors).length) return { ok: false, errors }
  return {
    ok: true,
    value: {
      name,
      symbol: symbol || null,
      sourceUrl,
      network: network || null,
      contractAddress: contract || null,
    },
  }
}

/** Host shown next to a source link. Text only; the link is opened by the user, never fetched. */
export function sourceHostname(href: string): string {
  try {
    return new URL(href).hostname
  } catch {
    return ''
  }
}
