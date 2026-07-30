/**
 * Pure-function tests for lib/synthesis.ts:
 *   - stripInlineClaimIds — removes UUID claim-id tokens the model may echo into
 *     prose, while leaving [R#] reference markers untouched.
 *   - outlineToMarkdown   — renders a sectioned outline to markdown and appends
 *     a deterministic References section.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripInlineClaimIds, outlineToMarkdown } from '../lib/synthesis'

// ── stripInlineClaimIds ──────────────────────────────────────
test('stripInlineClaimIds removes a trailing bracketed UUID and the space before it', () => {
  const input = 'Male-factor infertility is common [d5d0e719-3b37-4855-b72e-e213a3394ac7].'
  assert.equal(stripInlineClaimIds(input), 'Male-factor infertility is common.')
})

test('stripInlineClaimIds preserves [R#] reference markers', () => {
  const input = 'Exercise lowers HbA1c [R1] and improves VO2max [R12].'
  assert.equal(stripInlineClaimIds(input), 'Exercise lowers HbA1c [R1] and improves VO2max [R12].')
})

test('stripInlineClaimIds strips a UUID but keeps an adjacent reference marker', () => {
  const input = 'Metformin reduces mortality [c1a2b3d4-5e6f-7a8b-9c0d-1e2f3a4b5c6d] in T2D [R3].'
  assert.equal(stripInlineClaimIds(input), 'Metformin reduces mortality in T2D [R3].')
})

test('stripInlineClaimIds removes multiple UUIDs anywhere in the sentence', () => {
  const input =
    'Sleep [11111111-2222-3333-4444-555555555555] and stress [66666666-7777-8888-9999-aaaaaaaaaaaa] interact.'
  assert.equal(stripInlineClaimIds(input), 'Sleep and stress interact.')
})

test('stripInlineClaimIds collapses runs of internal whitespace and trims the ends', () => {
  const input = '  Fiber   intake   matters  '
  assert.equal(stripInlineClaimIds(input), 'Fiber intake matters')
})

test('stripInlineClaimIds is case-insensitive on hex digits in the UUID', () => {
  const input = 'Statins help [ABCDEF12-3456-7890-ABCD-EF1234567890].'
  assert.equal(stripInlineClaimIds(input), 'Statins help.')
})

test('stripInlineClaimIds leaves prose with no tokens unchanged', () => {
  const input = 'A plain clinical sentence with no markers.'
  assert.equal(stripInlineClaimIds(input), 'A plain clinical sentence with no markers.')
})

// ── outlineToMarkdown ────────────────────────────────────────
test('outlineToMarkdown renders each section as an H2 followed by its stripped paragraphs', () => {
  const outline = {
    title: 'Sleep',
    sections: [
      {
        id: 'overview',
        title: 'Overview',
        paragraphs: [
          { id: 'p1', text: 'Sleep is restorative [11111111-2222-3333-4444-555555555555].', claim_ids: ['x'] },
          { id: 'p2', text: 'It has stages.', claim_ids: [] },
        ],
      },
      {
        id: 'mechanisms',
        title: 'Mechanisms',
        paragraphs: [{ id: 'p3', text: 'Adenosine accumulates [R1].', claim_ids: ['y'] }],
      },
    ],
  }
  const md = outlineToMarkdown(outline)
  assert.equal(
    md,
    [
      '## Overview',
      'Sleep is restorative.',
      'It has stages.',
      '## Mechanisms',
      'Adenosine accumulates [R1].',
    ].join('\n\n'),
  )
})

test('outlineToMarkdown appends a deterministic References section with numeric labels', () => {
  const outline = {
    title: 'Exercise',
    sections: [{ id: 's1', title: 'Benefits', paragraphs: [{ id: 'p1', text: 'Lowers BP [R1].', claim_ids: ['c'] }] }],
    references: [
      { marker: 'R1', citation: 'Smith et al. (2020). Exercise and BP. JAMA.', url: null },
      { marker: 'R2', citation: 'Doe J. (2019). Cardio review. Lancet.', url: 'https://example.org' },
    ],
  }
  const md = outlineToMarkdown(outline)
  assert.equal(
    md,
    [
      '## Benefits',
      'Lowers BP [R1].',
      '## References',
      '1. Smith et al. (2020). Exercise and BP. JAMA.',
      '2. Doe J. (2019). Cardio review. Lancet.',
    ].join('\n\n'),
  )
})

test('outlineToMarkdown omits the References heading when there are no references', () => {
  const outline = {
    title: 'T',
    sections: [{ id: 's1', title: 'Only Section', paragraphs: [{ id: 'p1', text: 'Body.', claim_ids: [] }] }],
    references: [],
  }
  assert.equal(outlineToMarkdown(outline), '## Only Section\n\nBody.')
})

test('outlineToMarkdown tolerates a section with no paragraphs (heading only)', () => {
  const outline = {
    title: 'T',
    sections: [{ id: 's1', title: 'Empty', paragraphs: [] }],
  }
  assert.equal(outlineToMarkdown(outline), '## Empty')
})
