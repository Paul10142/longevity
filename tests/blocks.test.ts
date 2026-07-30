/**
 * Unit tests for the sentence-block article model (`lib/blocks.ts`) and its
 * deterministic markdown renderer (`lib/blockRenderer.ts`) — synthesis-v4 spec
 * §5.2 / §5.4 (Phase 3 plumbing).
 *
 *   npm test
 *
 * These lock in the two properties the whole design rests on:
 *  1. The renderer only *assembles* — it never invents prose and never leaks a
 *     claim-id into reader-facing text (spec §2, §5.1).
 *  2. Claim attribution is preserved losslessly in the model (spec §9 coverage /
 *     cross-linking depends on it), even though it is invisible to the reader.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectClaimIds,
  validateBlockArticle,
  sentencesOf,
  isAttributed,
  type BlockArticle,
  type Sentence,
} from '../lib/blocks'
import { renderArticleToMarkdown } from '../lib/blockRenderer'

// --- empty article ---------------------------------------------------------

test('renders an empty article to an empty string', () => {
  const article: BlockArticle = { title: 'Empty', sections: [] }
  assert.equal(renderArticleToMarkdown(article), '')
  assert.deepEqual(collectClaimIds(article), [])
  assert.deepEqual(validateBlockArticle(article), [])
})

test('a section with no blocks still renders its H2 heading', () => {
  const article: BlockArticle = {
    title: 'T',
    sections: [{ id: 's1', title: 'Overview', blocks: [] }],
  }
  assert.equal(renderArticleToMarkdown(article), '## Overview')
})

// --- prose with several attributed sentences -------------------------------

test('a prose block joins its sentences into one paragraph', () => {
  const article: BlockArticle = {
    title: 'T',
    sections: [
      {
        id: 's1',
        title: 'Mechanism',
        blocks: [
          {
            kind: 'prose',
            sentences: [
              { kind: 'connective', text: 'Two mechanisms are relevant here:' },
              {
                kind: 'sourced',
                text: 'AMPK activation increases fatty-acid oxidation.',
                claim_ids: ['c1'],
              },
              {
                kind: 'synthesis',
                text: 'These pathways therefore reinforce one another.',
                claim_ids: ['c1', 'c2'],
              },
            ],
          },
        ],
      },
    ],
  }
  const md = renderArticleToMarkdown(article)
  assert.equal(
    md,
    '## Mechanism\n\nTwo mechanisms are relevant here: AMPK activation increases fatty-acid oxidation. These pathways therefore reinforce one another.'
  )
  // Reader cannot tell sourced / synthesis / connective apart (spec §5.4).
  assert.ok(!md.includes('sourced'))
  assert.ok(!md.includes('synthesis'))
})

test('all three sentence kinds render identically (no provenance leaks)', () => {
  const sentences: Sentence[] = [
    { kind: 'sourced', text: 'Alpha.', claim_ids: ['a'] },
    { kind: 'synthesis', text: 'Beta.', claim_ids: ['a', 'b'] },
    { kind: 'connective', text: 'Gamma.' },
  ]
  const article: BlockArticle = {
    title: 'T',
    sections: [{ id: 's', title: 'S', blocks: [{ kind: 'prose', sentences }] }],
  }
  assert.equal(renderArticleToMarkdown(article), '## S\n\nAlpha. Beta. Gamma.')
})

// --- headings and lists ----------------------------------------------------

test('heading blocks render as H3 sub-headings under the H2 section', () => {
  const article: BlockArticle = {
    title: 'T',
    sections: [
      {
        id: 's1',
        title: 'Dosing',
        blocks: [
          { kind: 'heading', text: 'Adults' },
          {
            kind: 'prose',
            sentences: [
              { kind: 'sourced', text: '1.6 g/kg/day.', claim_ids: ['c1'] },
            ],
          },
        ],
      },
    ],
  }
  assert.equal(
    renderArticleToMarkdown(article),
    '## Dosing\n\n### Adults\n\n1.6 g/kg/day.'
  )
})

test('bullets and key_takeaways render as markdown lists', () => {
  const article: BlockArticle = {
    title: 'T',
    sections: [
      {
        id: 's1',
        title: 'Points',
        blocks: [
          {
            kind: 'bullets',
            items: [
              { kind: 'sourced', text: 'First point.', claim_ids: ['c1'] },
              { kind: 'sourced', text: 'Second point.', claim_ids: ['c2'] },
            ],
          },
          {
            kind: 'key_takeaways',
            items: [{ kind: 'sourced', text: 'Remember this.', claim_ids: ['c3'] }],
          },
        ],
      },
    ],
  }
  assert.equal(
    renderArticleToMarkdown(article),
    '## Points\n\n- First point.\n- Second point.\n\n**Key Takeaways**\n\n- Remember this.'
  )
})

// --- callout, table, figure ------------------------------------------------

test('callout renders as a toned blockquote', () => {
  const article: BlockArticle = {
    title: 'T',
    sections: [
      {
        id: 's1',
        title: 'Safety',
        blocks: [
          {
            kind: 'callout',
            tone: 'caution',
            sentences: [
              {
                kind: 'sourced',
                text: 'Monitor hematocrit on TRT.',
                claim_ids: ['c1'],
              },
            ],
          },
          {
            kind: 'callout',
            tone: 'note',
            sentences: [{ kind: 'connective', text: 'Context matters.' }],
          },
        ],
      },
    ],
  }
  assert.equal(
    renderArticleToMarkdown(article),
    '## Safety\n\n> **Caution:** Monitor hematocrit on TRT.\n\n> **Note:** Context matters.'
  )
})

test('table renders a GFM grid and escapes pipes; claim_ids stay hidden', () => {
  const article: BlockArticle = {
    title: 'T',
    sections: [
      {
        id: 's1',
        title: 'Targets',
        blocks: [
          {
            kind: 'table',
            headers: ['Population', 'Dose'],
            rows: [
              ['Adults', '1.6 g/kg'],
              ['Older adults', '2.2 g/kg | max'],
            ],
            claim_ids: ['c1', 'c2'],
          },
        ],
      },
    ],
  }
  const md = renderArticleToMarkdown(article)
  assert.equal(
    md,
    '## Targets\n\n| Population | Dose |\n| --- | --- |\n| Adults | 1.6 g/kg |\n| Older adults | 2.2 g/kg \\| max |'
  )
  assert.ok(!md.includes('c1'))
  assert.ok(!md.includes('c2'))
})

test('figure renders image with caption and optional source', () => {
  const article: BlockArticle = {
    title: 'T',
    sections: [
      {
        id: 's1',
        title: 'Figure',
        blocks: [
          {
            kind: 'figure',
            ref: 'https://example.com/fig.png',
            alt: 'A curve',
            caption: 'Response over time',
            source: 'Study X',
          },
        ],
      },
    ],
  }
  assert.equal(
    renderArticleToMarkdown(article),
    '## Figure\n\n![A curve](https://example.com/fig.png)\n\n*Response over time — Source: Study X*'
  )
})

// --- references ------------------------------------------------------------

test('references render in the existing outlineToMarkdown format', () => {
  const article: BlockArticle = {
    title: 'T',
    sections: [
      {
        id: 's1',
        title: 'Body',
        blocks: [
          {
            kind: 'prose',
            sentences: [
              {
                kind: 'sourced',
                text: 'Supported by trials [R1].',
                claim_ids: ['c1'],
              },
            ],
          },
        ],
      },
    ],
    references: [
      { marker: 'R1', citation: 'Smith et al. 2020.', url: 'https://x' },
    ],
  }
  assert.equal(
    renderArticleToMarkdown(article),
    '## Body\n\nSupported by trials [R1].\n\n## References\n\n1. Smith et al. 2020.'
  )
})

// --- claim-id preservation & leakage ---------------------------------------

test('collectClaimIds returns distinct ids in first-seen order across blocks', () => {
  const article: BlockArticle = {
    title: 'T',
    sections: [
      {
        id: 's1',
        title: 'A',
        blocks: [
          {
            kind: 'prose',
            sentences: [
              { kind: 'sourced', text: 'x', claim_ids: ['c2', 'c1'] },
              { kind: 'synthesis', text: 'y', claim_ids: ['c1', 'c3'] },
              { kind: 'connective', text: 'z' },
            ],
          },
          {
            kind: 'table',
            headers: ['h'],
            rows: [['v']],
            claim_ids: ['c3', 'c4'],
          },
        ],
      },
    ],
  }
  assert.deepEqual(collectClaimIds(article), ['c2', 'c1', 'c3', 'c4'])
})

test('an inline claim-id UUID that leaked into text is stripped from output', () => {
  const uuid = 'd5d0e719-3b37-4855-b72e-e213a3394ac7'
  const article: BlockArticle = {
    title: 'T',
    sections: [
      {
        id: 's1',
        title: 'S',
        blocks: [
          {
            kind: 'prose',
            sentences: [
              {
                kind: 'sourced',
                text: `Male factors matter [${uuid}].`,
                claim_ids: [uuid],
              },
            ],
          },
        ],
      },
    ],
  }
  const md = renderArticleToMarkdown(article)
  assert.equal(md, '## S\n\nMale factors matter.')
  assert.ok(!md.includes(uuid))
  // The id is still tracked structurally for coverage, just not rendered.
  assert.deepEqual(collectClaimIds(article), [uuid])
})

// --- structural validation -------------------------------------------------

test('validateBlockArticle flags a sourced sentence with no claim_ids', () => {
  const article: BlockArticle = {
    title: 'T',
    sections: [
      {
        id: 's1',
        title: 'S',
        blocks: [
          {
            kind: 'prose',
            sentences: [{ kind: 'sourced', text: 'x', claim_ids: [] }],
          },
        ],
      },
    ],
  }
  const issues = validateBlockArticle(article)
  assert.equal(issues.length, 1)
  assert.match(issues[0], /sourced but has no claim_ids/)
})

test('validateBlockArticle flags a synthesis sentence with fewer than 2 ids', () => {
  const article: BlockArticle = {
    title: 'T',
    sections: [
      {
        id: 's1',
        title: 'S',
        blocks: [
          {
            kind: 'prose',
            sentences: [{ kind: 'synthesis', text: 'x', claim_ids: ['only1'] }],
          },
        ],
      },
    ],
  }
  const issues = validateBlockArticle(article)
  assert.equal(issues.length, 1)
  assert.match(issues[0], /synthesis must cite ≥2 claims/)
})

test('validateBlockArticle flags a table with no claim_ids', () => {
  const article: BlockArticle = {
    title: 'T',
    sections: [
      {
        id: 's1',
        title: 'S',
        blocks: [{ kind: 'table', headers: ['h'], rows: [['v']], claim_ids: [] }],
      },
    ],
  }
  const issues = validateBlockArticle(article)
  assert.equal(issues.length, 1)
  assert.match(issues[0], /table carries no claim_ids/)
})

test('a well-formed article is structurally clean', () => {
  const article: BlockArticle = {
    title: 'T',
    sections: [
      {
        id: 's1',
        title: 'S',
        blocks: [
          {
            kind: 'prose',
            sentences: [
              { kind: 'sourced', text: 'a', claim_ids: ['c1'] },
              { kind: 'synthesis', text: 'b', claim_ids: ['c1', 'c2'] },
              { kind: 'connective', text: 'c' },
            ],
          },
        ],
      },
    ],
  }
  assert.deepEqual(validateBlockArticle(article), [])
})

// --- helpers ---------------------------------------------------------------

test('sentencesOf flattens sentence-bearing blocks and skips structural ones', () => {
  assert.equal(
    sentencesOf({
      kind: 'prose',
      sentences: [{ kind: 'connective', text: 'a' }],
    }).length,
    1
  )
  assert.equal(
    sentencesOf({ kind: 'bullets', items: [{ kind: 'connective', text: 'a' }] })
      .length,
    1
  )
  assert.equal(sentencesOf({ kind: 'heading', text: 'a' }).length, 0)
  assert.equal(
    sentencesOf({ kind: 'table', headers: [], rows: [], claim_ids: [] }).length,
    0
  )
})

test('isAttributed distinguishes carrying kinds from connective', () => {
  assert.ok(isAttributed({ kind: 'sourced', text: 'a', claim_ids: ['c'] }))
  assert.ok(isAttributed({ kind: 'synthesis', text: 'a', claim_ids: ['c', 'd'] }))
  assert.ok(!isAttributed({ kind: 'connective', text: 'a' }))
})

// --- determinism -----------------------------------------------------------

test('rendering is deterministic (same input → same output)', () => {
  const article: BlockArticle = {
    title: 'T',
    sections: [
      {
        id: 's1',
        title: 'S',
        blocks: [
          {
            kind: 'prose',
            sentences: [{ kind: 'sourced', text: 'a', claim_ids: ['c1'] }],
          },
        ],
      },
    ],
  }
  assert.equal(renderArticleToMarkdown(article), renderArticleToMarkdown(article))
})
