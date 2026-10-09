import { describe, it, expect, vi } from 'vitest'

vi.mock('../prisma', () => ({ db: {} }))

import { communityKey } from '../sharedContacts'

describe('communityKey — Telegram', () => {
  it('keeps the case of an invite token', () => {
    expect(communityKey('https://t.me/+AbCdEf123')).toBe('t.me/+AbCdEf123')
    expect(communityKey('https://t.me/+AbCdEf123')).not.toBe(communityKey('https://t.me/+abcdef123'))
  })

  it('gives +TOKEN, %2BTOKEN, joinchat/TOKEN and tg://join the same key', () => {
    const k = 't.me/+AbCdEf123'
    expect(communityKey('https://t.me/joinchat/AbCdEf123')).toBe(k)
    expect(communityKey('https://telegram.me/joinchat/AbCdEf123/')).toBe(k)
    expect(communityKey('https://t.me/JoinChat/AbCdEf123')).toBe(k)
    expect(communityKey('https://t.me/%2BAbCdEf123')).toBe(k)
    expect(communityKey('t.me/+AbCdEf123?x=1#frag')).toBe(k)
    expect(communityKey('tg://join?invite=AbCdEf123')).toBe(k)
  })

  it('treats public usernames case-insensitively across host aliases and views', () => {
    const k = 't.me/rupchaingroup'
    expect(communityKey('https://t.me/RupChainGroup')).toBe(k)
    expect(communityKey('https://telegram.me/rupchaingroup/')).toBe(k)
    expect(communityKey('https://www.t.me/RUPCHAINGROUP')).toBe(k)
    expect(communityKey('https://telegram.dog/RupChainGroup')).toBe(k)
    expect(communityKey('https://t.me/s/RupChainGroup')).toBe(k)
    expect(communityKey('https://t.me/RupChainGroup/1234')).toBe(k)
    expect(communityKey('tg://resolve?domain=RupChainGroup')).toBe(k)
  })

  it('never lets a username collide with an invite token of the same letters', () => {
    expect(communityKey('https://t.me/abcdefgh')).toBe('t.me/abcdefgh')
    expect(communityKey('https://t.me/+abcdefgh')).toBe('t.me/+abcdefgh')
    expect(communityKey('https://t.me/joinchat/abcdefgh')).toBe('t.me/+abcdefgh')
  })

  it('rejects reserved paths and malformed links', () => {
    expect(communityKey('https://t.me/share/url?url=x')).toBeNull()
    expect(communityKey('https://t.me/joinchat/')).toBeNull()
    expect(communityKey('https://t.me/+')).toBeNull()
    expect(communityKey('https://t.me/')).toBeNull()
    expect(communityKey('not a url at all')).toBeNull()
    expect(communityKey('')).toBeNull()
  })

  it('keys private channel links by channel id', () => {
    expect(communityKey('https://t.me/c/1234567890/55')).toBe('t.me/c/1234567890')
  })
})

describe('communityKey — WhatsApp and others', () => {
  it('keeps the case of WhatsApp invite codes and channel ids', () => {
    expect(communityKey('https://chat.whatsapp.com/AbCdEfGhIj123')).toBe('chat.whatsapp.com/AbCdEfGhIj123')
    expect(communityKey('https://chat.whatsapp.com/abcdefghij123')).not.toBe(communityKey('https://chat.whatsapp.com/AbCdEfGhIj123'))
    expect(communityKey('https://www.whatsapp.com/channel/0029VaAbCdEf/')).toBe('whatsapp.com/channel/0029VaAbCdEf')
  })

  it('reduces wa.me links to digits', () => {
    expect(communityKey('https://wa.me/+92 300 1234567')).toBe('wa.me/923001234567')
  })

  it('lower-cases unknown hosts as before', () => {
    expect(communityKey('https://Facebook.com/groups/MyGroup/')).toBe('facebook.com/groups/mygroup')
  })
})
