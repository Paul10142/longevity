/**
 * Cycle-guard tests for lib/topicOps.ts `createsCycle`.
 *
 * Contract (from the doc comment + call sites):
 *   createsCycle(db, childId, ancestorId) answers "would setting
 *   parent(childId) = ancestorId create a cycle?"
 *
 * It does this by walking UP the parent chain starting at `ancestorId`.
 * A cycle is created when that walk reaches `childId` — i.e. `childId` is
 * already an ancestor-or-self of `ancestorId`, so hanging `childId` beneath
 * `ancestorId` would close a loop. It also returns true if it detects a
 * pre-existing loop in the stored data (the `seen` guard), which both signals
 * corruption and prevents an infinite walk.
 *
 * This is the single highest-value guard in the file: its direction was
 * reversed once and silently broke every topic merge. These tests pin the
 * CORRECT direction, verified against reparentTopic/mergeTopics usage.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createsCycle } from '../lib/topicOps'

/**
 * Minimal Supabase-shaped stub supporting exactly the query createsCycle makes:
 *   db.from('topics').select('parent_id').eq('id', <cursor>).single()
 * `parents` maps topic id -> its parent_id (null = root). An id absent from the
 * map resolves to { data: null } (topic not found -> walk stops).
 */
function makeDb(parents: Record<string, string | null>): any {
  return {
    from() {
      return {
        select() {
          return {
            eq(_col: string, val: string) {
              return {
                async single() {
                  return val in parents
                    ? { data: { parent_id: parents[val] } }
                    : { data: null }
                },
              }
            },
          }
        },
      }
    },
  }
}

test('self-parenting is a cycle: createsCycle(A, A) === true', async () => {
  const db = makeDb({ A: null })
  assert.equal(await createsCycle(db, 'A', 'A'), true)
})

test('direct cycle: B is a child of A, so making A a child of B closes a loop', async () => {
  // Tree: A (root) -> B
  const db = makeDb({ A: null, B: 'A' })
  // Attempt to set parent(A) = B. Walk from B: B -> A === childId -> cycle.
  assert.equal(await createsCycle(db, 'A', 'B'), true)
})

test('the safe direction is NOT a cycle: making B a child of A (A is already B\'s parent-side root)', async () => {
  // Tree: A (root) -> B.  Re-affirming parent(B) = A must be allowed.
  const db = makeDb({ A: null, B: 'A' })
  // Walk from A (the proposed ancestor): A -> null. Never hits B. No cycle.
  assert.equal(await createsCycle(db, 'B', 'A'), false)
})

test('deeper cycle: A -> B -> C, making A a child of C closes a 3-node loop', async () => {
  const db = makeDb({ A: null, B: 'A', C: 'B' })
  // Walk from C: C -> B -> A === childId -> cycle.
  assert.equal(await createsCycle(db, 'A', 'C'), true)
})

test('deeper cycle via a grandchild: A -> B -> C, making B a child of C is a cycle', async () => {
  const db = makeDb({ A: null, B: 'A', C: 'B' })
  // Walk from C: C -> B === childId -> cycle.
  assert.equal(await createsCycle(db, 'B', 'C'), true)
})

test('legitimate reparent across subtrees is not a cycle', async () => {
  // Two independent subtrees: A -> B, and D (a separate root).
  const db = makeDb({ A: null, B: 'A', D: null })
  // Move D under B. Walk from B: B -> A -> null. Never hits D. No cycle.
  assert.equal(await createsCycle(db, 'D', 'B'), false)
})

test('legitimate reparent: move a child (B) up under a different root (C)', async () => {
  // A -> B, and unrelated root C.
  const db = makeDb({ A: null, B: 'A', C: null })
  // Set parent(B) = C. Walk from C: C -> null. Never hits B. No cycle.
  assert.equal(await createsCycle(db, 'B', 'C'), false)
})

test('moving a node under its existing sibling is not a cycle', async () => {
  // A -> {B, C} (B and C both children of A).
  const db = makeDb({ A: null, B: 'A', C: 'A' })
  // Set parent(C) = B. Walk from B: B -> A -> null. Never hits C. No cycle.
  assert.equal(await createsCycle(db, 'C', 'B'), false)
})

test('reparenting to null root is never checked as a cycle (defensive: null-target walk stops immediately)', async () => {
  // createsCycle is only called with a non-null ancestor by reparentTopic, but
  // a missing/absent ancestor id must terminate the walk, not loop forever.
  const db = makeDb({ A: null })
  assert.equal(await createsCycle(db, 'A', 'GHOST'), false)
})

test('pre-existing loop in stored data is detected via the seen-guard (and does not hang)', async () => {
  // Corrupt data: A <-> B point at each other. Walking from A must terminate.
  const db = makeDb({ A: 'B', B: 'A' })
  // childId 'Z' is not in the loop; the walk should still return (true) rather
  // than spin forever, because the seen-set trips on revisiting A.
  assert.equal(await createsCycle(db, 'Z', 'A'), true)
})
