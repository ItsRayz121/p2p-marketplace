import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  tg: vi.fn(),
  flag: vi.fn(),
  num: vi.fn(),
  db: {
    telegramSentMessage: { create: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn(), delete: vi.fn() },
    trade: { findMany: vi.fn() },
    ctmTrade: { findMany: vi.fn() },
    gasFeeOrder: { findMany: vi.fn() },
  },
}))
vi.mock('../prisma', () => ({ db: m.db }))
vi.mock('../logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }))
vi.mock('../telegram.client', () => ({ telegramRequest: m.tg }))
vi.mock('../../services/platformFlags.service', () => ({
  FLAGS: { TELEGRAM_AUTO_CLEANUP: 'telegram_auto_cleanup_enabled' },
  isFlagEnabled: m.flag,
  getNumberConfig: m.num,
  TELEGRAM_CLEANUP_DELAY_MINUTES_KEY: 'k',
  TELEGRAM_CLEANUP_DELAY_MINUTES_DEFAULT: 60,
}))

import { recordTelegramMessage, refFromNotificationMetadata, runTelegramMessageCleanup } from '../telegram.messageLog'

const T = m.db.telegramSentMessage
const row = (id: string, kind: string, refKey: string) => ({ id, chatId: 7n, messageId: 100 + Number(id.replace(/\D/g, '') || 0), kind, refKey, sentAt: new Date(0) })

beforeEach(() => {
  vi.clearAllMocks()
  m.flag.mockResolvedValue(true)
  m.num.mockResolvedValue(60)
  m.tg.mockResolvedValue({ ok: true, blocked: false })
  T.deleteMany.mockResolvedValue({ count: 0 })
  T.delete.mockResolvedValue({})
  m.db.trade.findMany.mockResolvedValue([])
  m.db.ctmTrade.findMany.mockResolvedValue([])
  m.db.gasFeeOrder.findMany.mockResolvedValue([])
})

describe('refFromNotificationMetadata', () => {
  it('reads a CTM trade by tradeRef, a USDT trade by tradeId, and ignores everything else', () => {
    expect(refFromNotificationMetadata({ tradeRef: 'CT1' })).toEqual({ kind: 'ctm', refKey: 'CT1' })
    expect(refFromNotificationMetadata({ tradeId: 'T1' })).toEqual({ kind: 'usdt', refKey: 'T1' })
    expect(refFromNotificationMetadata({ tradeRef: 'CT1', tradeId: 'T1' })).toEqual({ kind: 'ctm', refKey: 'CT1' })
    expect(refFromNotificationMetadata({ rewardId: 'x' })).toBeNull()
  })
})

describe('recordTelegramMessage', () => {
  it('stores the message id of a successful send', async () => {
    await recordTelegramMessage(7n, { ok: true, blocked: false, result: { message_id: 42 } }, { kind: 'usdt', refKey: 'T1' })
    expect(T.create).toHaveBeenCalledWith({ data: { chatId: 7n, messageId: 42, kind: 'usdt', refKey: 'T1' } })
  })
  it('stores nothing for a failed send, a missing id, or an untracked message', async () => {
    await recordTelegramMessage(7n, { ok: false, blocked: false }, { kind: 'usdt', refKey: 'T1' })
    await recordTelegramMessage(7n, { ok: true, blocked: false }, { kind: 'usdt', refKey: 'T1' })
    await recordTelegramMessage(7n, { ok: true, blocked: false, result: { message_id: 1 } }, null)
    expect(T.create).not.toHaveBeenCalled()
  })
})

describe('runTelegramMessageCleanup', () => {
  it('does nothing when the kill-switch is off', async () => {
    m.flag.mockResolvedValue(false)
    expect(await runTelegramMessageCleanup()).toBe(0)
    expect(T.findMany).not.toHaveBeenCalled()
    expect(m.tg).not.toHaveBeenCalled()
  })

  it('deletes messages only for trades that are cleanly finished', async () => {
    T.findMany
      .mockResolvedValueOnce([{ kind: 'usdt', refKey: 'T1' }, { kind: 'usdt', refKey: 'T2' }, { kind: 'ctm', refKey: 'C1' }])
      .mockResolvedValueOnce([row('a1', 'usdt', 'T1')])
      .mockResolvedValueOnce([row('b2', 'ctm', 'C1')])
    m.db.trade.findMany.mockResolvedValue([{ id: 'T1' }]) // T2 is still pending / disputed
    m.db.ctmTrade.findMany.mockResolvedValue([{ tradeRef: 'C1' }])

    expect(await runTelegramMessageCleanup(new Date('2026-10-20T00:00:00Z'))).toBe(2)

    expect(m.db.trade.findMany.mock.calls[0]![0].where).toMatchObject({ status: 'crypto_released', dispute: null, disputeResumeStatus: null })
    expect(m.db.ctmTrade.findMany.mock.calls[0]![0].where).toMatchObject({ status: 'completed', dispute: null })
    expect(T.findMany.mock.calls[1]![0].where).toMatchObject({ kind: 'usdt', refKey: { in: ['T1'] } })
    expect(m.tg).toHaveBeenCalledTimes(2)
    expect(m.tg).toHaveBeenCalledWith('deleteMessage', { chat_id: '7', message_id: 101 })
    expect(T.delete).toHaveBeenCalledTimes(2)
  })

  it('never contacts Telegram when no tracked trade is finished', async () => {
    T.findMany.mockResolvedValueOnce([{ kind: 'gas', refKey: 'G1' }])
    expect(await runTelegramMessageCleanup()).toBe(0)
    expect(m.db.gasFeeOrder.findMany.mock.calls[0]![0].where).toMatchObject({ status: 'delivered' })
    expect(m.tg).not.toHaveBeenCalled()
  })

  it('stops on a rate limit and keeps the row for the next tick', async () => {
    T.findMany
      .mockResolvedValueOnce([{ kind: 'gas', refKey: 'G1' }])
      .mockResolvedValueOnce([row('a1', 'gas', 'G1'), row('a2', 'gas', 'G1')])
    m.db.gasFeeOrder.findMany.mockResolvedValue([{ id: 'G1' }])
    m.tg.mockResolvedValue({ ok: false, blocked: false, status: 429, retryAfter: 5 })
    expect(await runTelegramMessageCleanup()).toBe(0)
    expect(m.tg).toHaveBeenCalledTimes(1)
    expect(T.delete).not.toHaveBeenCalled()
  })

  it('drops the row when Telegram says the message is already gone, keeps it on a network error', async () => {
    T.findMany
      .mockResolvedValueOnce([{ kind: 'gas', refKey: 'G1' }])
      .mockResolvedValueOnce([row('a1', 'gas', 'G1'), row('a2', 'gas', 'G1')])
    m.db.gasFeeOrder.findMany.mockResolvedValue([{ id: 'G1' }])
    m.tg.mockResolvedValueOnce({ ok: false, blocked: false, status: 400 }).mockResolvedValueOnce({ ok: false, blocked: false })
    expect(await runTelegramMessageCleanup()).toBe(0)
    expect(T.delete).toHaveBeenCalledTimes(1)
    expect(T.delete).toHaveBeenCalledWith({ where: { id: 'a1' } })
  })

  it('forgets rows older than the 47h Telegram delete window', async () => {
    T.findMany.mockResolvedValueOnce([])
    const now = new Date('2026-10-20T00:00:00Z')
    await runTelegramMessageCleanup(now)
    expect(T.deleteMany).toHaveBeenCalledWith({ where: { sentAt: { lt: new Date(now.getTime() - 47 * 3600_000) } } })
  })
})
