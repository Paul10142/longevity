# v4 — The De-duplication Engine: No-New-Information Synthesis

**Status:** design spec, agreed 2026-07-22. Not yet built. This is the buildable
plan for the single most important rewrite in the project. `ARCHITECTURE.md`
remains the enduring design doc; this spec folds into it once the work lands.
`BACKLOG.md` Stage 2 points here.

---

## For reviewers — read this first

If you have one hour, read this section, then §2 (the thesis), §4 (the risk that
can sink it), and §9 (build order). The three decisions where an outside eye is
most valuable:

1. **Dedup fidelity (§4, §6).** The engine's core job is merging ~46k raw
   insights into ~20k claims. Merge too eagerly and you silently average away
   clinically material differences (dose, population, caveat) — a failure no
   quality score detects, because the prose faithfully reflects a claim that
   quietly lost the nuance. Is the "merge only when materially identical" rule
   the right call, and is it enforceable?
2. **Is "no new information" actually achievable (§5)?** The whole product rests
   on the model contributing *syntax, never substance*. We enforce it with
   sentence-level attribution + a groundedness gate. Is that sufficient, or is
   there a leak we haven't seen?
3. **The cost of sentence-level attribution (§5, §7).** It makes the audit
   mechanical and unlocks source→sentence cross-linking, but it raises
   generation cost and complexity. Worth it, or is paragraph-level plus a
   stricter auditor good enough?

Everything else is downstream of these three.

---

## 1. What this replaces

Today's synthesis (`lib/synthesis.ts`) instructs the model to write an
*"EXHAUSTIVE reference"* with *"no word limit."* Measured consequence: on
thin-evidence topics the model writes to the ambition of that instruction and
fills the gap with outside knowledge. The two live articles with the fewest
claims (AMPK, 5 claims; Cognitive Aging, 8) have the two worst groundedness
scores (0.40, 0.60). The padding is not a model defect — it is the prompt asking
for length the evidence cannot supply.

This spec deletes that pressure and rebuilds synthesis around a single rule.

## 2. The thesis

**The system is a de-duplication and assembly engine. It contributes syntax,
never substance.**

If one source could tell a physician everything, they would read the transcript.
The product is the *merge* — many overlapping sources woven into one reference
where nothing repeats and every statement traces to source. The model's licence
is to organize, order, and connect claims into readable prose. Its prohibition
is to add any fact, number, mechanism, or conclusion that is not in a claim.

Two metrics already in the schema define this exactly:

- **coverage = 1.0** — every approved claim for the topic appears in the article.
- **groundedness = 1.0** — nothing appears that is not supported by a claim.

Coverage-complete and nothing more. **Article length becomes a function of the
evidence, not a target.** A topic with 40 claims yields a short article; a topic
with 500 yields a long one. Neither pads.

## 3. The generative chain — where substance can leak in

The pipeline paraphrases at three hops. "No new information" must hold at all
three, not just the last:

```
transcript ──(1)──▶ raw_insight ──(2)──▶ claim ──(3)──▶ article prose
             extract          consolidate        synthesize
```

- **Hop 1 (extract):** LLM restates a passage as a `raw_insight`. Governed by
  `direct_quote` (verbatim anchor, already built) — the insight is checkable
  against the source words.
- **Hop 2 (consolidate):** LLM *merges* several insights into one
  `canonical_statement`. **This is the riskiest hop and the least policed.** A
  merge of twenty near-identical insights produces a statement that is a blend
  none of them said. At 200 podcasts this hop does the most work (dedup rises
  from today's 5.5% to an expected 40–60% as sources overlap). §6 governs it.
- **Hop 3 (synthesize):** the article. §5 governs it.

The old plan watched only hop 3. This spec instruments and constrains all three.

## 4. Scale reality (measured, 2026-07-22)

From the five processed sources: ~140k characters and ~230 insights per 2-hour
podcast. A full crawl of peterattiamd.com confirms the target corpus and — this
is the important finding — **the topic count is bounded by a curated taxonomy
that is essentially the one already seeded.** Attia organizes ~400 episodes into
the same six branches and ~40 leaf sub-topics the spine already carries.

| | Now (5 sources) | Target (~200 podcasts) |
|---|---|---|
| Raw insights | 1,072 | ~46,000 |
| Claims after dedup | 1,013 (5.5% merged) | ~18,000–28,000 (40–60% merged) |
| Leaf topics | 133 | **~40–60 curated leaves** (few hundred nodes) |
| **Claims per topic** | ~8 avg | **~300–600** |
| Full-build cost | ~$400–600 | **~$2,000–5,000** (Batch API halves it) |

**The consequence for the design:** topic proliferation was never the risk. The
two hard problems are (a) **consolidating ~20k claims accurately** (hop 2), and
(b) **synthesizing an article over 300–600 claims** without padding or dropping
any (hop 3). Build and measurement effort concentrates there.

## 5. Synthesis rewrite (hop 3)

### 5.1 The rule set

Replace the "EXHAUSTIVE / no word limit" prompt language with:

- **Cover every assigned claim exactly once. Add nothing else.** Length follows
  from claim count.
- **Every declarative sentence is either sourced or connective.** A sourced
  sentence carries the `claim_ids` it draws from. A connective sentence (pure
  transition, framing, "Two mechanisms are relevant here:") carries none and
  asserts no fact. There is no third category.
- **Bridging inference is allowed, must cite, and is marked.** When the model
  connects two claims into a conclusion neither states outright (claim A:
  "testosterone raises hematocrit"; claim B: "elevated hematocrit raises
  thrombosis risk" → "hematocrit therefore warrants monitoring on TRT"), the
  sentence must cite *both* source claims and be typed `synthesis`. The inference
  must be logically entailed by the cited claims, not merely plausible.
- **Definitions: glossary-only.** The model may not free-write an explanation of
  a term the corpus never defines. It may pull a definition from an approved
  glossary (§5.3). No glossary entry → the term stands undefined.
- **No source narration.** Never "as the source said", "the speaker notes",
  "according to the podcast." The reader must never think about provenance; the
  merge is the point. (Reference markers `[R1]` to *primary literature* stay —
  those are citations to studies, not to our ingested sources.)

### 5.2 Data model — sentence-level attribution

Today a paragraph is `{ id, text, claim_ids }`. Replace with typed sentences so
attribution and the audit are mechanical:

```ts
type Sentence =
  | { kind: 'sourced';     text: string; claim_ids: string[] }
  | { kind: 'synthesis';   text: string; claim_ids: string[] }  // ≥2 ids
  | { kind: 'connective';  text: string }                        // no assertion
type Block =
  | { kind: 'prose';         sentences: Sentence[] }
  | { kind: 'bullets';       items: Sentence[] }
  | { kind: 'key_takeaways'; items: Sentence[] }
  | { kind: 'callout';       sentences: Sentence[]; tone: 'note'|'caution' }
  | { kind: 'table';         rows: ...; claim_ids: string[] }
  | { kind: 'figure';        ref: string; alt: string; caption: string; source?: string }
type Section = { id: string; title: string; blocks: Block[] }
```

This one change delivers four things at once:
1. **Mechanical audit.** Groundedness becomes "does every `sourced`/`synthesis`
   sentence cite valid claim_ids, and does the auditor confirm the assertion is
   supported?" — not a whole-paragraph judgement call.
2. **The block schema Paul asked for** (bullets, callouts, key-takeaways,
   tables, figures) — the current flat-paragraph model cannot express any of it.
3. **Source → sentence cross-linking** (§8) falls out for free.
4. **`synthesis` marking** is captured structurally, so it can be surfaced in
   admin review and hidden from readers per Paul's decision.

`outlineToMarkdown` is the single render choke point (the public site renders
`body_markdown`, not `outline`, so no migration and no dual-render path is
needed — existing articles keep rendering). Extend it to emit each block kind;
`synthesis` and `connective` render as plain prose to readers.

### 5.3 The glossary

New table `glossary_terms(term, definition, status, created_by, embedding)`.
Definitions are **reviewed content, not generated content** — the model proposes,
Paul approves, and only `approved` definitions are injected into synthesis. This
converts "the model explained AMPK from its own knowledge" (an ungrounded
assertion) into "the model used an approved definition" (traceable). Build the
proposal flow with the review UI (§7); seed lazily as topics need terms.

### 5.4 Reader-facing vs admin-facing

- **Readers** see clean prose. `sourced`, `synthesis`, and `connective`
  sentences are visually identical. Verified primary-literature references
  (`[R1]`) are shown.
- **Admin/review** sees the `synthesis` sentences highlighted, every sentence's
  `claim_ids` on hover, and the coverage/groundedness scores.

## 6. Consolidation fidelity (hop 2)

The engine's core, and the least-tested component. Rules:

- **Merge only when materially identical.** Two insights merge into one claim
  only if they assert the same thing at the same specificity. **Differing dose,
  population, threshold, timeframe, or caveat blocks the merge** — those become
  separate claims, linked as related, not fused. Preserving that difference is
  the clinical value a physician pays for; averaging it away is a worse failure
  than padding because no score catches it.
- **Contradictions are surfaced, never merged.** Two claims that assert opposite
  things become a flagged pair (§7), feeding the consensus/contested work.
- **The canonical statement must stay traceable.** When insights do merge, the
  canonical statement may not introduce specifics none of its members carried.
  Prefer the most precise member's phrasing over a generated blend.

### 6.1 Measured dedup accuracy — built first, non-negotiable

Paul's requirement: prove the engine, don't trust it. Before the rewrite ships,
build a **dedup-accuracy harness**:

- **A labelled eval set.** Sample N insight pairs the consolidator judged
  (SAME / DIFFERENT / CONTRADICTS), stratified across confidence. A human
  (Paul) labels the ground truth once.
- **Metrics.** Precision and recall on merges. **False-merge rate is the
  headline** — a false merge is the nuance-destroying failure and matters more
  than a missed merge (which only leaves a mild duplicate). Track both.
- **A regression gate.** Re-run on every change to the consolidation prompt or
  threshold; a false-merge regression blocks the change.
- **Cost:** a few dollars per run. This is the instrument that makes every later
  consolidation change measurable instead of a matter of faith.

## 7. Claim review workflow — the human gate, moved upstream

The key architectural inversion: **claims are gated before synthesis, not
articles after.** A flagged claim is quarantined and invisible to synthesis
until Paul approves it. Clean claims in → the article is trustworthy by
construction, and the groundedness gate demotes from a daily work queue to a
rarely-firing alarm.

### 7.1 Claim status lifecycle

Extend `claims.status` (today only `active`) to:

```
approved     — visible to synthesis. (The bulk-migrated existing 1,013 land here.)
flagged      — quarantined; invisible to synthesis; in Paul's review queue.
merged       — folded into another claim (existing merged_into_id semantics).
archived     — retired.
```

Only `approved` claims are loaded by synthesis and counted toward a topic's
claim minimum.

### 7.2 What auto-flags a claim (tuned narrow — high precision)

Paul's sustainable review budget is **a few hundred per 100 hours ingested**, so
flagging fires rarely and is right when it does. Three rules only:

1. **Fails the standalone test.** A physician reading only that sentence could
   not evaluate or act on it: dangling reference ("it improves outcomes" —
   what is "it"?), missing population/dose where one is clearly implied, or
   context that lived in the transcript and didn't survive extraction. **This is
   the keystone rule** — an unclear claim is the upstream cause of ungrounded
   prose. If a claim can't stand alone, the model must supply the missing
   context when it writes, and *that is the padding, one hop earlier than anyone
   was looking.* Fixing claims here is what makes §5 hold.
2. **Direct contradiction** between two claims. Low volume, high stakes; feeds
   consensus/contested labelling.
3. **Orphan / weak topic fit** — attached to no topic, or below the tagging
   threshold. Cheap to review; surfaces taxonomy gaps.

Explicitly **not** flagged: hedged language (podcast speech is inherently
hedged), and near-merge dose/population differences (§6 already keeps those
*separate*, so there is nothing to adjudicate).

### 7.3 Review actions

Paul edits **prose of a claim** (fix the standalone-clarity problem) or
approves / archives it. Editing claims happens *only* while flagged, and flagged
claims are invisible to articles — so **there is never a case of editing a claim
an article already depends on.** The cascade problem is designed out.

### 7.4 Existing corpus

The 1,013 current claims predate this workflow. **Bulk-approve them**, then run
the flag rules retroactively to surface the subset that needs eyes. This
configures the platform on existing sources (Paul's stated near-term goal)
without blocking on a full manual pass.

### 7.5 Late conflict

A new source contradicts an already-published claim (the corpus grows, so this
will happen): **flag the claim, keep the article live** citing what was true at
generation time, enqueue the conflict for review, and regenerate the article on
resolution. No silent contradictions; no surprise unpublishing.

### 7.6 Quarantine vs. the claim minimum

Quarantining a flagged claim can drop a topic below the 10-claim article
minimum. **Do not unpublish the live article** — quarantine removes the claim
from the *next* regeneration only. Articles must not flicker in and out of
existence as Paul works the queue.

## 8. Gates and thin topics

- **Minimum claims to attempt an article: ~10–15.** Attacks the padding cause at
  the root — a 5-claim topic should not generate a physician reference. Below the
  threshold the topic is **hidden from readers entirely** (Paul's decision), not
  stubbed. It still exists for tagging; nav must hide it too. As the corpus
  grows the topic crosses the threshold and an article is generated.
- **Groundedness floor + absolute cap.** Ratio floor ≈ 0.85 *and* an absolute
  cap of ~2 ungrounded sentences, so a long article cannot accumulate
  unsupported assertions while passing on ratio. Below the gate the article is
  **held for manual approval** (Paul approves via admin), not published.
- **Prerequisite bug — fix before any hold policy ships.** `scoreGroundedness`
  ends `catch { return 1 }` (`lib/synthesis.ts:355`) — a checker failure returns
  a *perfect* score. Under a hold policy that becomes auto-approve-on-error, the
  exact inversion of the gate. Return `null` on failure and treat null as
  "hold, unscored."
- **Approval queue.** "Hold for manual approval" needs a queue and an
  approve/edit/reject UI. Approving may include editing the article prose
  (Paul's choice: the manual editor fixes prose). This UI does not exist yet.

## 9. Cross-linking (source ↔ claim ↔ article)

Enabled directly by §5.2. Once every sentence carries `claim_ids`, the full
chain is traversable and should be exposed for manual review:

```
source ─▶ its raw_insights ─▶ claim_members ─▶ claims ─▶ claim's article sentences
```

- **Source page:** "this source produced N claims, M of which reached articles"
  with the exact article sentences linked. This is the review tool Paul asked
  for — look at a source, see what it became.
- **Claim page:** which insights compose it, which article sentences cite it.
- **Article (admin):** each sentence reveals its supporting claims and their
  sources.

Per-source novelty % (the dedup proof) is computed here and is **internal-facing
only** (Paul's decision) — it advertises how redundant a source was, which is an
admin metric, not a reader one.

## 10. Non-goals and deferrals (explicit, so nobody "fixes" them)

- **Patient article: deferred.** All of this rewrite targets the *clinician*
  article — the product sold to physicians. The patient view is rebuilt only
  after no-new-information is proven on the clinician article. Do not spend Stage
  2 effort on it.
- **Images: included, licensing later.** The `figure` block ships; image
  *sourcing/licensing* is deferred. Flagged as a rights exposure to settle
  before the product is sold, not before it is built.
- **Definitions beyond the glossary, evidence grading, contradiction queue UI,
  what's-new delta:** all later stages, tracked in `BACKLOG.md`.

## 11. Build order (what the execution agent does, in sequence)

Each step is independently verifiable. Do not start a step until the one before
it is green.

0. **Measurement harness first.** (a) Dedup-accuracy eval set + false-merge
   metric (§6.1). (b) A fixed article eval set of ~5 topics with current
   groundedness/coverage/length recorded. *This is the instrument for
   everything below.* No behaviour change; ~$5–10 to run.
1. **Fix the groundedness bug** (§8, `catch → null`). Tiny, unblocks the hold
   policy, safe to ship alone.
2. **Claim status lifecycle + bulk-approve existing** (§7.1, §7.4). Migration +
   backfill. Synthesis reads `approved` only.
3. **Flagging** (§7.2) — the three rules, run over the existing corpus, output
   into the review queue.
4. **Claim review UI** (§7.3) — flagged queue, edit/approve/archive.
5. **Sentence-level article schema + renderer** (§5.2) — the block types and
   `outlineToMarkdown` extension. Verify existing articles still render.
6. **Synthesis rewrite** (§5.1) — new prompts, glossary injection, the gates
   (§8). Re-generate the eval set; groundedness must rise and length must fall on
   thin topics. **This is the payoff step; step 0 is what proves it worked.**
7. **Glossary proposal + review** (§5.3).
8. **Cross-linking read views** (§9).
9. Only now consider ingesting breadth and the full build (`BACKLOG.md` Stage
   3+).

## 12. How this changes `BACKLOG.md`

- Stage 2 is superseded by this spec; the backlog should point here and keep only
  its one-line stage summaries.
- Several P1.5 walkthrough items are absorbed: A1 (source narration) → §5.1;
  A2 (block schema) → §5.2; A4 (images) → §5.2/§10; B (evidence looks
  duplicated) → §9 display; D1 (insight→article tracing) → §9.
- P3.5 novelty % → §9 (internal-only). Consensus/contested and contradiction
  queue inherit the `flagged` machinery from §7.
- The groundedness items in P1 → §8. The `catch{return 1}` bug is new here and
  is build step 1.
