import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ tg: vi.fn(), env: { FRONTEND_URL: 'https://rupchain.test', TELEGRAM_MINI_APP_URL: undefined as string | undefined } }))
vi.mock('../telegram.client', () => ({ telegramRequest: m.tg }))
vi.mock('../env', () => ({ env: m.env }))

import { sendTelegramAdminAlert } from '../telegram.notify'

const sent = () => m.tg.mock.calls[0]![1] as { chat_id: string; text: string; reply_markup: { inline_keyboard: Array<Array<Record<string, unknown>>> } }

beforeEach(() => {
  m.tg.mockReset()
  m.tg.mockResolvedValue({ ok: true, blocked: false })
  m.env.FRONTEND_URL = 'https://rupchain.test'
  m.env.TELEGRAM_MINI_APP_URL = undefined
})

describe('admin alerts open inside Telegram', () => {
  it('uses a Mini App button (no external-link prompt) that deep-links to the admin page', async () => {
    await sendTelegramAdminAlert(5n, 'PKR Proof Submitted', 'Order GF-1', '/admin/gas/orders/GF-1')
    const b = sent().reply_markup.inline_keyboard[0]![0]!
    expect(b.url).toBeUndefined()
    expect(b.web_app).toEqual({ url: 'https://rupchain.test/mini-app?path=%2Fadmin%2Fgas%2Forders%2FGF-1' })
    expect(sent().text).toBe('🔔 PKR Proof Submitted\n\nOrder GF-1')
  })
  it('honours a configured Mini App URL that already has a query string', async () => {
    m.env.TELEGRAM_MINI_APP_URL = 'https://app.rupchain.test/mini-app?x=1'
    await sendTelegramAdminAlert(5n, 't', 'b', '/admin/kyc')
    expect((sent().reply_markup.inline_keyboard[0]![0]!.web_app as { url: string }).url).toBe('https://app.rupchain.test/mini-app?x=1&path=%2Fadmin%2Fkyc')
  })
  it('never forwards an external or protocol-relative destination', async () => {
    await sendTelegramAdminAlert(5n, 't', 'b', '//evil.example/x')
    expect((sent().reply_markup.inline_keyboard[0]![0]!.web_app as { url: string }).url).toContain('path=%2Fadmin')
    m.tg.mockClear()
    await sendTelegramAdminAlert(5n, 't', 'b', 'https://evil.example')
    expect((sent().reply_markup.inline_keyboard[0]![0]!.web_app as { url: string }).url).toContain('path=%2Fadmin')
  })
  it('falls back to a plain link only where Mini Apps cannot work (local http)', async () => {
    m.env.FRONTEND_URL = 'http://localhost:3000'
    await sendTelegramAdminAlert(5n, 't', 'b', '/admin/kyc')
    expect(sent().reply_markup.inline_keyboard[0]![0]).toMatchObject({ url: 'http://localhost:3000/admin/kyc' })
  })
  it('sends the given action rows instead of the default button', async () => {
    const rows = [[{ text: 'Approve', callback_data: 'ga:abc' }]]
    await sendTelegramAdminAlert(5n, 't', 'b', '/admin', rows)
    expect(sent().reply_markup.inline_keyboard).toEqual(rows)
    expect(sent().chat_id).toBe('5')
  })
})
