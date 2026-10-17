import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  store: new Map<string, string>(),
  orderFind: vi.fn(),
  userFind: vi.fn(),
  tg: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  retry: vi.fn(),
}))

vi.mock('../../lib/prisma', () => ({ db: { gasFeeOrder: { findUnique: m.orderFind }, user: { findUnique: m.userFind } } }))
vi.mock('../../lib/redis', () => ({
  redis: {
    get: async (k: string) => m.store.get(k) ?? null,
    set: async (k: string, v: string, ...args: unknown[]) => {
      if (args.includes('NX') && m.store.has(k)) return null
      m.store.set(k, v)
      return 'OK'
    },
  },
}))
vi.mock('../../lib/env', () => ({ env: { FRONTEND_URL: 'https://rupchain.test', TELEGRAM_MINI_APP_URL: undefined } }))
vi.mock('../../lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('../../lib/telegram.client', () => ({ telegramRequest: m.tg }))
vi.mock('../gasAdminActions.service', () => ({ approveManualGasPayment: m.approve, rejectManualGasPayment: m.reject, retryGasDelivery: m.retry }))

import { handleGasCallback, buildGasKeyboard, type TgCallbackQuery, type TgKeyboard } from '../telegramGasActions.service'
import { AppError } from '../../lib/errors'

const ADMIN_TG = 1001n
const order = (o: Record<string, unknown> = {}) => ({
  orderRef: 'GF-1', status: 'payment_uploaded', paymentCoin: 'PKR', paymentNetwork: 'BANK', retryCount: 0, paymentTxHash: null,
  failureReason: null, deliveryTxHash: null, expiresAt: new Date(Date.now() + 3600_000), ...o,
})
const cbData = (kb: TgKeyboard, text: RegExp) => kb.flat().find((b) => text.test(b.text))!.callback_data!
const tap = (data: string, o: Partial<TgCallbackQuery> = {}): TgCallbackQuery => ({
  id: 'cb1', from: { id: Number(ADMIN_TG) }, data,
  message: { message_id: 7, chat: { id: Number(ADMIN_TG), type: 'private' }, text: 'Order GF-1 has a payment proof' }, ...o,
})
const called = (method: string) => m.tg.mock.calls.filter(([x]) => x === method).map(([, b]) => b as Record<string, unknown>)

beforeEach(() => {
  m.store.clear()
  for (const f of [m.orderFind, m.userFind, m.tg, m.approve, m.reject, m.retry]) f.mockReset()
  m.orderFind.mockResolvedValue(order())
  m.userFind.mockResolvedValue({ id: 'staff1', role: 'admin', username: 'boss' })
  m.tg.mockResolvedValue({ ok: true, blocked: false })
  m.approve.mockResolvedValue({ status: 'payment_detected', orderRef: 'GF-1' })
  m.reject.mockResolvedValue({ status: 'cancelled', orderRef: 'GF-1' })
  m.retry.mockResolvedValue({})
})

describe('buttons follow the order state', () => {
  it('a submitted PKR proof offers Approve, Reject and Review', async () => {
    const kb = await buildGasKeyboard('o1', ADMIN_TG)
    expect(kb[0]!.map((b) => b.text)).toEqual(['✅ Approve', '❌ Reject', '🔍 Review'])
    expect(kb[0]![2]!.web_app?.url).toContain('path=%2Fadmin%2Fgas%2Forders%2FGF-1')
    expect(kb.flat().every((b) => (b.callback_data ?? '').length <= 64)).toBe(true)
  })
  it('an expired proof, a delivered order and a card order offer only Review', async () => {
    for (const o of [{ expiresAt: new Date(Date.now() - 1000) }, { status: 'delivered', deliveryTxHash: '0xabc' }, { paymentCoin: 'USDT', paymentNetwork: 'BEP20' }]) {
      m.orderFind.mockResolvedValue(order(o))
      const kb = await buildGasKeyboard('o1', ADMIN_TG)
      expect(kb).toHaveLength(1)
      expect(kb[0]).toHaveLength(1)
      expect(kb[0]![0]!.callback_data).toBeUndefined()
    }
  })
  it('a failed order that took a payment offers Retry; one that never had a payment accepted does not', async () => {
    m.orderFind.mockResolvedValue(order({ status: 'failed', retryCount: 1 }))
    expect((await buildGasKeyboard('o1', ADMIN_TG)).flat().map((b) => b.text)).toContain('🔁 Retry')
    m.orderFind.mockResolvedValue(order({ status: 'failed', retryCount: 0 }))
    expect((await buildGasKeyboard('o1', ADMIN_TG)).flat().map((b) => b.text)).not.toContain('🔁 Retry')
  })
  it('an order that is already delivered never offers Retry', async () => {
    m.orderFind.mockResolvedValue(order({ status: 'failed', retryCount: 2, deliveryTxHash: '0xabc' }))
    expect((await buildGasKeyboard('o1', ADMIN_TG)).flat().map((b) => b.text)).not.toContain('🔁 Retry')
  })
  it('an order waiting on the hot wallet offers Retry', async () => {
    m.orderFind.mockResolvedValue(order({ status: 'payment_detected', failureReason: 'insufficient balance' }))
    expect((await buildGasKeyboard('o1', ADMIN_TG)).flat().map((b) => b.text)).toContain('🔁 Retry')
  })
  it('a missing order has no buttons', async () => {
    m.orderFind.mockResolvedValue(null)
    expect(await buildGasKeyboard('o1', ADMIN_TG)).toEqual([])
  })
})

describe('tapping a button', () => {
  it('ignores callbacks that are not ours', async () => {
    expect(await handleGasCallback(tap('other:thing'))).toBe(false)
    expect(m.tg).not.toHaveBeenCalled()
  })

  it('refuses a malformed or invented id', async () => {
    for (const d of ['ga:', 'ga:zzzz', 'ga:' + 'a'.repeat(24)]) {
      expect(await handleGasCallback(tap(d))).toBe(true)
    }
    expect(m.approve).not.toHaveBeenCalled()
    expect(called('answerCallbackQuery').every((b) => b.show_alert === true)).toBe(true)
  })

  it('the first tap only asks for confirmation; nothing runs', async () => {
    const kb = await buildGasKeyboard('o1', ADMIN_TG)
    await handleGasCallback(tap(cbData(kb, /Approve/)))
    expect(m.approve).not.toHaveBeenCalled()
    const edit = called('editMessageReplyMarkup')[0]!
    const rows = (edit.reply_markup as { inline_keyboard: TgKeyboard }).inline_keyboard
    expect(rows[0]![0]!.text).toMatch(/Yes, approve/)
    expect(rows[1]![0]!.text).toBe('Cancel')
  })

  it('the confirming tap approves exactly once, records the admin and the Telegram route, and updates the message', async () => {
    const kb = await buildGasKeyboard('o1', ADMIN_TG)
    await handleGasCallback(tap(cbData(kb, /Approve/)))
    const rows = (called('editMessageReplyMarkup')[0]!.reply_markup as { inline_keyboard: TgKeyboard }).inline_keyboard
    const yes = rows[0]![0]!.callback_data!
    await handleGasCallback(tap(yes))
    expect(m.approve).toHaveBeenCalledTimes(1)
    expect(m.approve).toHaveBeenCalledWith('o1', { id: 'staff1', via: 'telegram' })
    const text = called('editMessageText')[0]!.text as string
    expect(text).toContain('Approved')
    expect(text).toContain('By boss')
    // a repeated or replayed callback does nothing more
    await handleGasCallback(tap(yes))
    expect(m.approve).toHaveBeenCalledTimes(1)
    expect(called('answerCallbackQuery').at(-1)!.text).toBe('Already handled.')
  })

  it('reject runs the shared reject with a fixed reason, and retry runs the shared retry', async () => {
    m.orderFind.mockResolvedValue(order())
    let kb = await buildGasKeyboard('o1', ADMIN_TG)
    await handleGasCallback(tap(cbData(kb, /Reject/)))
    let rows = (called('editMessageReplyMarkup').at(-1)!.reply_markup as { inline_keyboard: TgKeyboard }).inline_keyboard
    await handleGasCallback(tap(rows[0]![0]!.callback_data!))
    expect(m.reject).toHaveBeenCalledWith('o1', 'Payment could not be verified', { id: 'staff1', via: 'telegram' })

    m.orderFind.mockResolvedValue(order({ status: 'failed', retryCount: 1 }))
    kb = await buildGasKeyboard('o1', ADMIN_TG)
    await handleGasCallback(tap(cbData(kb, /Retry/)))
    rows = (called('editMessageReplyMarkup').at(-1)!.reply_markup as { inline_keyboard: TgKeyboard }).inline_keyboard
    await handleGasCallback(tap(rows[0]![0]!.callback_data!))
    expect(m.retry).toHaveBeenCalledTimes(1)
  })

  it('shows a refusal from the shared action as a popup and puts the valid buttons back', async () => {
    m.approve.mockRejectedValue(new AppError('CONFLICT', 'Order was already processed by another admin', 409))
    const kb = await buildGasKeyboard('o1', ADMIN_TG)
    await handleGasCallback(tap(cbData(kb, /Approve/)))
    const rows = (called('editMessageReplyMarkup')[0]!.reply_markup as { inline_keyboard: TgKeyboard }).inline_keyboard
    await handleGasCallback(tap(rows[0]![0]!.callback_data!))
    const last = called('answerCallbackQuery').at(-1)!
    expect(last).toMatchObject({ text: 'Order was already processed by another admin', show_alert: true })
    expect(called('editMessageReplyMarkup').length).toBeGreaterThan(1)
  })

  it('cancel restores the original buttons without running anything', async () => {
    const kb = await buildGasKeyboard('o1', ADMIN_TG)
    await handleGasCallback(tap(cbData(kb, /Approve/)))
    const rows = (called('editMessageReplyMarkup')[0]!.reply_markup as { inline_keyboard: TgKeyboard }).inline_keyboard
    await handleGasCallback(tap(rows[1]![0]!.callback_data!))
    expect(m.approve).not.toHaveBeenCalled()
    const restored = (called('editMessageReplyMarkup').at(-1)!.reply_markup as { inline_keyboard: TgKeyboard }).inline_keyboard
    expect(restored[0]!.map((b) => b.text)).toEqual(['✅ Approve', '❌ Reject'])
  })

  it('refuses a tap from a different Telegram account than the button was made for', async () => {
    const kb = await buildGasKeyboard('o1', ADMIN_TG)
    await handleGasCallback(tap(cbData(kb, /Approve/), { from: { id: 2002 }, message: { message_id: 7, chat: { id: 2002, type: 'private' } } }))
    expect(called('answerCallbackQuery').at(-1)!.text).toBe('This button is not for you.')
    expect(m.approve).not.toHaveBeenCalled()
  })

  it('refuses when the account is not an admin (checked on every tap)', async () => {
    const kb = await buildGasKeyboard('o1', ADMIN_TG)
    m.userFind.mockResolvedValue({ id: 'staff2', role: 'kyc_reviewer', username: 'k' })
    await handleGasCallback(tap(cbData(kb, /Approve/)))
    expect(called('answerCallbackQuery').at(-1)!.text).toBe('You are not allowed to do this.')
    m.userFind.mockResolvedValue(null)
    await handleGasCallback(tap(cbData(kb, /Approve/)))
    expect(called('answerCallbackQuery').at(-1)!.text).toBe('You are not allowed to do this.')
    expect(called('editMessageReplyMarkup')).toHaveLength(0)
    expect(m.approve).not.toHaveBeenCalled()
  })

  it('refuses a button forwarded into a group chat', async () => {
    const kb = await buildGasKeyboard('o1', ADMIN_TG)
    await handleGasCallback(tap(cbData(kb, /Approve/), { message: { message_id: 7, chat: { id: -500, type: 'group' } } }))
    expect(m.approve).not.toHaveBeenCalled()
    expect(called('answerCallbackQuery').at(-1)!.show_alert).toBe(true)
  })

  it('an expired button asks the admin to open the order instead', async () => {
    const kb = await buildGasKeyboard('o1', ADMIN_TG)
    const data = cbData(kb, /Approve/)
    m.store.clear()
    await handleGasCallback(tap(data))
    expect(called('answerCallbackQuery').at(-1)!.text).toMatch(/expired/)
    expect(m.approve).not.toHaveBeenCalled()
  })
})
