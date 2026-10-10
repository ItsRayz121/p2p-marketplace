// Pure data model for the admin referral network. No React, no DOM, no imports, so it
// can be unit tested with `node --test` and shared by the Bubble Map and Referral Branch
// views. Referrals form a forest: every user has at most one referrer.

export interface NetNode {
  id: string
  username: string
  kycStatus: string
  /** Direct referrals, as counted by the database (authoritative). */
  referrals: number
  referredById: string | null
  createdAt?: string | null
  /** Has at least one completed trade. null when the server did not say. */
  active?: boolean | null
}

export interface Forest {
  byId: Map<string, NetNode>
  /** Child ids per parent, ordered: busiest inviters first, then newest. */
  children: Map<string, string[]>
  roots: string[]
  /** Descendants found in the loaded data (not the DB's full count if truncated). */
  descendants: Map<string, number>
}

const cmp = (byId: Map<string, NetNode>) => (a: string, b: string) => {
  const x = byId.get(a)!, y = byId.get(b)!
  if (y.referrals !== x.referrals) return y.referrals - x.referrals
  const tx = x.createdAt ? Date.parse(x.createdAt) : 0
  const ty = y.createdAt ? Date.parse(y.createdAt) : 0
  if (ty !== tx) return ty - tx
  return x.username.localeCompare(y.username)
}

/** Build the forest from node rows. Tolerates malformed data: duplicate ids (first wins),
 *  self-referrals, unknown referrers (treated as roots) and cycles (broken into roots). */
export function buildForest(nodes: NetNode[]): Forest {
  const byId = new Map<string, NetNode>()
  for (const n of nodes) if (n && typeof n.id === 'string' && !byId.has(n.id)) byId.set(n.id, n)

  const parentOf = new Map<string, string | null>()
  for (const n of byId.values()) {
    const p = n.referredById
    parentOf.set(n.id, p && p !== n.id && byId.has(p) ? p : null)
  }

  // Break cycles: walk each chain; if it loops back on itself, cut at the loop entry.
  const state = new Map<string, 0 | 1 | 2>() // 1 = on current walk, 2 = done
  for (const start of byId.keys()) {
    if (state.get(start) === 2) continue
    const walk: string[] = []
    let cur: string | null = start
    while (cur && state.get(cur) !== 2) {
      if (state.get(cur) === 1) { parentOf.set(cur, null); break }
      state.set(cur, 1)
      walk.push(cur)
      cur = parentOf.get(cur) ?? null
    }
    for (const w of walk) state.set(w, 2)
  }

  const children = new Map<string, string[]>()
  const roots: string[] = []
  for (const [id, p] of parentOf) {
    if (p === null) roots.push(id)
    else (children.get(p) ?? children.set(p, []).get(p)!).push(id)
  }
  const order = cmp(byId)
  for (const list of children.values()) list.sort(order)
  roots.sort(order)

  // Descendant counts, iteratively (a deep chain must not overflow the call stack).
  const descendants = new Map<string, number>()
  const stack: Array<{ id: string; i: number }> = []
  for (const r of roots) {
    stack.push({ id: r, i: 0 })
    while (stack.length) {
      const top = stack[stack.length - 1]
      const kids = children.get(top.id) ?? []
      if (top.i < kids.length) { stack.push({ id: kids[top.i++], i: 0 }); continue }
      let total = 0
      for (const k of kids) total += 1 + (descendants.get(k) ?? 0)
      descendants.set(top.id, total)
      stack.pop()
    }
  }
  return { byId, children, roots, descendants }
}

/** Ancestors from the root down to (and including) the node. Empty if unknown. */
export function pathTo(forest: Forest, id: string): string[] {
  if (!forest.byId.has(id)) return []
  const parent = new Map<string, string>()
  for (const [p, kids] of forest.children) for (const k of kids) parent.set(k, p)
  const out: string[] = []
  let cur: string | undefined = id
  while (cur && out.length < 10_000) { out.unshift(cur); cur = parent.get(cur) }
  return out
}

/** Bounded bubble radius from the REAL direct-referral count (7px … 30px). */
export function bubbleRadius(direct: number): number {
  const t = Math.min(1, Math.log1p(Math.max(0, direct)) / Math.log1p(200))
  return 7 + 23 * t
}

export interface VisibleNode {
  key: string
  kind: 'user' | 'group'
  /** user: the user id. group: parent user id the group hangs off (null = unattached trees). */
  id: string
  parentKey: string | null
  /** group only: how many people are folded into it and who they are. */
  hiddenCount?: number
  hiddenIds?: string[]
}

export interface VisibleGraph { nodes: VisibleNode[]; links: Array<{ source: string; target: string }> }

export const DEFAULT_CHILD_LIMIT = 8
export const DEFAULT_ROOT_LIMIT = 30
export const ROOT_GROUP_KEY = 'group:__roots__'

/**
 * The part of the forest to draw. Each parent shows up to `limits[parent]` children
 * (default 8); the rest fold into ONE group bubble that keeps an exact count. Trees are
 * the same for roots. `reveal` ids force their ancestor chain open so a selected person
 * is never hidden inside a group.
 */
export function visibleGraph(
  forest: Forest,
  limits: Map<string, number>,
  rootLimit: number,
  reveal: string[] = [],
): VisibleGraph {
  const need = new Map<string, number>() // parent -> min children that must show
  let rootNeed = 0
  for (const target of reveal) {
    const path = pathTo(forest, target)
    path.forEach((id, i) => {
      if (i === 0) rootNeed = Math.max(rootNeed, forest.roots.indexOf(id) + 1)
      else {
        const parent = path[i - 1]
        need.set(parent, Math.max(need.get(parent) ?? 0, (forest.children.get(parent) ?? []).indexOf(id) + 1))
      }
    })
  }

  const nodes: VisibleNode[] = []
  const links: Array<{ source: string; target: string }> = []

  const emit = (parentKey: string | null, ids: string[], limit: number, groupKey: string, groupOwner: string) => {
    const shown = ids.slice(0, limit)
    const hidden = ids.slice(limit)
    for (const id of shown) {
      const key = `u:${id}`
      nodes.push({ key, kind: 'user', id, parentKey })
      if (parentKey) links.push({ source: parentKey, target: key })
      const kids = forest.children.get(id) ?? []
      if (kids.length) emit(key, kids, Math.max(limits.get(id) ?? DEFAULT_CHILD_LIMIT, need.get(id) ?? 0), `group:${id}`, id)
    }
    if (hidden.length) {
      nodes.push({ key: groupKey, kind: 'group', id: groupOwner, parentKey, hiddenCount: hidden.length, hiddenIds: hidden })
      if (parentKey) links.push({ source: parentKey, target: groupKey })
    }
  }
  emit(null, forest.roots, Math.max(rootLimit, rootNeed), ROOT_GROUP_KEY, '')
  return { nodes, links }
}

/** Ids present in `next` but not in `prev`. Empty when there is no previous snapshot,
 *  so the first load never plays a growth effect for existing users. */
export function newIds(prev: Set<string> | null, next: Iterable<string>): string[] {
  if (!prev) return []
  const out: string[] = []
  for (const id of next) if (!prev.has(id)) out.push(id)
  return out
}
