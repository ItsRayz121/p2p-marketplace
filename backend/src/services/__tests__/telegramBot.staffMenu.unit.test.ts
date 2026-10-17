import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  tg: vi.fn(),
  findUnique: vi.fn(),
  env: { TELEGRAM_BOT_TOKEN: 'x', FRONTEND_URL: 'https://rupchain.test', TELEGRAM_MINI_APP_URL: undefined as string | undefined },
}))
vi.mock('../../lib/telegram.client', () => ({ telegramRequest: m.tg }))
vi.mock('../../lib/env', () => ({ env: m.env }))
vi.mock('../../lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('../../lib/prisma', () => ({
  db: { user: { findUnique: m.findUnique, updateMany: () => Promise.resolve({ count: 0 }) }, telegramPendingReferral: { upsert: vi.fn() } },
}))
vi.mock('../../lib/telegram', () => ({ parseReferralStartParam: () => null }))
vi.mock('../accountLink.service', () => ({ linkTelegramViaToken: vi.fn() }))
vi.mock('../telegramGasActions.service', () => ({ handleGasCallback: vi.fn() }))

import { handleTelegramUpdate } from '../telegram-bot.service'

const start = () => handleTelegramUpdate({ update_id: 1, message: { message_id: 1, from: { id: 7, first_name: 'Fazal' }, chat: { id: 7, type: 'private' }, text: '/start' } })
const buttons = () => (m.tg.mock.calls[0]![1] as { reply_markup: { inline_keyboard: Array<Array<{ text: string; web_app?: { url: string } }>> } }).reply_markup.inline_keyboard

beforeEach(() => {
  m.tg.mockReset()
  m.tg.mockResolvedValue({ ok: true, blocked: false })
  m.findUnique.mockReset()
})

describe('bot welcome menu', () => {
  it('puts the admin panel first for staff, with a deliberate user view', async () => {
    m.findUnique.mockResolvedValue({ role: 'super_admin' })
    await start()
    const top = buttons()[0]!
    expect(top[0]!.text).toContain('Admin panel')
    expect(decodeURIComponent(top[0]!.web_app!.url)).toContain('path=/admin')
    expect(top[1]!.web_app!.url).toContain('view=user')
  })
  it('keeps the normal menu for regular users and unknown accounts', async () => {
    m.findUnique.mockResolvedValue({ role: 'user' })
    await start()
    expect(buttons()[0]![0]!.text).toContain('Open RupChain')
    m.tg.mockClear()
    m.findUnique.mockResolvedValue(null)
    await start()
    expect(buttons()[0]![0]!.text).toContain('Open RupChain')
  })
  it('falls back to the normal menu if the role lookup fails', async () => {
    m.findUnique.mockRejectedValue(new Error('db down'))
    await start()
    expect(buttons()[0]![0]!.text).toContain('Open RupChain')
  })
})
