import { describe, it, expect, beforeAll } from 'vitest'
import { createHmac } from 'node:crypto'

// The bot token used to sign our fixtures. env.TELEGRAM_BOT_TOKEN must equal
// this for validation to pass — set it before importing the module under test.
const TEST_BOT_TOKEN = '123456:TEST_BOT_TOKEN_FOR_UNIT_TESTS_ONLY'

// Build a correctly-signed initData string for the given fields, exactly as
// Telegram would. Lets us assert validateInitData accepts genuine payloads and
// rejects tampered/stale ones.
function buildInitData(fields: Record<string, string>): string {
  const pairs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
  const dataCheckString = pairs.join('\n')
  const secretKey = createHmac('sha256', 'WebAppData').update(TEST_BOT_TOKEN).digest()
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
  const params = new URLSearchParams(fields)
  params.set('hash', hash)
  return params.toString()
}

let validateInitData: typeof import('../telegram')['validateInitData']
let parseReferralStartParam: typeof import('../telegram')['parseReferralStartParam']

beforeAll(async () => {
  process.env.TELEGRAM_BOT_TOKEN = TEST_BOT_TOKEN
  const mod = await import('../telegram')
  validateInitData = mod.validateInitData
  parseReferralStartParam = mod.parseReferralStartParam
})

describe('validateInitData', () => {
  const now = () => Math.floor(Date.now() / 1000)
  const user = JSON.stringify({ id: 777000, first_name: 'Ada', username: 'ada_lovelace', photo_url: 'https://t.me/i/ada.jpg' })

  it('accepts a genuine, fresh payload and extracts the user', () => {
    const initData = buildInitData({ auth_date: String(now()), user, start_param: 'ref_ABC123', query_id: 'q1' })
    const result = validateInitData(initData)
    expect(result).not.toBeNull()
    expect(result!.user.id).toBe(777000)
    expect(result!.user.username).toBe('ada_lovelace')
    expect(result!.startParam).toBe('ref_ABC123')
  })

  it('accepts a payload carrying a signature field (Bot API 7.10+ clients)', () => {
    // Modern Telegram clients attach `signature`, which Telegram INCLUDES when
    // computing `hash`. buildInitData signs over every field, so a valid hash
    // here only verifies if validateInitData also keeps `signature` in its
    // data-check-string. This guards the regression that 401'd every login.
    const initData = buildInitData({
      auth_date: String(now()),
      user,
      query_id: 'q1',
      signature: 'abc_def-123XYZ',
    })
    const result = validateInitData(initData)
    expect(result).not.toBeNull()
    expect(result!.user.id).toBe(777000)
  })

  it('rejects a tampered payload (user id changed after signing)', () => {
    const initData = buildInitData({ auth_date: String(now()), user })
    const tampered = initData.replace('777000', '888000')
    expect(validateInitData(tampered)).toBeNull()
  })

  it('rejects a payload with no hash', () => {
    const params = new URLSearchParams({ auth_date: String(now()), user })
    expect(validateInitData(params.toString())).toBeNull()
  })

  it('rejects a stale payload (auth_date older than 24h)', () => {
    const initData = buildInitData({ auth_date: String(now() - 25 * 60 * 60), user })
    expect(validateInitData(initData)).toBeNull()
  })

  it('rejects malformed user JSON', () => {
    const initData = buildInitData({ auth_date: String(now()), user: 'not-json' })
    expect(validateInitData(initData)).toBeNull()
  })

  it('rejects an empty / non-string input', () => {
    expect(validateInitData('')).toBeNull()
    // @ts-expect-error — intentionally wrong type to assert defensive handling
    expect(validateInitData(undefined)).toBeNull()
  })
})

describe('parseReferralStartParam', () => {
  it('extracts the bare code from ref_<code>', () => {
    expect(parseReferralStartParam('ref_ABC123')).toBe('ABC123')
  })
  it('returns null for non-referral or absent payloads', () => {
    expect(parseReferralStartParam(undefined)).toBeNull()
    expect(parseReferralStartParam('promo_xyz')).toBeNull()
    expect(parseReferralStartParam('ref_')).toBeNull()
  })
})
