import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => {
  const cfg = new Map<string, string>()
  const db = {
    platformConfig: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => (cfg.has(where.key) ? { key: where.key, value: cfg.get(where.key)! } : null)),
      upsert: vi.fn(async ({ where, create }: { where: { key: string }; create: { value: string } }) => { cfg.set(where.key, create.value); return {} }),
    },
    gasShareReward: { count: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    gasFeeOrder: { findUnique: vi.fn() },
  }
  return { cfg, db }
})
vi.mock('../../env', () => ({ env: { WALLET_MASTER_KEY: 'b'.repeat(64) } }))
vi.mock('../../prisma', () => ({ db: m.db }))
vi.mock('../../logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }))
vi.mock('../../../services/adminNotification.service', () => ({ createAdminNotif: vi.fn() }))

import { verifyShareReward, saveXSettings, getXSettings } from '../xVerification'

const order = { orderRef: 'GF-1', deliveredAt: new Date('2026-10-17T03:00:00Z'), updatedAt: new Date('2026-10-17T03:00:00Z') }
const reward = { id: 'r1', status: 'submitted', postKey: '555', sourceOrderId: 'o1' }

function tweet(over: Record<string, unknown> = {}) {
  return {
    id: '555', text: 'Used @RupChainHQ #RupChain #ad', createdAt: 'Sat Oct 17 03:20:00 +0000 2026',
    author: { userName: 'someone' }, entities: { urls: [{ expanded_url: 'https://rupchain.com/s/GF-1?v=0' }] }, ...over,
  }
}
const provider = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))

beforeEach(() => {
  m.cfg.clear()
  vi.clearAllMocks()
  m.cfg.set('x_verify_enabled', 'true')
  m.cfg.set('share_reward_x_handle', 'RupChainHQ')
  m.db.gasShareReward.count.mockResolvedValue(0)
  m.db.gasShareReward.findUnique.mockResolvedValue(reward)
  m.db.gasShareReward.updateMany.mockResolvedValue({ count: 1 })
  m.db.gasShareReward.update.mockResolvedValue({})
  m.db.gasFeeOrder.findUnique.mockResolvedValue(order)
  vi.stubEnv('TWITTERAPI_IO_KEY', 'test-key-1234')
})

const lastUpdate = () => m.db.gasShareReward.update.mock.calls.at(-1)![0].data as Record<string, unknown>

describe('verifyShareReward', () => {
  it('does nothing while switched off or without a key', async () => {
    m.cfg.set('x_verify_enabled', 'false')
    expect((await verifyShareReward('r1')).ran).toBe(false)
    m.cfg.set('x_verify_enabled', 'true')
    vi.stubEnv('TWITTERAPI_IO_KEY', '')
    expect((await verifyShareReward('r1')).ran).toBe(false)
    expect(m.db.gasShareReward.updateMany).not.toHaveBeenCalled()
  })

  it('records a passed check without changing the status', async () => {
    provider({ tweets: [tweet()] })
    expect(await verifyShareReward('r1')).toMatchObject({ ran: true, outcome: 'passed' })
    const d = lastUpdate()
    expect(d.verifyStatus).toBe('passed')
    expect(d.status).toBeUndefined()
    expect(d.postAuthor).toBe('someone')
  })

  it('asks for changes when the post is missing required parts', async () => {
    provider({ tweets: [tweet({ text: 'hello' })] })
    expect((await verifyShareReward('r1')).outcome).toBe('failed')
    expect(lastUpdate()).toMatchObject({ status: 'changes_required', verifyStatus: 'failed' })
  })

  it('treats a provider outage as inconclusive and never fails the post', async () => {
    provider({}, 500)
    expect((await verifyShareReward('r1')).outcome).toBe('inconclusive')
    expect(lastUpdate().status).toBeUndefined()
  })

  it('treats a rejected key as inconclusive too', async () => {
    provider({}, 401)
    const r = await verifyShareReward('r1')
    expect(r.outcome).toBe('inconclusive')
    expect(r.reason).toMatch(/rejected the API key/)
  })

  it('asks for a public, correct link when the provider finds no post', async () => {
    provider({ tweets: [] })
    expect((await verifyShareReward('r1')).outcome).toBe('failed')
    expect(lastUpdate().status).toBe('changes_required')
  })

  it('stops at the daily budget before spending a lookup', async () => {
    m.cfg.set('x_verify_daily_budget', '5')
    m.db.gasShareReward.count.mockResolvedValue(5)
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    expect((await verifyShareReward('r1')).ran).toBe(false)
    expect(f).not.toHaveBeenCalled()
  })

  it('does not run a second lookup when another request already claimed the attempt', async () => {
    m.db.gasShareReward.updateMany.mockResolvedValue({ count: 0 })
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    expect((await verifyShareReward('r1')).ran).toBe(false)
    expect(f).not.toHaveBeenCalled()
  })

  it('ignores rewards that are already decided', async () => {
    m.db.gasShareReward.findUnique.mockResolvedValue({ ...reward, status: 'approved' })
    expect((await verifyShareReward('r1')).ran).toBe(false)
  })

  it('only ever calls the provider over https with the key in a header', async () => {
    m.cfg.set('x_provider_base_url', 'http://insecure.example')
    expect((await verifyShareReward('r1')).ran).toBe(false)
  })
})

describe('settings', () => {
  it('stores the key encrypted and only reveals its last four characters', async () => {
    vi.stubEnv('TWITTERAPI_IO_KEY', '')
    await saveXSettings({ apiKey: 'sk-live-secret-9876' })
    expect(m.cfg.get('x_provider_api_key_enc')).not.toContain('secret')
    const view = await getXSettings()
    expect(view.hasKey).toBe(true)
    expect(view.keyHint).toBe('••••9876')
    expect(JSON.stringify(view)).not.toContain('sk-live')
  })
  it('rejects a non-https provider URL and a bad handle', async () => {
    await expect(saveXSettings({ baseUrl: 'http://x.example' })).rejects.toThrow()
    await expect(saveXSettings({ officialHandle: 'not a handle!' })).rejects.toThrow()
  })
})
