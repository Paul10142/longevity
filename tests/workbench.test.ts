import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MERGE_REVIEWS_HELD,
  groupWorkbench,
  isActionable,
  pipelineState,
  rankWorkbench,
  type WorkbenchCounts,
  type WorkbenchItem,
} from '../lib/workbench'

// Every queue empty, every count loaded. Tests spread over this.
const allClear: WorkbenchCounts = {
  mergeReviews: 0,
  topicProposals: 0,
  openFlags: 0,
  unreviewedTopics: 0,
  fidelityUnlabeled: 0,
  fidelityRechecks: 0,
  openJobs: 0,
  failedJobs: 0,
  stuckJobs: 0,
  orphanedSources: 0,
}

// Roughly the 2026-10-11 picture: every queue has work, the pipeline is fine.
const busy: WorkbenchCounts = {
  ...allClear,
  mergeReviews: 213,
  topicProposals: 4,
  openFlags: 7,
  unreviewedTopics: 12,
  fidelityRechecks: 9,
  openJobs: 2,
}

const keys = (items: WorkbenchItem[]) => items.map(i => i.key)
const top = (counts: WorkbenchCounts) => groupWorkbench(rankWorkbench(counts)).now

test('the hold on merge reviews is still switched on', () => {
  assert.equal(MERGE_REVIEWS_HELD, true)
})

test('P0: a failed job beats every queue, links to sources, and says to tell Claude', () => {
  const now = top({ ...busy, failedJobs: 1 })
  assert.ok(now)
  assert.equal(now.key, 'pipeline')
  assert.equal(now.priority, 0)
  assert.equal(now.title, 'The pipeline needs attention')
  assert.equal(now.href, '/admin/sources')
  assert.equal(now.count, 1)
  assert.match(now.why, /1 failed job —/)
  assert.match(now.why, /tell Claude "check the pipeline"/)
  assert.match(now.timeEstimate, /min/)
})

test('P0: a stuck job or an orphaned source also wins on its own', () => {
  assert.equal(top({ ...busy, stuckJobs: 2 })?.key, 'pipeline')
  assert.equal(top({ ...busy, orphanedSources: 1 })?.key, 'pipeline')
  const now = top({ ...busy, failedJobs: 2, stuckJobs: 1, orphanedSources: 1 })
  assert.equal(now?.count, 4)
  assert.equal(
    now?.why,
    '2 failed jobs, 1 stuck job and 1 source stuck mid-extraction — you can\'t fix these from here; tell Claude "check the pipeline".'
  )
})

test('P0 count: trouble found by one signal is real even when another is unknown', () => {
  const now = top({ ...busy, failedJobs: 2, stuckJobs: null, orphanedSources: 1 })
  assert.equal(now?.key, 'pipeline')
  assert.equal(now?.count, 3)
})

test('P0 count: a missing signal with nothing else found is unknown, not clear', () => {
  const partial = groupWorkbench(rankWorkbench({ ...allClear, stuckJobs: null }))
  assert.equal(partial.now, null)
  assert.deepEqual(keys(partial.unknown), ['pipeline'])
  assert.ok(!keys(partial.clear).includes('pipeline'))

  const none = groupWorkbench(rankWorkbench({ ...allClear, failedJobs: null, stuckJobs: null, orphanedSources: null }))
  assert.equal(none.unknown.find(i => i.key === 'pipeline')?.count, null)

  const fine = groupWorkbench(rankWorkbench(allClear))
  assert.ok(keys(fine.clear).includes('pipeline'))
})

test('held merge reviews are never the top item, keep their count, and carry the reason', () => {
  const onlyMerges = groupWorkbench(rankWorkbench({ ...allClear, mergeReviews: 213 }))
  assert.equal(onlyMerges.now, null)
  assert.deepEqual(onlyMerges.later, [])
  assert.deepEqual(keys(onlyMerges.held), ['merges'])
  const merges = onlyMerges.held[0]
  assert.equal(merges.count, 213)
  assert.equal(merges.title, 'Decide 213 possible duplicate pairs')
  assert.match(merges.held?.reason ?? '', /caption-transcript redo/)
  assert.ok(!isActionable(merges))

  // With a lower-priority queue live, that queue is the top item — not the held one.
  const withTopics = groupWorkbench(rankWorkbench({ ...allClear, mergeReviews: 213, unreviewedTopics: 3 }))
  assert.equal(withTopics.now?.key, 'topics')
  assert.deepEqual(keys(withTopics.held), ['merges'])
})

test('lifting the hold makes merge reviews an ordinary P5 item', () => {
  const lifted = groupWorkbench(rankWorkbench({ ...allClear, mergeReviews: 213 }, { mergeReviewsHeld: false }))
  assert.equal(lifted.now?.key, 'merges')
  assert.equal(lifted.now?.priority, 5)
  assert.equal(lifted.now?.held, undefined)
  assert.deepEqual(lifted.held, [])
})

test('a held queue with nothing in it is simply clear', () => {
  const sections = groupWorkbench(rankWorkbench(allClear))
  assert.deepEqual(sections.held, [])
  assert.ok(keys(sections.clear).includes('merges'))
})

test('zero goes to Clear and null goes to Unknown — never the same bucket, never the top item', () => {
  const sections = groupWorkbench(rankWorkbench({ ...allClear, openFlags: null }))
  assert.equal(sections.now, null)
  assert.deepEqual(keys(sections.unknown), ['flags'])
  assert.ok(!keys(sections.clear).includes('flags'))
  assert.equal(sections.unknown[0].count, null)
  // An unknown count has no number to put in the title.
  assert.equal(sections.unknown[0].title, 'Keep or dismiss accuracy flags')
  // Everything that did load as zero is clear.
  assert.deepEqual(keys(sections.clear), ['pipeline', 'fidelity', 'proposals', 'topics', 'merges'])

  // Unknown items sort after live ones and before held and clear ones.
  const ranked = rankWorkbench({ ...allClear, openFlags: null, mergeReviews: 5, topicProposals: 2 })
  assert.deepEqual(keys(ranked), ['proposals', 'flags', 'merges', 'pipeline', 'fidelity', 'topics'])
})

test('ordering among P1–P4 follows priority, not count size', () => {
  const sections = groupWorkbench(
    rankWorkbench({ ...allClear, unreviewedTopics: 100, openFlags: 50, topicProposals: 20, fidelityRechecks: 9 })
  )
  assert.equal(sections.now?.key, 'fidelity')
  assert.deepEqual(keys(sections.later), ['proposals', 'flags', 'topics'])
  assert.deepEqual(
    [sections.now, ...sections.later].map(i => i?.priority),
    [1, 2, 3, 4]
  )

  // Drop fidelity and the next priority moves up.
  assert.equal(top({ ...allClear, unreviewedTopics: 100, openFlags: 50, topicProposals: 20 })?.key, 'proposals')
  assert.equal(top({ ...allClear, unreviewedTopics: 100, openFlags: 50 })?.key, 'flags')
  assert.equal(top({ ...allClear, unreviewedTopics: 100 })?.key, 'topics')
})

test('fidelity keeps the worksheet count (unlabelled + re-checks) and names the live number', () => {
  const rechecks = top({ ...allClear, fidelityRechecks: 9 })
  assert.equal(rechecks?.key, 'fidelity')
  assert.equal(rechecks?.count, 9)
  assert.equal(rechecks?.title, 'Re-check 9 facts the AI judge disagreed with')
  assert.equal(rechecks?.href, '/admin/fidelity')
  assert.equal(rechecks?.timeEstimate, 'about 2 min each')
  assert.equal(rechecks?.why, 'Settles whether the accuracy judge can be trusted to quarantine facts on its own')

  const unlabeled = top({ ...allClear, fidelityUnlabeled: 3 })
  assert.equal(unlabeled?.count, 3)
  assert.equal(unlabeled?.title, 'Rule on 3 facts: does each match its transcript?')

  const both = top({ ...allClear, fidelityUnlabeled: 3, fidelityRechecks: 1 })
  assert.equal(both?.count, 4)
  assert.equal(both?.title, 'Rule on 3 facts and re-check 1 the AI judge disagreed with')

  // Either half unknown makes the whole count unknown — the old tile's rule.
  const unknown = groupWorkbench(rankWorkbench({ ...allClear, fidelityUnlabeled: null, fidelityRechecks: 9 }))
  assert.deepEqual(keys(unknown.unknown), ['fidelity'])
})

test('singular counts read naturally', () => {
  assert.equal(top({ ...allClear, topicProposals: 1 })?.title, 'Approve or reject 1 proposed topic')
  assert.equal(top({ ...allClear, openFlags: 1 })?.title, 'Keep or dismiss 1 accuracy flag')
  assert.equal(top({ ...allClear, unreviewedTopics: 1 })?.title, 'Sign off 1 topic the AI created')
  assert.equal(top({ ...allClear, fidelityRechecks: 1 })?.title, 'Re-check 1 fact the AI judge disagreed with')
})

test('every item has one-line copy, a time estimate, and an admin link', () => {
  const items = rankWorkbench(busy)
  assert.equal(items.length, 6)
  for (const item of items) {
    assert.ok(item.title.length > 0 && !item.title.includes('\n'), item.key)
    assert.ok(item.why.length > 0 && !item.why.includes('\n'), item.key)
    assert.match(item.timeEstimate, /min/, item.key)
    assert.ok(item.href.startsWith('/admin/'), item.key)
    // Nothing Paul sees should name a file or a table.
    assert.doesNotMatch(item.title + item.why, /\.(ts|tsx|json)\b|_/, item.key)
  }
})

test('groupWorkbench puts every item in exactly one section', () => {
  const items = rankWorkbench({ ...busy, failedJobs: null, openFlags: null })
  const s = groupWorkbench(items)
  const placed = [...(s.now ? [s.now] : []), ...s.later, ...s.unknown, ...s.held, ...s.clear]
  assert.equal(placed.length, items.length)
  assert.deepEqual(new Set(keys(placed)), new Set(keys(items)))
})

test('pipelineState: trouble, working, idle, unknown', () => {
  assert.equal(pipelineState({ ...busy, failedJobs: 1 }).state, 'needs-attention')
  assert.equal(pipelineState({ ...busy, stuckJobs: 1, openJobs: null }).state, 'needs-attention')
  const working = pipelineState({ ...allClear, openJobs: 3 })
  assert.equal(working.state, 'working')
  assert.match(working.label, /3 jobs/)
  assert.equal(pipelineState({ ...allClear, openJobs: 1 }).label, 'The pipeline is working — 1 job in the queue.')
  assert.equal(pipelineState(allClear).state, 'idle')
  assert.equal(pipelineState({ ...allClear, openJobs: null }).state, 'unknown')
  // A trouble signal that failed to load does not change the queue reading;
  // the pipeline item itself is what shows as unknown on the page.
  assert.equal(pipelineState({ ...allClear, failedJobs: null, openJobs: 0 }).state, 'idle')
})
