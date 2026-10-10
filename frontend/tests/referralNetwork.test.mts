import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildForest, pathTo, bubbleRadius, visibleGraph, newIds, DEFAULT_CHILD_LIMIT, ROOT_GROUP_KEY,
  type NetNode,
} from '../src/lib/referralNetwork.ts'

const n = (id: string, referredById: string | null, referrals = 0, extra: Partial<NetNode> = {}): NetNode =>
  ({ id, username: id, kycStatus: 'none', referrals, referredById, ...extra })

test('builds a forest with roots, ordered children and descendant counts', () => {
  const f = buildForest([n('a', null, 3), n('b', 'a', 1), n('c', 'a', 0), n('d', 'a', 0), n('e', 'b', 0)])
  assert.deepEqual(f.roots, ['a'])
  assert.deepEqual(f.children.get('a'), ['b', 'c', 'd']) // busiest first, then by name
  assert.equal(f.descendants.get('a'), 4)
  assert.equal(f.descendants.get('b'), 1)
  assert.equal(f.descendants.get('e'), 0)
})

test('tolerates self-referrals, unknown referrers, duplicates and cycles', () => {
  const f = buildForest([
    n('self', 'self'), n('orphan', 'ghost'), n('dup', null), n('dup', 'self'),
    n('x', 'y'), n('y', 'x'), // a 2-cycle
  ])
  assert.equal(f.byId.size, 5) // duplicate id dropped
  for (const id of f.byId.keys()) assert.ok(pathTo(f, id).length > 0, `${id} reachable`)
  // every node ends up in exactly one place: root or child
  const placed = f.roots.length + [...f.children.values()].reduce((s, k) => s + k.length, 0)
  assert.equal(placed, f.byId.size)
  assert.ok(f.roots.includes('self') && f.roots.includes('orphan'))
})

test('deep chains do not overflow the stack', () => {
  const nodes: NetNode[] = []
  for (let i = 0; i < 20000; i++) nodes.push(n(`u${i}`, i === 0 ? null : `u${i - 1}`, 1))
  const f = buildForest(nodes)
  assert.equal(f.descendants.get('u0'), 19999)
})

test('pathTo returns root to node, empty for unknown ids', () => {
  const f = buildForest([n('a', null), n('b', 'a'), n('c', 'b')])
  assert.deepEqual(pathTo(f, 'c'), ['a', 'b', 'c'])
  assert.deepEqual(pathTo(f, 'nope'), [])
})

test('bubble radius is bounded and grows with real referral count', () => {
  assert.equal(bubbleRadius(0), 7)
  assert.ok(bubbleRadius(10) > bubbleRadius(1))
  assert.ok(bubbleRadius(200) <= 30.0001)
  assert.ok(bubbleRadius(5000) <= 30.0001)
  assert.ok(bubbleRadius(-4) === 7)
})

test('a 200-referral inviter folds into a group with an exact count', () => {
  const nodes: NetNode[] = [n('boss', null, 200)]
  for (let i = 0; i < 200; i++) nodes.push(n(`k${i}`, 'boss'))
  const f = buildForest(nodes)
  const g = visibleGraph(f, new Map(), 30)
  const users = g.nodes.filter((x) => x.kind === 'user')
  const group = g.nodes.find((x) => x.kind === 'group')!
  assert.equal(users.length, 1 + DEFAULT_CHILD_LIMIT)
  assert.equal(group.hiddenCount, 200 - DEFAULT_CHILD_LIMIT)
  assert.equal(group.hiddenIds!.length, group.hiddenCount)
  assert.equal(users.length - 1 + group.hiddenCount!, 200) // nothing lost
  // expanding the limit shows more people and shrinks the group
  const g2 = visibleGraph(f, new Map([['boss', 50]]), 30)
  assert.equal(g2.nodes.find((x) => x.kind === 'group')!.hiddenCount, 150)
})

test('reveal opens the path so a selected person is never hidden in a group', () => {
  const nodes: NetNode[] = [n('boss', null, 40)]
  for (let i = 0; i < 40; i++) nodes.push(n(`k${String(i).padStart(2, '0')}`, 'boss'))
  const f = buildForest(nodes)
  const target = f.children.get('boss')![35]
  const hidden = visibleGraph(f, new Map(), 30)
  assert.ok(!hidden.nodes.some((x) => x.key === `u:${target}`))
  const shown = visibleGraph(f, new Map(), 30, [target])
  assert.ok(shown.nodes.some((x) => x.key === `u:${target}`))
})

test('many roots fold into one unattached group', () => {
  const nodes: NetNode[] = []
  for (let i = 0; i < 50; i++) nodes.push(n(`r${i}`, null))
  const g = visibleGraph(buildForest(nodes), new Map(), 30)
  const grp = g.nodes.find((x) => x.key === ROOT_GROUP_KEY)!
  assert.equal(grp.hiddenCount, 20)
  assert.equal(grp.parentKey, null)
})

test('newIds finds only genuinely new users and never fires on the first snapshot', () => {
  assert.deepEqual(newIds(null, ['a', 'b']), [])
  assert.deepEqual(newIds(new Set(['a', 'b']), ['a', 'b', 'c']), ['c'])
  assert.deepEqual(newIds(new Set(['a']), ['a']), [])
})
