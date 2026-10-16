import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  buildBackup, buildCsv, csvCell, parseBackup, exportFileName, CSV_HEADER, MAX_BACKUP_BYTES, type ExportData, type ExportEvent,
} from '@/lib/portfolio/exportFile'
import { ExportMenu } from '@/components/portfolio/ExportMenu'

const readBlob = (b: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsText(b) })
const BOM = String.fromCharCode(0xfeff)
const TAB = String.fromCharCode(9)
const CR = String.fromCharCode(13)

const ev = (o: Partial<ExportEvent> = {}): ExportEvent => ({
  id: 'e1', assetId: 'a1', type: 'BUY', occurredAt: '2026-01-02T10:00:00.000Z', quantity: '100', consideration: '100000', fee: '1000',
  basis: null, zeroCost: false, quote: 'PKR', fxRate: null, fxSource: null, note: null, source: 'manual', voided: false, voidReason: null, ...o,
})
const data = (o: Partial<ExportData> = {}): ExportData => ({
  exportedAt: '2026-10-16T10:00:00.000Z',
  assets: [{ id: 'a1', name: 'Meta Earth', symbol: 'MEC', sourceUrl: 'https://metaearth.example/', network: 'BEP20', contractAddress: '0xabc', createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null }],
  events: [ev()],
  prices: [{ assetId: 'a1', price: '1200', quote: 'PKR', observedAt: '2026-10-01T00:00:00.000Z' }],
  ...o,
})

describe('csvCell (spreadsheet formula injection)', () => {
  it.each([
    ['=HYPERLINK("http://evil","x")'], ['+SUM(A1:A9)'], ['-2+3'], ['@SUM(1)'], [TAB + 'x'], [CR + 'x'],
  ])('neutralises text starting with a formula character: %j', (v) => {
    expect(csvCell(v).replace(/^"/, '').startsWith("'")).toBe(true)
  })
  it('does not alter ordinary text', () => {
    expect(csvCell('Meta Earth')).toBe('Meta Earth')
    expect(csvCell('a=b')).toBe('a=b')
  })
  it('quotes cells with commas, quotes and line breaks, doubling inner quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
  })
  it('a plain number in a numeric column is left alone, but non-numeric text there is still neutralised', () => {
    expect(csvCell('-5.25', 'number')).toBe('-5.25')
    expect(csvCell('1000', 'number')).toBe('1000')
    expect(csvCell('=1+1', 'number')).toBe("'=1+1")
    expect(csvCell('-5.25')).toBe("'-5.25") // as TEXT, a leading minus is treated as suspicious
  })
  it('null and undefined become empty cells', () => {
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })
})

describe('buildCsv', () => {
  it('starts with a byte-order mark and the header, one row per entry, CRLF line ends', () => {
    const lines = buildCsv(data()).split('\r\n')
    expect(lines[0]).toBe(BOM + CSV_HEADER.join(','))
    expect(lines).toHaveLength(3) // header, one row, trailing empty
    expect(lines[1]).toContain('Meta Earth,MEC,BEP20,0xabc,2026-01-02T10:00:00.000Z,BUY,100,PKR,100000,1000')
  })
  it('a hostile token name or note cannot become a formula', () => {
    const csv = buildCsv(data({
      assets: [{ ...data().assets[0]!, name: '=HYPERLINK("http://evil")', symbol: '@x' }],
      events: [ev({ note: '+cmd|calc' })],
    }))
    const row = csv.split('\r\n')[1]!
    expect(row.startsWith(`"'=HYPERLINK(""http://evil"")",'@x,`)).toBe(true)
    expect(row).toContain("'+cmd|calc")
    expect(row).not.toMatch(/(^|,)[=+@]/)
  })
  it('marks imported and voided entries, and exports unknown cost as an empty cell (never 0)', () => {
    const csv = buildCsv(data({ events: [ev({ type: 'OPENING', consideration: null, fee: null, basis: null, source: 'ctm', voided: true, voidReason: 'disputed' })] }))
    const cells = csv.split('\r\n')[1]!.split(',')
    const col = (name: (typeof CSV_HEADER)[number]) => cells[CSV_HEADER.indexOf(name)]
    expect(col('cost_basis')).toBe('')
    expect(col('source')).toBe('RupChain trade')
    expect(col('counted')).toBe('no')
    expect(col('not_counted_reason')).toBe('disputed')
  })
  it('includes the currency and the rate recorded with each entry', () => {
    const csv = buildCsv(data({ events: [ev({ quote: 'USDT', consideration: '36', fxRate: '278.5', fxSource: 'manual' })] }))
    expect(csv).toContain(',USDT,36,')
    expect(csv).toContain(',278.5,manual,')
  })
  it('an empty portfolio is just the header', () => {
    expect(buildCsv(data({ events: [] })).split('\r\n').filter(Boolean)).toHaveLength(1)
  })
})

describe('backup file', () => {
  it('round-trips exactly', () => {
    const d = data()
    const parsed = parseBackup(buildBackup(d))
    expect(parsed).toEqual({ ok: true, data: d })
  })
  it('a full account backup (with correction history) is version 2 and round-trips', () => {
    const d = data({
      events: [ev({ editedAt: '2026-02-01T00:00:00.000Z', linkedTradeRef: 'trade1' })],
      revisions: [{ eventId: 'e1', assetId: 'a1', action: 'edit', before: { type: 'BUY', quantity: '90', zeroCost: false, note: null }, createdAt: '2026-02-01T00:00:00.000Z' }],
    })
    const file = buildBackup(d)
    expect(JSON.parse(file).version).toBe(2)
    expect(parseBackup(file)).toEqual({ ok: true, data: d })
  })
  it('a correction record for a token that is not in the file is rejected', () => {
    const d = data({ revisions: [{ eventId: 'e1', assetId: 'a1', action: 'edit', before: {}, createdAt: '2026-02-01T00:00:00.000Z' }] })
    const j = JSON.parse(buildBackup(d)) as { revisions: Array<{ assetId: string }> }
    j.revisions[0]!.assetId = 'nope'
    expect(parseBackup(JSON.stringify(j)).ok).toBe(false)
  })
  it('is labelled with a format and version', () => {
    expect(JSON.parse(buildBackup(data()))).toMatchObject({ format: 'rupchain-portfolio-backup', version: 1 })
  })
  const bad = (mutate: (j: Record<string, unknown>) => void) => {
    const j = JSON.parse(buildBackup(data())) as Record<string, unknown>
    mutate(j)
    return parseBackup(JSON.stringify(j))
  }
  it.each([
    ['not JSON', () => parseBackup('{nope')],
    ['wrong format', () => bad((j) => { j.format = 'something-else' })],
    ['extra top-level field', () => bad((j) => { j.admin = true })],
    ['a decimal with an exponent', () => bad((j) => { (j.events as ExportEvent[])[0]!.quantity = '1e3' })],
    ['a negative amount', () => bad((j) => { (j.events as ExportEvent[])[0]!.consideration = '-5' })],
    ['a number instead of a decimal string', () => bad((j) => { ((j.events as unknown[])[0] as Record<string, unknown>).quantity = 5 })],
    ['an unknown entry type', () => bad((j) => { ((j.events as unknown[])[0] as Record<string, unknown>).type = 'TRANSFER' })],
    ['an entry pointing at a missing token', () => bad((j) => { (j.events as ExportEvent[])[0]!.assetId = 'ghost' })],
    ['a price pointing at a missing token', () => bad((j) => { (j.prices as Array<{ assetId: string }>)[0]!.assetId = 'ghost' })],
    ['a bad date', () => bad((j) => { (j.events as ExportEvent[])[0]!.occurredAt = 'yesterday' })],
    ['an extra field on an entry', () => bad((j) => { ((j.events as unknown[])[0] as Record<string, unknown>).userId = 'victim' })],
  ])('rejects %s', (_l, run) => {
    const r = run()
    expect(r.ok).toBe(false)
  })
  it.each([
    ['a javascript: source link', (a: Record<string, unknown>) => { a.sourceUrl = 'javascript:alert(1)' }],
    ['a link with embedded credentials', (a: Record<string, unknown>) => { a.sourceUrl = 'https://user:pw@example.com/' }],
    ['a data: link', (a: Record<string, unknown>) => { a.sourceUrl = 'data:text/html,hi' }],
    ['a name with a hidden direction-override character', (a: Record<string, unknown>) => { a.name = 'Alpha' + String.fromCodePoint(0x202e) + 'evil' }],
    ['an empty name', (a: Record<string, unknown>) => { a.name = '' }],
    ['a contract without a network', (a: Record<string, unknown>) => { a.network = null; a.contractAddress = '0xabc' }],
    ['an invalid symbol', (a: Record<string, unknown>) => { a.symbol = '<script>' }],
  ])('rejects a hand-edited backup with %s, so the local tracker can never store it', (_l, mutate) => {
    expect(bad((j) => { mutate((j.assets as Array<Record<string, unknown>>)[0]!) }).ok).toBe(false)
  })
  it('rejects a note with hidden characters', () => {
    expect(bad((j) => { (j.events as ExportEvent[])[0]!.note = 'ok' + String.fromCodePoint(0x200b) + 'x' }).ok).toBe(false)
  })
  it('still accepts a normal backup with a clean link and note', () => {
    expect(bad((j) => { (j.events as ExportEvent[])[0]!.note = 'bought on dip' }).ok).toBe(true)
  })
  it('rejects duplicate tokens and duplicate entries', () => {
    expect(bad((j) => { const a = (j.assets as unknown[]); a.push(a[0]) }).ok).toBe(false)
    expect(bad((j) => { const e = (j.events as unknown[]); e.push(e[0]) }).ok).toBe(false)
  })
  it('tells a newer version apart from a corrupt file', () => {
    const r = bad((j) => { j.version = 3 })
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/different version/) })
  })
  it('rejects an oversized file before parsing it', () => {
    const r = parseBackup('x'.repeat(MAX_BACKUP_BYTES + 1))
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/too large/) })
  })
  it('caps the number of entries', () => {
    const many = Array.from({ length: 5001 }, (_, i) => ev({ id: `e${i}` }))
    expect(parseBackup(buildBackup(data({ events: many }))).ok).toBe(false)
  })
})

describe('exportFileName', () => {
  it('uses the local date', () => {
    expect(exportFileName('csv', new Date(2026, 0, 5))).toBe('rupchain-portfolio-2026-01-05.csv')
    expect(exportFileName('json', new Date(2026, 11, 25))).toBe('rupchain-portfolio-2026-12-25.json')
  })
})

describe('ExportMenu', () => {
  let created: Blob[]
  let clicked: Array<{ download: string; href: string }>
  beforeEach(() => {
    created = []
    clicked = []
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: (b: Blob) => { created.push(b); return 'blob:test' },
      revokeObjectURL: () => {},
    }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ download: this.download, href: this.href })
    })
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('downloads a CSV file built from the user\'s data', async () => {
    const user = userEvent.setup()
    const load = vi.fn().mockResolvedValue(data())
    render(<ExportMenu load={load} />)
    await user.click(screen.getByRole('button', { name: 'Download CSV' }))
    await vi.waitFor(() => expect(clicked).toHaveLength(1))
    expect(clicked[0]!.download).toMatch(/^rupchain-portfolio-\d{4}-\d{2}-\d{2}\.csv$/)
    expect(created[0]!.type).toBe('text/csv;charset=utf-8')
    expect(await readBlob(created[0]!)).toContain('token,symbol,network')
  })
  it('downloads a JSON backup that can be read back', async () => {
    const user = userEvent.setup()
    render(<ExportMenu load={vi.fn().mockResolvedValue(data())} />)
    await user.click(screen.getByRole('button', { name: 'Download backup (JSON)' }))
    await vi.waitFor(() => expect(clicked).toHaveLength(1))
    expect(clicked[0]!.download).toMatch(/\.json$/)
    expect(parseBackup(await readBlob(created[0]!)).ok).toBe(true)
  })
  it('shows an error and offers retry if loading fails, without downloading anything', async () => {
    const user = userEvent.setup()
    render(<ExportMenu load={vi.fn().mockRejectedValue(new Error('Server busy'))} />)
    await user.click(screen.getByRole('button', { name: 'Download CSV' }))
    expect(await screen.findByText('Server busy')).toBeInTheDocument()
    expect(clicked).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Download CSV' })).toBeEnabled()
  })
  it('makes no network request of its own beyond the provided loader', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const user = userEvent.setup()
    render(<ExportMenu load={vi.fn().mockResolvedValue(data())} />)
    await user.click(screen.getByRole('button', { name: 'Download CSV' }))
    await vi.waitFor(() => expect(clicked).toHaveLength(1))
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
