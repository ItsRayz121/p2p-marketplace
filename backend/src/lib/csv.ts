/**
 * Safe CSV cell encoding.
 *
 * Exports are opened in Excel/Sheets by admins and giveaway owners, and several columns hold text an
 * anonymous visitor typed (names, WhatsApp numbers, addresses). A cell that starts with = + - @ (or a
 * tab/CR) is executed as a formula by the spreadsheet, so those get a leading apostrophe, which makes
 * the app treat the value as plain text. Quotes, commas and newlines are escaped per RFC 4180.
 */
export function csvCell(v: unknown): string {
  let s =
    v == null ? '' : typeof v === 'string' ? v : v instanceof Date ? v.toISOString() : String(v as number | boolean | bigint)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
