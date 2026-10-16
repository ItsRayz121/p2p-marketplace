const isAlnum = (ch: string) => /[\p{L}\p{N}]/u.test(ch)

/** Up to two initials from a token name (code-point safe, so emoji/CJK are not split). */
export function monogramInitials(name: string): string {
  const words = name
    .normalize('NFC')
    .split(/[\s\-_./]+/)
    .map((w) => Array.from(w).filter(isAlnum))
    .filter((chars) => chars.length > 0)
  if (words.length === 0) return '?'
  const picked = words.length === 1 ? words[0].slice(0, 2) : [words[0][0], words[1][0]]
  return picked.join('').toUpperCase()
}

/** Deterministic hue (FNV-1a) so the same name always gets the same tint. */
export function monogramHue(seed: string): number {
  let h = 0x811c9dc5
  for (const ch of seed) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) % 360
}
