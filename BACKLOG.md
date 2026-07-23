# Backlog

Known outstanding work, captured 2026-07-22 during the v1 dead-code cleanup
(commits `0a37deb`..`ebe3697`). Everything here was verified against the code
or the live database at that time — items are written with enough context to
act on without re-deriving them.

`ARCHITECTURE.md` remains the authoritative design doc; this file is a to-do
list, not a spec. Items already specced there are linked rather than restated.
The v4 synthesis rewrite has its own buildable spec at
[`docs/synthesis-v4-spec.md`](docs/synthesis-v4-spec.md) — Stage 2 below points
there.

---

## ▶ START HERE — execution entry point

**For the agent picking this up in a fresh conversation.** This file is the
work queue; work it top-down by stage. The rule of the project is in one line:
**the system is a de-duplication and assembly engine — it contributes syntax,
never substance. Every statement traces to a claim; every claim traces to a
source.**

Before writing code:

1. **Read [`docs/synthesis-v4-spec.md`](docs/synthesis-v4-spec.md) end to end.**
   It is the design for the central rewrite and it supersedes Stage 2 here.
2. **Read [`docs/v4-build-risks-and-cost.md`](docs/v4-build-risks-and-cost.md).**
   It is the **sequencing authority** — edge cases, cost levers, and a revised
   build order (§D) that resolves ordering traps the spec's §11 doesn't (chiefly:
   re-extract for `start_ms` *before* claim review, or the review is thrown away).
   Where §D and the spec's §11 differ, **§D wins on order**; the spec wins on
   what each step builds.
3. **Read `ARCHITECTURE.md`** for the enduring data model and invariants, and
   `CLAUDE.md` for commands and conventions.
4. **Follow `v4-build-risks-and-cost.md` §D** as the turn-by-turn sequence, using
   the spec for the detail of each step. The Stages below are the high-level map.

Ground rules for this codebase (from `CLAUDE.md`, repeated because they bite):

- Run `npm run build` before considering any step done.
- DB schema changes are numbered SQL in `supabase/migrations_v2/`, applied via
  the Supabase SQL Editor / MCP — there is no local psql.
- Anything touching `topics` or `claims` at scale: **dry-run first, verify
  counts before and after.** A concurrent seed once split the live spine.
- `raw_insights` are immutable. Long work goes through the `jobs` queue with
  checkpoints, never inline in a request handler.
- There is **no test harness and no spend cap yet** — build step 0 (the
  measurement harness) addresses the first; treat every `generate_topic`-style
  run as real money until a cap exists.

**First task, concretely — `v4-build-risks-and-cost.md` §D Phase 0, in order:**
1. Fix the consolidation adjudication prompt (§A2) — a material dose/population/
   threshold difference must yield DIFFERENT, not SAME. The single
   highest-leverage change; everything consolidated afterward inherits it.
2. Fix `scoreGroundedness`'s `catch { return 1 }` → `null` (spec §8).
3. The doc reconciliations (§A1/A3/A4) are already applied in the repo — just
   verify nothing re-introduced them.
4. **Then** build the measurement harness (spec §6.1): dedup-accuracy eval +
   article-quality eval set, with the audit moved to Haiku (§C2). It changes no
   behaviour, costs ~$5–10, and is the instrument every later step is judged
   against. Do not skip it — without it, the synthesis rewrite is unfalsifiable.

Then Phase 1 begins with the **timestamp demonstration** on
`youtube.com/watch?v=s-qapZuy0GY` (§D Phase 1 step 5) — Paul's chosen first
visible feature.

**Decisions already made** (do not re-litigate; rationale in the spec / guiding
doc): the seven principles (`ARCHITECTURE.md` top); merge only when materially
identical, near-duplicates linked not fused; claims gated before synthesis;
hold-below-floor with manual approval (floor 0.85 + cap 2, **to be re-derived on
sentence scores — spec §F5**); one unified review inbox, not four queues (§B4);
fix reference resolution, include what resolves; delete the queued `update_topic`
jobs; images in / licensing later; **protocol rewritten with the clinician
article, patient deferred**; **existing articles left live until regenerated**;
novelty % internal-only, reported as redundant/refinement/novel buckets; thin
topics hidden from readers; **full-breadth launch (~40–60 leaves)**; manual
editor edits **prose**; measured dedup accuracy from the start; transcript
hygiene strips ads/intros/outros before extraction.

**Open items that still need Paul** (flag, don't guess — most earlier ones are
now decided above):
- The **final** groundedness floor + cap numbers, once the harness produces
  sentence-level baselines (the 0.85/cap-2 are paragraph-era placeholders).
- Validate the standalone-flag rubric on ~30 claims (spec §F6) — a hands-on
  review task at Phase 2, not a blocker before it.
- Which specific sources to ingest for breadth (Phase 4) — Paul wants the
  existing corpus configured first regardless.

---

## Before starting — preconditions, decisions, and what is missing

Audited 2026-07-22 before beginning the plan below. Three gaps were **not
represented anywhere in this file**, and one piece of good news materially
de-risks the largest change.

### Decisions — answered 2026-07-22

1. **Groundedness: hold and require manual approval.** Below the floor an
   article is not published; it waits for Paul. See the section below for what
   the number means and what the floor should be — the policy has a
   prerequisite bug that must be fixed first.
2. **References: fix, and include what resolves.** Partial resolution is
   accepted — some citations are conversational and have nothing linkable.
   Show the ones that resolve; never present an unresolved mention as verified.
   This retires the "or stop presenting it as a feature" branch.
3. **Queued `update_topic` jobs: delete them.** Reasoning below — it is safe,
   and it avoids paying for output that Stage 2 will discard.
4. **Images: include them now, licensing later.** Recorded as a deliberate
   deferral, not an oversight. Revisit before the product is sold, since
   re-used third-party images in a paid product is a rights exposure that grows
   with every article.

---

## Understanding groundedness (the number, not the concept)

Paul asked what the levels actually mean. This is what the code computes, and
what the live numbers say.

### The formula

`lib/synthesis.ts:332` sends every paragraph to Claude with the claims it cites
and asks which paragraphs contain a factual assertion **not** supported by those
claims. Then:

```
groundedness = 1 − (ungrounded paragraphs ÷ total paragraphs)
```

Three consequences follow, and each matters for setting a floor.

**It is a paragraph ratio, not a fact ratio.** A paragraph with one loose clause
counts exactly the same as a paragraph that is wholly invented. So the score is
coarse, and at the margin pessimistic — 0.67 may be three paragraphs each with
one unsupported sentence rather than a third of the article being fiction.

**It is quantized by paragraph count, which makes short articles volatile.**
AMPK Signaling has **5 paragraphs**, so its score can only ever be 0, 0.2, 0.4,
0.6, 0.8 or 1.0. A floor of 0.7 on a 5-paragraph article means, exactly, "at
most one bad paragraph". The same floor on a 29-paragraph article permits eight.

**It measures support, not truth.** A claim can be wrong and the article
perfectly grounded in it. Groundedness says the prose traces to the corpus; it
says nothing about whether the corpus is right.

### What the live numbers say

| Topic | Score | Claims | Paragraphs | Ungrounded |
|---|---|---|---|---|
| AMPK Signaling | 0.40 | 5 | 5 | 3 |
| Cognitive Aging | 0.60 | 8 | 15 | 6 |
| Sleep & Cognition | 0.67 | 8 | 12 | 4 |
| Resistance Training | 0.67 | 16 | 12 | 4 |
| Rough-and-Tumble Play | 0.69 | 9 | 16 | 5 |
| Sleep | 0.70 | 16 | 10 | 3 |
| Mental Health & Psychology | 0.79 | 5 | 24 | 5 |
| Functional Aging | 0.86 | — | 21 | 3 |

**The dominant pattern is thin evidence, not bad writing.** The two worst
articles have the two thinnest claim pools (5 and 8 claims). The prompt tells
the model this is an *"EXHAUSTIVE reference"* with *"no word limit"*
(`lib/synthesis.ts:161`) — so when a topic has five claims, the model writes to
the ambition of the instruction and fills the gap with outside knowledge. That
is precisely what an ungrounded paragraph is.

Note the honest exception: Mental Health & Psychology has 5 claims and 24
paragraphs yet scores 0.79. The correlation is real but not clean, so treat
"thin claims → low groundedness" as the leading explanation, not a law.

**Compare AMPK and Functional Aging: both have 3 ungrounded paragraphs.** One
scores 0.40, the other 0.86. A pure ratio lets a long article carry far more
unsupported assertions than a short one — which for a clinician product is
arguably backwards.

### What the floor should be

**Prerequisite bug — fix this before any hold policy ships.**
`scoreGroundedness` ends with `catch { return 1 }` (`lib/synthesis.ts:355`). A
checker failure returns a **perfect** score. Under "publish everything" that was
merely sloppy; under "hold below the floor" it becomes an auto-approve on error
— the exact inversion of what the gate is for. Make the failure return `null`
and treat null as "hold, unscored".

**Recommendation — three gates rather than one number:**

1. **Ratio floor ≈ 0.85.** Above the current 0.7 (which was never chosen), and
   it holds everything in the table above except Functional Aging.
2. **Absolute cap of ~2 ungrounded paragraphs**, so a long article cannot
   accumulate unsupported assertions while passing on ratio.
3. **A minimum claim count to attempt an article at all** — likely 10–15. This
   attacks the cause rather than the symptom: a 5-claim topic should not be
   generating a physician reference. It should stay a stub until the corpus
   supports it, which also answers the P3.6 "thin branches are reader-visible"
   item.

Gate 3 is the high-value one. Gates 1 and 2 catch bad articles; gate 3 stops
them being written, and stops paying for them.

**This also implies a review queue** — "hold for manual approval" needs
somewhere for held articles to sit, and a UI to approve or reject them. That
work does not exist yet and is not costed anywhere else in this file.

### Why deleting the queued jobs is safe

`stale_topics()` (migration 005.2) is a `stable` SQL function that derives
staleness by comparing `claim_topics.created_at` against the article's
`claims_snapshot_at`. **Staleness is computed, never stored.** Deleting a queued
`update_topic` row therefore discards nothing permanent — the next sweep
recomputes the identical set.

And deleting is the better choice right now: Stage 2 rewrites the prose rules
and the article schema, so every article those jobs would patch is due for full
regeneration anyway. Running them means paying to patch output that is about to
be replaced.

### Still open — the questions that shape the work

Not urgent the way Stage 1 is, but each one changes what gets built, so leaving
them unanswered means guessing.

1. **Which article is the flagship — clinician or patient?** The product is sold
   to physicians, yet the engagement feedback (P1.5 A3) was mostly about the
   patient view. These pull in different directions: the clinician article
   optimizes for exhaustiveness, the patient one for being readable enough to
   finish. Stage 2 effort splits according to the answer.
2. **Where do held articles go, and who approves them?** Implied by decision 1
   above. Needs a review queue and an approve/reject UI that does not exist.
   Does approval publish as-is, or is editing (P1.5 E) part of approving?
3. **Which sources come next?** Stage 3 says "ingest breadth — Exercise, Sleep,
   Nutrition" without naming anything. A concrete list is needed, and it
   determines whether the thin branches fill in.
4. **How big is the library at launch?** Ten strong topics or a hundred thin
   ones is a positioning decision, and it sets the build budget.
5. **Is per-source novelty reader-facing or admin-only?** It is the clearest
   proof the dedup engine works, which argues for showing it to prospects — but
   it also advertises how much of a source was redundant.
6. **Does the manual editor edit prose, or the underlying claims?** Editing prose
   fixes one article; editing a claim fixes everywhere it appears. The second is
   more powerful and much harder.

### Missing infrastructure

#### There are no tests and no CI
No test runner, no `test` script, no `.github/workflows`. Every change so far
has been verified by `npm run build`, type-check, and eye. That was tolerable
while the work was schema and plumbing; it is **not** tolerable for Stage 2,
which rewrites the prompts and the article schema — the highest-value and least
verifiable code in the project.

LLM prose can't be unit-tested, but the parts Stage 2 actually breaks are pure
functions: `splitIntoChunks`, `outlineToMarkdown`, `stripInlineClaimIds`,
`slugify`, and whatever block renderer A2 introduces. Those deserve tests before
they are rewritten, not after.

**Done when:** a test runner exists and covers the pure helpers in
`lib/synthesis.ts` and `lib/extraction.ts`. Small — one afternoon — and it is
the difference between "the build passed" and "the output is still correct".

#### There is no regression check for article quality
The real question for Stage 2 is *"did the articles get better or worse?"*, and
nothing answers it today. Usefully, the metrics already exist: every article
stores `groundedness_score` and `coverage_score`.

**Recommendation:** before changing any prompt, pick ~5 topics as a fixed eval
set, record their current scores and lengths, and re-measure after each prompt
change. This turns a subjective "reads better" into a number, and costs about
$5 per run. Do this **first** in Stage 2 — it is the instrument for everything
else in that stage.

#### Everything runs against production
One Supabase project, one `.env.local`, no staging or branch database. Every
migration, seed, and pipeline run so far has executed against live data — which
is how a concurrent seed managed to split the live spine.

Not necessarily worth fixing (Supabase branching exists but adds cost and
friction for a solo project), but it should be a **conscious** choice rather than
an unexamined default. The practical mitigation already in use — dry-run first,
verify counts before and after — should stay mandatory for anything touching
`topics` or `claims`.

#### There is no spend cap
`lib/worker.ts` enforces a **time** budget (300s, Vercel's `maxDuration`) — not
a cost budget. Nothing stops a queue from spending unboundedly; the 51 stray
`generate_topic` jobs were caught by inspection, not by a guardrail, and would
have cost ~$50 unasked. The full build is $400–600 through the same path.

**Done when:** a job-count or estimated-spend ceiling per tick, and a
`generate_topic` enqueue path that refuses to queue a library-wide run without
an explicit flag.

### Good news: the article schema change is safer than it looks

`app/topics/[slug]/page.tsx` renders **`body_markdown`**, not `outline`. So the
55 existing articles keep rendering unchanged no matter what happens to the
block schema, and `outlineToMarkdown` is the single choke point where new block
types become reader-facing. A2 does not need a data migration or a
dual-rendering path — it needs one function extended and one prompt schema
widened.

### Gaps I looked for and did not find

Recorded so the audit isn't repeated: no orphaned references to dropped tables,
no untracked files, working tree clean, `ARCHITECTURE.md` current as of
`c0b42c0`. The taxonomy is settled and guarded at three layers. Nothing in
`docs/archive/` is load-bearing.

---

## The plan — what to work on, in order

The sections below are a catalogue, ordered by severity. This section is the
*sequence*, ordered by dependency. Four stages, and the ordering is not
preference: each one is cheaper or safer because the one before it happened.

### Stage 1 — Stop shipping untrustworthy articles (do first, blocks the build)

Everything here must land **before** the full library build, because the build
would otherwise mass-produce the same defects at ~$400–600.

1. **Make the groundedness gate block.** Pick a floor; hold or flag articles
   below it instead of logging. Live articles sit at 0.40. → P1
2. **Capture `start_ms` at extraction.** Retroactive-hostile: fixing it later
   means re-extracting everything. Must precede the next ingest, not follow it.
   → P2
3. **Diagnose reference resolution** (4 of 76). Either fix it or stop
   presenting verified references as a feature — the build bakes whichever is
   true into every article. → P2
4. **Clear the two operational stragglers**: source `d32c0fc8` stuck in
   `processing`, and the 5 queued `update_topic` jobs (decide: run or drop).
   → P2

### Stage 2 — The de-duplication engine rewrite → see the spec

**This stage is fully specced in [`docs/synthesis-v4-spec.md`](docs/synthesis-v4-spec.md).**
Build it in that document's §11 order. The summary of *why* it is here and ahead
of corpus work: every item is a property of **each generated article**, so the
full build multiplies any defect by ~50 topics. Regenerating afterwards means
paying the build cost ($2–5k at target scale) twice.

What the spec covers, so this map stays honest:

- The measurement harness — dedup accuracy + article eval set — **built first**
  (spec §6.1, §11 step 0). Paul's requirement: prove the engine, don't trust it.
- The no-new-information rewrite: length follows evidence, not a word target;
  sentence-level attribution; glossary-only definitions; no source narration
  (spec §5). Absorbs walkthrough items A1 (source narration) and A2 (block
  schema).
- Consolidation fidelity — merge only when materially identical (spec §6).
- Claims gated **before** synthesis via a flag/quarantine/approve lifecycle
  (spec §7). This is the architectural inversion that makes the rest tractable.
- The gates: min-claims, groundedness floor + absolute cap, the
  `catch{return 1}` bug fix, thin topics hidden (spec §8).

Deferred out of this stage (spec §10): the patient article (walkthrough A3) —
rebuilt only after no-new-information is proven on the clinician article.

### Stage 3 — Make the corpus worth building from

8. **Ingest breadth** — Exercise, Sleep, Nutrition sources. The skew is an
   ingestion artefact, not a defect, but building now yields one deep branch
   and nine thin ones. → P3.6
9. **Regenerate the 45 pre-coverage-gate articles.** Cheap relative to the full
   build, and it makes "comprehensive" true of the library rather than ten
   articles. Do it *after* stages 1–2 so the regeneration is not itself
   wasted. → P1

### Stage 4 — The full library build (one budgeted run)

10. **Batch API path** first if the discount is wanted — it is a 50% lever on
    the single most expensive action in the project. → P3.5
11. **Run the build.** Preconditions: taxonomy settled (✅ done), gate blocking
    (1), provenance captured (2), article shape fixed (5–7), corpus balanced
    (8). → P3.6

### Stage 5 — The B2B differentiators (what makes it sellable)

Sequenced by dependency, not by appeal:

12. **Per-source novelty %** — inputs already exist (consolidation decides
    SAME/DIFFERENT); this is recording and surfacing, not new inference. The
    single clearest proof the dedup engine is real. Build it together with the
    admin per-source stats dropdown (P1.5 D3) — same query, two views. → P3.5
13. **Consensus vs contested labelling** — needs a structured field before any
    UI or override can exist. → P3.5
14. **Claim relations → contradiction queue** — depends on 13 for its verdict
    vocabulary. → P3.5 / Phase 8
15. **"What's new since last visit"** — versioned sections are the hard
    prerequisite and already exist. → P3.5

**Running alongside, unblocked by any of the above.** None of these touch the
pipeline, and all are user-facing today:

- The public-site P1s — legal pages, lever copy.
- The admin/UX cluster from the walkthrough: evidence grouping (P1.5 B), the
  jobs/run-history merge (C), insight badge labels and sorting (D), the
  default-empty Insight Review (D2), UI polish (F), and library navigation (G).
- **Manual article editing (P1.5 E)** is the exception — it looks like UI work
  but collides with regeneration, so treat it as pipeline work and settle the
  edit-survives-regen question before building the editor.

---

## P1 — Broken for users right now

### Legal pages 404 on every page of the site
`/privacy-policy` and `/terms-of-use` are linked from the global footer but no
routes exist. A sweep of every static internal `href` in `app/` and
`components/` against the route tree found these are the only two dead links
left. Most consequential item here, especially with a membership offering
planned.

**Done when:** both routes exist with real policy text. Needs actual legal
copy — scaffolding empty pages is not a fix.

### Articles ship below the groundedness gate — live, on a clinician product
`lib/synthesis.ts:427` scores groundedness, logs `[synthesis] low groundedness`
when it falls under 0.7, and then **saves the article anyway**. Nothing blocks,
quarantines, or retries. Measured across the 28 live clinician articles
(2026-07-22):

| Article | Groundedness |
|---|---|
| AMPK Signaling | **0.40** |
| Cognitive Aging | **0.60** |
| Sleep & Cognition / Resistance Training | 0.67 |
| Rough-and-Tumble Play | 0.69 |
| Sleep | 0.70 |
| Lifespan / Cold Exposure Protocols | 0.75 |

Groundedness is the share of paragraphs whose assertions are actually supported
by their cited claims. At 0.40, most of the AMPK article's assertions trace to
nothing in the corpus. The whole pitch is that a physician can trust every
statement, so this outranks every cosmetic item in this file.

**Done when:** an article below a chosen floor is not published — held for
review, regenerated, or saved with a visible flag. Decide the floor
deliberately (0.7 is currently only a log threshold, not a considered value).

### Most of the library predates the coverage gate
45 of 55 `topic_articles` rows have `coverage_score = null`: they were generated
before sectioned, claim-complete synthesis existed. Only the ten regenerated
since carry `coverage_score = 1`. The size gap is stark — Testosterone went
5,385 → 46,001 characters when regenerated; Male Fertility Assessment 3,803 →
45,214.

So "comprehensive, nothing dropped" is currently true of ten articles, not the
library. Because the read side renders `order by version desc limit 1`, the
newest row wins and regeneration is safe — old versions stay as history.

**Done when:** every clinician article has a non-null `coverage_score`. These
topics are small, so this is far cheaper than the full build.

### Lever copy on `/start` is unreviewed placeholder
See `TODO(copy)` in `lib/levers.ts`. The `tagline`, `description`, and
`primaryBenefits` for all five levers were drafted to get the grid rendering
after the v1 `concepts` table was dropped and the originals lost. This is
public marketing copy on a primary landing page.

**Done when:** all five levers carry copy you've written. Single file, no
schema involved.

### "Popular protocols" cards mismatch their destinations
`components/PopularProtocolsStrip.tsx` — a hardcoded list of six protocol cards
("Zone 2 Cardio Protocol", "Sleep Hygiene Protocol") that link to broad topic
pages (`/topics/exercise`). The links work; the specificity does not match.

Was six guaranteed 404s (pointing at `/admin/topics/{v1-slug}`, a route that
never existed); the stopgap remapped them to real v2 topic slugs.

**Done when:** sourced from the `topic_protocols` table instead of a hardcoded
array. Blocked on protocols actually being generated for these topics.

---

## P1.5 — Site walkthrough, 2026-07-21 (reader & operator experience)

Paul used the live site and recorded feedback. Grouped by **root cause** rather
than by screen, because a dozen of the observations trace back to four causes —
each was traced into the code or the database, and the finding is recorded next
to the symptom so nobody re-derives it.

**Sequencing consequence, and it is the important one:** items A1–A4 below must
land *before* the full library build, for exactly the reason the groundedness
gate must. The build is a single budgeted run producing 100+ articles; if it
runs against the current prose rules and the current article schema, every one
of those articles is written in a voice Paul has rejected and a structure that
cannot hold a bullet list. Fixing it afterwards means regenerating the entire
library — paying the $400–600 twice.

### A. The reader-facing article (product-defining)

#### A1. Articles say "as the source said" — the prompt explicitly asks for it
Not a model quirk. `CLINICIAN_SECTION_PROMPT` (`lib/synthesis.ts:169`) instructs:
*"QUOTES: when a claim carries a verbatim quote, you MAY include it verbatim in
quotation marks **with attribution** when especially illustrative."*

This is the Phase 6 trust foundation behaving exactly as designed — verbatim
anchoring was built to make claims auditable. The conflict is that it was wired
into **reader-facing prose** rather than kept as backend provenance. A reader
should never have to wonder who "the source" is; the whole point of the
consolidation engine is that many sources became one coherent statement.

**Done when:** verbatim quotes are provenance only — visible in the Evidence
drill-down, never narrated in article prose. The `direct_quote` data stays; it
stops being quoted at the reader. Keep the reference markers `[R1]`, which are
citations to primary literature, not to our ingested sources — those are a
different thing and belong in a clinician article.

#### A2. Articles cannot be "broken up" — the data model has no way to express it
The blocker is structural, not stylistic. The article shape is
`Outline → Section → Paragraph { id, text, claim_ids }` (`lib/synthesis.ts:206`),
and `outlineToMarkdown` emits `## Title` followed by raw paragraph text. **There
is no representation for a bullet list, sub-heading, callout, table, key-takeaway
box, or image.** No amount of prompt tuning produces them, because the JSON
schema the model must return has nowhere to put them.

**Done when:** paragraphs become typed blocks (`prose | bullets | callout |
table | figure | key_takeaways`), the section prompts may emit them, and the
markdown renderer handles each. This also unblocks A4 (images) and varied
sentence structure, since the model is currently instructed to return a flat
list of prose paragraphs and is doing so faithfully.

#### A3. The patient article is a paragraph-for-paragraph mirror of the clinician one
`PATIENT_SECTION_PROMPT` (`lib/synthesis.ts:177`) translates **one clinician
section at a time** and is told to *"base it ENTIRELY on the provided section
text."* The generation loop (`lib/synthesis.ts:439`) walks the clinician sections
and emits one patient section per clinician section.

So the patient article structurally cannot differ from the clinician article: it
inherits the same section count, the same order, and the same paragraph count.
Paul wants it *engaging* — something a layperson keeps reading — and that is
unreachable while it is a translation layer rather than its own document.

**Done when:** the patient article gets its own outline pass over the claims —
free to re-order, merge, lead with what matters to a patient, and use the block
types from A2. Comparable in spirit to how the clinician outline is generated,
not derived from it.

#### A4. No image support anywhere
No field exists on `topic_articles`, in the `Outline` type, or in the renderer.
Paul plans to ingest images from existing articles and re-create them as needed.

**Done when:** a `figure` block type (A2) carries an image reference, alt text,
and a caption, with provenance for where the image came from and its licence.
**Licence provenance is not optional** — re-using images from ingested articles
in a product sold to physicians is a rights question, not just a technical one.

### B. Evidence looks duplicated — but dedup is working correctly

Paul saw "Longevity 101, segment 10, segment 11" under COPD looking identical.
**Checked against the live database.** Both segments are `claim_members` of a
*single* claim (`2991c6f3`), and their underlying statements are genuinely
different sentences ("COPD is largely preventable…" vs "COPD remains a major
cause of…"). Consolidation did its job.

Two real findings behind the appearance:

1. **`CHUNK_OVERLAP = 200` on `CHUNK_SIZE = 2400`** (`lib/extraction.ts:21`) means
   adjacent chunks share 200 characters, so a passage on a chunk boundary is
   extracted twice by design. That overlap exists to avoid losing
   boundary-spanning content, and consolidation is what cleans up after it. Working
   as intended.
2. **The Evidence panel renders `claim_members` — the raw, pre-dedup layer.** So
   the UI displays precisely the duplication the engine already resolved, which
   makes a working system look broken.

**Done when:** the Evidence drill-down groups members by claim and collapses
same-source segments, showing "Longevity 101 (2 segments)" expandable rather
than two near-identical rows. Presentational only — **do not "fix" the dedup,
there is nothing wrong with it.**

### C. Admin: jobs vs. run history are the same work at two altitudes

`jobs` is the **queue** (intended work, with checkpoints); `pipeline_runs` is the
**execution record** (attempts, including resumed and failed ones —
`lib/pipelineRuns.ts` documents why a run row can legitimately stay `running`
across ticks). `app/sources/[id]/page.tsx:193` renders them as two flat,
unlabelled lists, so the same processing appears twice with no stated relation.

The "three different jobs" on one source are separate *stages*
(`extract_source`, then downstream) of a single logical processing episode.
Nothing in the schema groups them, so nothing in the UI can.

**Done when:** one collapsible entry per processing episode, labelled with date
and time, with its stages nested underneath and their run attempts inside those;
sorted newest-first. Needs a grouping key — likely the run/checkpoint id already
threaded through `startOrResumeRun`. Explaining the two tables in the UI copy is
the cheap half; grouping is the half that actually answers the confusion.

### D. Insight metadata is unlabelled and unsortable

- **"Peripheral" and "Useful" are not evidence types — they are `importance`.**
  `components/SourceRawInsightsClient.tsx:48` maps `1 → Core, 2 → Useful,
  3 → Peripheral` and renders the badge next to `evidence_type` with no label,
  so it reads as a competing evidence taxonomy. The distinct axes are
  `evidence_type` (RCT/Cohort/Mechanistic/…), `importance`, `actionability`,
  `confidence`, and `insight_type`. **Done when:** each badge says what axis it
  is on.
- **Sorting was specced and typed but never built.** `InsightSortOption`
  (`importance | recency | evidence_strength | actionability`) and
  `InsightGroupOption` (`source | evidence_type | date | none`) exist in
  `lib/types.ts:235-236` and are imported by **nothing**. The vocabulary Paul is
  asking for is already designed; only the UI and query are missing.

#### D1. Insight → article traceability (Paul: "where is each insight used?")
**The data already exists.** Every article paragraph stores `claim_ids`
(`lib/synthesis.ts:206`), so the chain `raw_insight → claim_members → claim →
paragraph → article` is fully traversable today. This is a read-side feature, not
a pipeline change — considerably cheaper than it sounds.

**Done when:** an insight shows the articles and sections it landed in, linked;
ideally the reverse too (a paragraph reveals its supporting insights).

#### D2. Insight Review shows nothing until you search
`app/admin/insights/review/page.tsx:83` computes `hasSearchOrFilters` and skips
the query entirely when no search or filter is set — so the page reports "1,072
raw insights" and then lists none. The guard looks like it was meant to avoid
loading everything, but **the query is already paginated** (`PAGE_SIZE`, `.range(offset, …)`),
so it is guarding against a cost that isn't there.

**Done when:** the unfiltered first page renders by default.

#### D3. Per-source stats dropdown
Paul wants the stats card to break down by source: insights, claims, and
consolidation ratio each. The consolidation ratio is the interesting one — it is
the same number as the **per-source novelty %** in P3.5, viewed from the admin
side. Build them together; they share a query.

### E. Manual article editing — with a collision to resolve first
Paul wants to edit clinician/patient/protocol articles by hand while reading.

**The hard part is not the editor.** Articles are regenerated by `update_topic`
jobs and `stale_topics()`, and the read side renders `version desc limit 1` — so
a hand-edit is silently discarded the next time the topic goes stale. Any editor
must answer: does a manual edit pin the article against regeneration, merge with
it, or feed back as a corrected claim?

**Recommended:** edits become a new version marked `human`, and regeneration
preserves human-edited sections the way `updateTopicContent()` already preserves
untouched ones — the mechanism exists. **Done when:** an edit survives a
subsequent `update_topic` run. Test that explicitly; it is the whole risk.

### F. UI polish (small, independent, safe to batch)
- `app/admin/topics` — no vertical spacing under major headings.
- Back button from Topics → Sources, and from Insight Review → Sources, reads
  wrong. Use a plain **"Back to Sources"**.
- Card-shaped buttons (Sources, Topics on Insight Review) need a visible border /
  hover state so they read as clickable.

### G. Taxonomy navigation
Admin `/admin/topics` and the Medical Library present the same tree with no
stated difference, which is confusing. Paul wants **hovering "Medical Library"
to open a dropdown of the topic tree** so the scope of the library is visible
without drilling in.

Worth deciding deliberately: with 10 roots and ~130 topics, a hover menu must
show branches (and probably only two levels), not everything. Related to the
P3.6 item about thin branches being reader-visible — the nav is where a
17-claim branch is most conspicuous.

---

## P2 — Data & pipeline

### Transcript hygiene — strip ads / intros / outros before extraction (trust filter)
YouTube captions (and some pasted transcripts) carry cold-open hype clips,
**sponsor reads / ad breaks**, and subscribe/outro segments. Extraction cannot
distinguish a sponsor read ("brought to you by AG1, which supports gut health")
from a clinical statement, so an ad becomes an extracted **claim** and is
deduplicated into the one source of truth as if it were medical guidance — a
direct violation of principle 1 (the machine adds no substance; here the *source*
smuggles in non-substance). Raised by Paul 2026-07-22 re: future direct uploads.

**Done when:** every ingested transcript passes a hygiene pass (likely a cheap
Haiku call) that removes intro/outro/sponsor/ad spans before chunking —
conservative (when unsure, keep and surface, never silently delete). Applies to
all future uploads, not just YouTube. Build it with the timestamp work (both
touch ingestion). See `docs/v4-build-risks-and-cost.md` §D Phase 1.

### Timestamp capture — the YouTube timing is fetched, then discarded
`app/api/admin/sources/fetch-youtube-transcript/route.ts:109-111` receives each
caption segment as `{ text, start, duration }` and maps to `segment.text`,
throwing the timing away. So `raw_insights.start_ms` is null everywhere and the
one-click "jump to the moment in the video" deep-link has nothing behind it.
Getting timestamps is *stopping* a discard, not new integration.

**Done when:** timed segments are preserved → chunk `start_ms`/`end_ms` set →
`raw_insights.start_ms` set → Evidence citation deep-links `url + &t=<sec>`.
First proof on `youtube.com/watch?v=s-qapZuy0GY` (the one seed source that can get
timestamps — the other four are manual plain-text transcripts). See
`docs/v4-build-risks-and-cost.md` §D Phase 1 step 5.

### Verify the topic-merge fix against real data
`ebe3697` changed the `merge` action in `app/api/admin/topics/[id]/route.ts` to
drain claim links in batches and delete only the ids it just moved. Previously
a blanket `delete().eq("topic_id", id)` destroyed any link a concurrent
`tag_claims` job inserted mid-merge, silently dropping the claim's topic
assignment.

It was verified by type-check and build only — exercising it means running real
merges on production data.

**Done when:** a merge has been run with the worker active and claim counts
reconcile on both sides.

### ~~Reshape the taxonomy toward the curated top-level tree~~ — DONE 2026-07-22
Completed in `d0d4e83`..`89f4034`. The live tree is now 10 curated spine
branches with **zero** legacy roots, all 1,013 claims still tagged. The six
original headings were widened to ten because the corpus demanded it — most
of the library is reproductive/hormonal health and research methodology, which
had no home among the original six.

Three mechanisms now hold the line, in increasing order of reliability:
prompt (prefer existing topics) → code (`createChildTopic` requires a parent,
so no call site can mint a root) → database (unique index on
`(lower(name), parent)` for active topics, migration 008).

**Note still live:** `lib/levers.ts` pins lever cards to specific topic slugs.
If a lever's topic is archived or merged, that card silently disappears from
`/start`. Re-check the grid after any future reshaping.

### Reference resolution succeeds 5% of the time
`reference_mentions` holds 76 extracted citations. **72 are `not_found`; 4
resolved**, yielding 3 canonical rows in `references_` and 21 `claim_references`
links. Verified references are a headline trust feature for the physician
product — at this rate the References section is effectively empty, and the v3
evidence layer's whole point is unmet.

Extraction is working (76 mentions found across 6 sources); **resolution** is
where it fails. Likely causes, in order: podcast speech names studies loosely
("the Danish twin study"), so there is no title to match; query construction
against CrossRef/PubMed may not be falling back from title → author+year.

**Done when:** a spot-check of ten real mentions shows most resolving, or a
documented finding that conversational citations are inherently unresolvable —
in which case stop presenting resolution as a feature.

### No timestamped provenance — 0 of 1,072 insights
`raw_insights.start_ms` is populated on **zero** rows. You asked for this
directly: an insight should deep-link to its exact moment in the source video
so a manual review is one click. Nothing is captured.

This is retroactive-hostile: fixing it later means re-extracting every source.
**Do it before the next YouTube batch**, not after.

**Done when:** extraction records `start_ms`/`end_ms` from chunk timing, and a
topic-page citation links to `youtube.com/watch?v=…&t=…`.

### Source stuck in `processing` with no job
`d32c0fc8` ("Optimizing protein quantity, distribution, and quality", 16,186
chars) has `processing_status = 'processing'`, 0 raw insights, and no queued
job — its `extract_source` job was deleted at your request on 2026-07-22 so you
could reprocess manually. The status was never reset, so admin shows it as
permanently in-flight.

**Done when:** the source is either reprocessed or its status reset to
`pending`. Worth a general guard: a source in `processing` with no live job is
by definition stale.

### 5 `update_topic` jobs sitting queued
Queued 2026-07-22 10:39 by the taxonomy reshape — re-tagging claims made those
articles genuinely stale, so `stale_topics()` did its job. They are incremental
section patches, not full rebuilds, so the cost is small but non-zero and they
will run on the next worker tick.

Left queued deliberately rather than deleted: unlike the 51 stray
`generate_topic` jobs, these represent real work. **Decide** whether to let them
run.

### `claims.topic_fit` is not discriminating
Added in migration 007 to flag placements the tagger wasn't confident about, so
a human could review approximate filings. In the first real run all 77 claims
came back `good` — zero `approximate`, zero `unfiled`. The value is the model's
own self-report, and it does not currently separate a confident placement from
a resigned one, so it cannot be trusted to surface bad filings.

**Done when:** the signal is grounded in something measurable — e.g. derive it
from the ANN similarity to the chosen topic rather than asking the model — and
a spot-check shows `approximate` actually correlating with weak placements.

### `discover_topics` splits rather than consolidates
The stage samples claims **one existing topic at a time** and asks what finer
topics live inside. Two consequences: every proposal is a split (a dry run
produced 63 new topics against a 133-topic tree), and cross-cutting themes are
structurally invisible — supplement claims sat 1–2 apiece across eleven topics,
so no single batch ever saw enough of them to cluster. It never proposed
"Supplements" for exactly this reason.

Less urgent now that the spine constrains where anything can land, and that
`placeTopic` routes new roots to the approval queue rather than creating them.

**Reconciled 2026-07-22 against the Attia crawl (see spec §4):** the target
taxonomy is now known to be *bounded and curated* — ~40–60 leaf topics matching
Attia's own site structure, which the spine already mirrors. So topic
*discovery* is no longer a growth engine; it is at most an occasional
"did we miss a cross-cutting theme like Supplements?" audit. The real scale
pressure moved **inside** the topic: ~300–600 claims per leaf, which is a
sectioning-and-synthesis problem (spec §5), not a discovery problem. Downgrade
accordingly — this is a periodic audit, not a pipeline stage that runs on every
ingest.

**Done when:** clustering runs corpus-wide over `claims.embedding`, ignoring
current topic membership, so thin cross-cutting themes surface — run as a manual
audit, not automatically. Costs no new embedding spend — every claim is already
embedded; only creating a topic embeds anything new.

### Taxonomy maintenance job (task #8)
A scheduled pass that proposes split / merge / re-parent moves from claim
centroids, so the tree self-corrects as the corpus grows instead of drifting
until someone notices. Also the natural owner of periodic count reconciliation
(`recomputeTopicCounts` currently full-scans every topic).

Deliberately **deferred, not dropped.** The spine plus the three-layer root
guard now hold the shape by construction, so drift is slow; and with 10 curated
roots and ~1,000 claims there is not yet enough signal for centroid moves to
beat human judgement. Revisit once the corpus is several times larger.

### `topic_protocols` generation
Most topics have no generated protocol yet (all zero as of the cleanup). Gates
the P1 protocols-strip item above.

---

## P3 — Specced; partly built

The "agreed, not yet built" labels on the `ARCHITECTURE.md` v3.1/v3.2 sections
are **stale** — the mechanics of both shipped on 2026-07-21/22. What is missing
is not the machinery but the *product promises* layered on top. Corrected here
because the old wording would send the next person to rebuild working code.

**Built** (verify in `lib/synthesis.ts`, `lib/worker.ts`):

- v3 evidence layer — `references_`, `reference_mentions`, `claim_references`
  exist and are populated; `direct_quote` is set on **all 1,072** raw insights.
- v3.1 core — claim cap removed (`CLINICIAN_CLAIM_CAP = 2000`), sectioned
  generation, coverage gate + mop-up, `coverage_score`, groundedness scoring.
- v3.2 core — `updateTopicContent()` with its three tiers and
  `FULL_REGEN_THRESHOLD = 0.25`, wired through `stale_topics()` →
  `update_topic` jobs (migration 005.2). One has already run successfully.

**Not built — these are the B2B promises, and each is separately listed below:**
per-source novelty %, consensus/contested labelling, timestamped provenance,
contradiction review queue, topic-split flow, "what's new since last visit",
and the Batch API discount path.

---

## P3.5 — The B2B promises (agreed in conversation, nothing built)

These are what makes the library sellable rather than merely large. Each was
agreed explicitly; none exists in code.

### Per-source novelty ("N% of this source was new")
The core differentiator. The pitch is that a clinician never re-reads overlap:
ingest a source, and the system reports how much of it was genuinely new versus
already known. Every input exists — consolidation already decides SAME vs
DIFFERENT per raw insight — so this is a matter of recording and surfacing the
ratio per source, not new inference.

**Done when:** a source page shows "N% new" and the claims contributed.

### Consensus vs contested labelling
Agreed: **classify automatically, Paul overrides contested calls.** Contested
material must read as "thought for discussion", never as settled fact. Today
this exists only as a line in the synthesis prompt
(`lib/synthesis.ts:169`) asking the model to hedge — there is no structured
field, so nothing can be filtered, badged, or overridden.

**Done when:** claims carry a consensus state, articles render it visibly, and
an admin control flips a contested call.

### Contradiction review queue
`CONTRADICTS` was specced as a human-confirmed verdict. When a new source
disputes an existing claim, that must surface for a decision rather than being
silently merged or duplicated.

### Topic split flow
A topic that grows too broad should be splittable with its claims redistributed
and its article re-sectioned. Specced in v3.2, not built. Related to the
`discover_topics` item above, which currently only ever splits.

### "What's new since last visit"
The living-document delta. Readers who return should see what changed rather
than re-reading. `topic_articles` is already versioned per section, which is the
hard prerequisite.

### Batch API path (50% discount)
For the one budgeted full build. Ranked first among cost levers in
`ARCHITECTURE.md` "Cost model".

### Article-profile registry (task #10 / Phase 7)
Today's clinician / patient / protocol variants are hardcoded. Specced as a
**code registry**, not a table: `{ key, audience, depth, claim_cap, prompt,
requires_quotes, requires_references }`, with a `profile` column on
`topic_articles`. Adding a depth level — a CME monograph, a patient handout —
then costs one registry entry rather than a schema change.

Lower priority than it looks: one profile done well beats three done thinly,
and the clinician profile is the product.

### Computed evidence grading (task #10 / Phase 7)
A derived grade per claim from evidence_type + confidence + source_count +
best-reference tier + recency, surfaced in Evidence and in articles.
**Depends on reference resolution working** — the best-reference-tier input is
currently near-empty (4 resolved of 76), so building this now would grade
almost everything on missing data.

### Physician Q&A (task #11 / Phase 8)
RAG over claims + verified references. Last in the sequence deliberately: it
inherits every trust property of the layers under it, so it is only as
trustworthy as the groundedness gate and reference resolution make it.

---

## P3.6 — Corpus strategy

### The library is lopsided, and it is an ingestion artefact
As of 2026-07-22, 5 processed sources produced 1,072 raw insights → 1,013
claims. Two sources (Attia #351 male fertility, #374 testosterone) account for
**594 insights — 55% of everything**. Hence Sexual & Reproductive Health holds
426 claims against Exercise's 51, Sleep's 24 and Medications & Supplements' 17.

The skew is *not* a taxonomy problem and needs no correction: it is exactly what
five sources should look like. It matters only for sequencing — a full library
build now would produce one deep branch and several hollow ones.

**Recommendation:** ingest a few Exercise / Sleep / Nutrition sources *before*
the single budgeted full build, so that build produces a balanced product.

### Thin branches are reader-visible
Medications & Supplements (17 claims) and Sleep (24) render as full branches
alongside Sexual & Reproductive Health (426). To a physician evaluating the
product, a near-empty branch reads as abandoned rather than early.

**Done when:** the reader tree hides or de-emphasises branches under a claim
threshold. Display-only; the taxonomy itself is correct.

### Keep spine branch names specific
Not a task — a rule to hold to. `tag_claims` pulls candidate topics by embedding
similarity (`match_topics`, `TOPIC_MATCH_THRESHOLD = 0.28`) and hands the names
to the LLM as hints. A topic competes for claims **whether or not it has any**,
so declaring branches early is cheap and safe, but a broad, vague name
("Health Optimization", "Wellness") will siphon claims from every direction.
Narrow empty branches are harmless; vague ones are not.

This is why `Risks › Hormones` had to be collapsed into
`Sexual & Reproductive Health › Endocrinology` — two plausible homes guaranteed
inconsistent filing.

### The full library build has not been run
The taxonomy is now settled (10 curated roots, 0 legacy), which was the
precondition. Nothing triggers it automatically — `stale_topics()` deliberately
returns only topics that *already* have an article, so an ingest can never kick
off a library-wide build.

**Cost, corrected 2026-07-22 (spec §4).** The ~$1/topic, ~$400–600 figure was
for today's 133 topics on the *current* synthesis. At target scale (~200
podcasts, ~20k claims, ~40–60 dense leaf topics) the full build is more like
**$2,000–5,000**, and the Batch API discount (P3.5) stops being optional. But
**do not run the full build before the v4 rewrite ships** — building on the
current padding-prone synthesis produces $2–5k of articles that must then be
regenerated. Sequence is: v4 rewrite (spec) → ingest breadth → one budgeted
build. This supersedes any earlier "$400–600" figure in this file.

---

## P4 — Documentation

### ~~`ARCHITECTURE.md` status was stale~~ — DONE 2026-07-22
Three separate stale labels, not one: line 3 claimed *"v2 rebuild in progress
(branch `v2-rebuild`)"*, and the **v3.1 and v3.2 section headers both read
"(agreed, not yet built)"** for machinery that shipped 2026-07-21. Since
`CLAUDE.md` designates this file as authoritative, those headers would have sent
the next reader to rebuild working code — the same error this file's P3 section
was written to correct.

All three now state shipped status and point here for outstanding work.

### `docs/archive/` is intentionally stale
v1 documentation kept for history. Not a to-do — listed so nobody "fixes" it.
`docs/archive/ARCHITECTURE-REPORT.md` still describes deleted components.

---

## P5 — Code hygiene

### 15 lint warnings (0 errors)
All pre-existing, all unused vars/imports except one hook-dependency warning.

| File | Warnings |
|---|---|
| `app/admin/sources/new/page.tsx` | `useEffect`, `isValidYouTubeUrl`, `data` unused |
| `lib/fileExtraction.ts` | `importError`, `error` unused (swallowed catches) |
| `components/TranscriptEditor.tsx` | `CardDescription`, `sourceId` unused |
| `app/admin/sources/page.tsx` | `CardHeader`, `CardTitle` unused |
| `components/WhatMattersMost.tsx` | `highlightedLevers` unused — see below |
| `components/TopicsAuditClient.tsx` | `byId` unused |
| `components/SourceEditorClient.tsx` | `useState` unused |
| `components/membership/PaidFeatureGate.tsx` | `MembershipTier` unused |
| `app/api/admin/sources/fetch-youtube-transcript/route.ts` | `e` unused |
| `components/InsightReviewFilters.tsx` | `useEffect` missing dep `searchQuery` |

Two are worth more than a lint pass:

- **`WhatMattersMost` ignores `highlightedLevers`.** The prop is declared,
  documented, and passed from `app/start/page.tsx`, but never read in the
  component body. The intended visual feedback on the priority selector was
  never wired up. `LeverGrid` does use it, so the feature half-works.
- **`lib/fileExtraction.ts` swallows two caught errors** without logging, which
  can hide ingestion failures.

### Membership is stubbed
`lib/membership.ts` has two TODOs standing in for database lookups until auth
exists. Expected, not rot.

### `eslint.config.*` doesn't scope out nested worktrees
Its `ignores` list (`.next/**`, `node_modules/**`, `dist/**`, `coverage/**`,
`src/**`) only matches those directories at the top level. Claude Code worktrees
live inside the repo at `.claude/worktrees/<name>/` — a full nested checkout,
each with its own `.next`, and potentially its own `dist/`/`src/`. None of the
current patterns match a `.next` (or `dist`, `src`) three levels down, so
`npm run lint` run from the real repo root while any such worktree exists
sweeps up that worktree's build output and duplicate source tree as if it were
part of the project.

Hit this directly merging `claude/stoic-blackburn-91d7db` into `main`
(2026-07-22): `npm run lint` from the repo root reported 24,599 problems.
Excluding `.claude/**` brought it back to the true baseline (0 errors, 15
warnings, matching a lint run from inside the worktree itself). Not a real
regression — a scope gap that will misfire the same way for anyone who lints
from the repo root while a worktree is present.

**Done when:** `ignores` in `eslint.config.*` excludes `.claude/**` (or uses
`**/.next/**`, `**/dist/**`, `**/src/**` so nested copies at any depth are
caught, not just top-level).

---

## Verified — do not re-investigate

Recorded to save the next person the trip:

- **There are no duplicate active topics *now* — but `medications-supplements-2`
  and `risks-2` were a real bug, not transient noise.** Two concurrent
  `seedSpine` runs each read the topic list before either had written, both
  found no `Risks`, and both created it — splitting the spine in half across
  duplicate roots. They were merged by hand (children re-parented onto the
  survivor, then deleted); they held no claims or articles, so nothing was lost.

  The cause is structural: the seeder reads once and inserts what's missing, and
  slug collisions resolve by appending `-2`, so concurrent duplicate inserts
  *succeed silently*. No application-level find-or-create can close that window.
  Migration 008 adds a unique index on `(lower(name), parent)` for active
  topics, turning it into a loud unique violation.

  Unrelated: the remaining `-2` slugs (`reproductive-biology-2`,
  `child-development-2`) are the *live* topics — their same-named predecessors
  are correctly `archived` with `merged_into_id` set. Slugs are frozen and never
  reused, so `-2` there is normal collision handling.
- **Duplicate `topic_articles` rows per topic are versions, not a bug.**
  Testosterone, Male Fertility Assessment, Protein Intake, Functional Aging and
  Longevity Definitions each have two clinician rows. `app/topics/[slug]/page.tsx`
  selects `order("version", desc).limit(1)`, so the newest always renders and the
  older row is retained history. Checked because a 5,385-char and a 46,001-char
  Testosterone article coexist — the long one is what readers get.
- **`seedSpine` reads only ACTIVE topics, so an archived branch left in its
  `SPINE` list is silently recreated.** This is how a collapsed branch comes
  back from the dead. When retiring a branch, remove it from `scripts/seedSpine.ts`
  *and* archive the row — either alone is insufficient. Learned collapsing
  `Risks › Hormones`.
- **The `references` table is named `references_`** (trailing underscore) —
  `references` is a SQL reserved word. Queries against `references` fail with a
  syntax error that looks like a missing table.
- **Two migrations both numbered 005.** The later by commit order is now
  `005.2_update_topic_job_and_stale_topics.sql`. Both are applied; naming only.
- **`components/SourceEditor.tsx` and `components/TranscriptEditor.tsx` are
  live**, not orphans. They
  are the presentational halves behind `SourceEditorClient` /
  `TranscriptEditorClient`, rendered by `app/sources/[id]/page.tsx`. An import
  scan that only matched single-quoted relative imports missed this.
- **No code references any dropped v1 table.** `insights`, `insight_sources`,
  `insight_concepts`, `concepts`, `concept_connections`, `concept_parents`,
  `source_processing_runs` — all clear as of `ebe3697`.
- **`openai` is imported only by `lib/embeddings.ts`**, matching the claim in
  `CLAUDE.md`. The inert v1 OpenAI cluster (`autotag`, `conceptDiscovery`,
  `pipeline`, `topicNarrative`, `topicProtocols`) is **already deleted** — `lib/`
  holds 18 modules and none of them is one of these. An earlier note listing
  this as pending work was stale.
- **The scale-durability refactor shipped.** Migration `003_evidence_layer.sql`
  creates HNSW (`vector_cosine_ops`) indexes on `claims`, `topics` and
  `references_`, superseding the baseline ivfflat `lists = 100` index that would
  have degraded past ~100k rows. The `topic_claims` RPC replaced the unbounded
  `IN (...)` of claim ids. Both were open cliffs in the v3 plan; neither needs
  re-doing.
