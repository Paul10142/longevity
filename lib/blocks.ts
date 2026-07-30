/**
 * Sentence-block article model — synthesis-v4 spec §5.2 (Phase 3 plumbing).
 *
 * This is the data model the synthesis rewrite will emit instead of today's
 * flat `{ id, text, claim_ids }` paragraphs (`lib/synthesis.ts`). It is NOT yet
 * wired into the live synthesis path — it ships as a standalone primitive plus a
 * deterministic renderer (`lib/blockRenderer.ts`) so both can be unit-tested in
 * isolation before the generative prompts are rewritten.
 *
 * The core idea (spec §2, §5.1): the model contributes *syntax, never
 * substance*. Every declarative sentence is either **sourced** (carries the
 * `claim_ids` it draws from), **synthesis** (a bridging inference entailed by ≥2
 * cited claims), or **connective** (pure transition/framing that asserts no
 * fact and therefore carries no ids). There is no fourth category. Storing prose
 * at sentence granularity is what makes the groundedness audit per-sentence and
 * makes source→sentence cross-linking (spec §9) fall out for free.
 *
 * Compatibility: this mirrors the local `Outline`/`Section`/`Paragraph` shapes in
 * `lib/synthesis.ts` in spirit (title → sections → …, optional verified
 * `references`) but replaces `Paragraph` with typed `Sentence`s inside typed
 * `Block`s. The public site renders `body_markdown` (produced by the renderer),
 * not this structure, so no migration or dual-render path is required.
 */

/**
 * The three sentence kinds from spec §5.2.
 *
 * - `sourced`   — a declarative sentence backed by one or more claims.
 * - `synthesis` — a bridging inference (spec §5.1): a conclusion neither cited
 *                 claim states outright but that both together entail. Must cite
 *                 ≥2 claims. Surfaced/highlighted in admin review, rendered as
 *                 plain prose to readers.
 * - `connective`— pure transition or framing ("Two mechanisms are relevant
 *                 here:"). Asserts no fact, so carries no `claim_ids`. The audit
 *                 (out of scope here) confirms it truly asserts nothing.
 */
export type Sentence =
  | { kind: 'sourced'; text: string; claim_ids: string[] }
  | { kind: 'synthesis'; text: string; claim_ids: string[] }
  | { kind: 'connective'; text: string }

/** The tone of a callout block (spec §5.2). */
export type CalloutTone = 'note' | 'caution'

/**
 * A table row/cell shape. Spec §5.2 writes `rows: ...` (left unspecified), so we
 * pick the simplest faithful shape: a header row plus a matrix of string cells.
 * Attribution is at the block level (`claim_ids`) rather than per cell, matching
 * how the spec attaches `claim_ids` to the whole `table` block.
 */
export type TableBlock = {
  kind: 'table'
  headers: string[]
  rows: string[][]
  claim_ids: string[]
}

/**
 * The block kinds from spec §5.2, plus one documented addition:
 *
 * - `heading` — NOT in the literal §5.2 schema. Added to satisfy §5.1's
 *   readability-ceiling rule: a section carrying many claims must *sub-section*
 *   rather than emit a wall of assertions. The §5.2 schema has no way to express
 *   an in-section sub-heading, so we add a structural `heading` block (renders as
 *   an H3 beneath the H2 section title). Like `connective`, it asserts no fact
 *   and carries no `claim_ids`.
 */
export type Block =
  | { kind: 'prose'; sentences: Sentence[] }
  | { kind: 'bullets'; items: Sentence[] }
  | { kind: 'key_takeaways'; items: Sentence[] }
  | { kind: 'callout'; sentences: Sentence[]; tone: CalloutTone }
  | { kind: 'heading'; text: string }
  | TableBlock
  | {
      kind: 'figure'
      ref: string
      alt: string
      caption: string
      source?: string
    }

/** A top-level article section (spec §5.2): renders as an H2 heading + blocks. */
export type Section = {
  id: string
  title: string
  blocks: Block[]
}

/**
 * A verified primary-literature reference. Kept structurally identical to the
 * `references` shape in `lib/synthesis.ts` so the renderer's References section
 * matches the existing `outlineToMarkdown` output byte-for-byte. These are
 * citations to studies (`[R1]` markers in prose), never to our ingested sources.
 */
export type Reference = {
  marker: string
  citation: string
  url: string | null
}

/** The full sentence-block article (spec §5.2). */
export type BlockArticle = {
  title: string
  sections: Section[]
  references?: Reference[]
}

// ---------------------------------------------------------------------------
// Pure helpers (deterministic, side-effect free) — useful for coverage
// accounting, admin cross-linking, and tests. None of these render prose.
// ---------------------------------------------------------------------------

/** True for the two sentence kinds that carry attribution. */
export function isAttributed(
  s: Sentence
): s is Extract<Sentence, { claim_ids: string[] }> {
  return s.kind === 'sourced' || s.kind === 'synthesis'
}

/** Every `Sentence` reachable in a block, in document order (flattens the
 * different container fields — `sentences` vs `items`). Structural blocks
 * (`heading`, `table`, `figure`) contain no sentences. */
export function sentencesOf(block: Block): Sentence[] {
  switch (block.kind) {
    case 'prose':
    case 'callout':
      return block.sentences
    case 'bullets':
    case 'key_takeaways':
      return block.items
    default:
      return []
  }
}

/**
 * All distinct `claim_ids` referenced anywhere in the article, in first-seen
 * document order. This is the coverage set (spec §5.1: "coverage counts distinct
 * claim_ids present"). Table blocks contribute their block-level `claim_ids`.
 */
export function collectClaimIds(article: BlockArticle): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const add = (ids: string[] | undefined) => {
    for (const id of ids ?? []) {
      if (!seen.has(id)) {
        seen.add(id)
        out.push(id)
      }
    }
  }
  for (const section of article.sections ?? []) {
    for (const block of section.blocks ?? []) {
      if (block.kind === 'table') {
        add(block.claim_ids)
        continue
      }
      for (const s of sentencesOf(block)) {
        if (isAttributed(s)) add(s.claim_ids)
      }
    }
  }
  return out
}

/**
 * Structural (not semantic) validation issues, per the spec's schema invariants.
 * This is the cheap structural half of the §5.2 audit — it cannot judge whether a
 * sentence is *actually* supported (that stays an LLM pass, §5.2 caveat), only
 * whether the schema rules are internally satisfied:
 *
 *  - a `synthesis` sentence must cite ≥2 claims (spec §5.2 comment "≥2 ids"),
 *  - a `sourced` sentence must cite ≥1 claim,
 *  - a `table` block that asserts data should carry ≥1 claim_id.
 *
 * Returns a list of human-readable issue strings (empty ⇒ structurally clean).
 */
export function validateBlockArticle(article: BlockArticle): string[] {
  const issues: string[] = []
  article.sections?.forEach((section, si) => {
    const where = `section[${si}] "${section.title}"`
    section.blocks?.forEach((block, bi) => {
      if (block.kind === 'table') {
        if (!block.claim_ids || block.claim_ids.length === 0) {
          issues.push(`${where} block[${bi}] table carries no claim_ids`)
        }
        return
      }
      sentencesOf(block).forEach((s, sj) => {
        if (s.kind === 'sourced' && s.claim_ids.length < 1) {
          issues.push(
            `${where} block[${bi}] sentence[${sj}] sourced but has no claim_ids`
          )
        }
        if (s.kind === 'synthesis' && s.claim_ids.length < 2) {
          issues.push(
            `${where} block[${bi}] sentence[${sj}] synthesis must cite ≥2 claims (has ${s.claim_ids.length})`
          )
        }
      })
    })
  })
  return issues
}
