import test from 'node:test'
import assert from 'node:assert/strict'
import { withdrawalIdempotencyKey } from '../src/lib/withdrawalKey.ts'

const SESSION = '3f2b6c1e-9d4a-4c1b-8a55-0e1f2a3b4c5d'
const base = ['USDT', 'TRC20', '25.5', 'T' + 'a'.repeat(33)]

test('the same payload re-sent after a failure carries the same key', () => {
  assert.equal(withdrawalIdempotencyKey(SESSION, base), withdrawalIdempotencyKey(SESSION, [...base]))
})

test('editing any field produces a different key', () => {
  const k = withdrawalIdempotencyKey(SESSION, base)
  assert.notEqual(k, withdrawalIdempotencyKey(SESSION, ['USDT', 'TRC20', '25.6', base[3]]))
  assert.notEqual(k, withdrawalIdempotencyKey(SESSION, ['USDT', 'BEP20', '25.5', base[3]]))
  assert.notEqual(k, withdrawalIdempotencyKey(SESSION, ['USDT', 'TRC20', '25.5', 'T' + 'b'.repeat(33)]))
})

test('a new modal session gets a different key for the same payload', () => {
  assert.notEqual(withdrawalIdempotencyKey(SESSION, base), withdrawalIdempotencyKey('another-session', base))
})

test('surrounding whitespace in a field does not change the key', () => {
  assert.equal(withdrawalIdempotencyKey(SESSION, base), withdrawalIdempotencyKey(SESSION, ['USDT', 'TRC20', ' 25.5 ', base[3]]))
})

test('fields cannot be shifted across boundaries to collide', () => {
  assert.notEqual(withdrawalIdempotencyKey(SESSION, ['ab', 'c']), withdrawalIdempotencyKey(SESSION, ['a', 'bc']))
})

test('the key satisfies the server rules (1-128 chars of letters, digits, . _ : -)', () => {
  const k = withdrawalIdempotencyKey(SESSION, base)
  assert.match(k, /^[A-Za-z0-9._:-]{1,128}$/)
})
