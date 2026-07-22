# Knowledge Engine v2 — Architecture

**Status:** v2 rebuild in progress (branch `v2-rebuild`, started July 2026).
Supersedes the archived v1 reports in `docs/archive/`.

## Purpose

Take many sources (podcasts, books, videos, articles), break their content
into atomic knowledge units, deduplicate them semantically, and weave them
together inside one preserved framework: a stable, AI-managed topic taxonomy
where every generated paragraph traces back to its sources.

## Data model (layered; each layer re-derivable from the one above)

```
sources          metadata + full transcript (immutable original)
  └─ chunks          segments with locator (+ timestamps when known)
       └─ raw_insights   immutable per-chunk extraction records
            └─ claims        canonical deduplicated knowledge units
                 ├─ claim_members   claim ← raw insights (multi-source evidence)
                 ├─ claim_topics → topics   hierarchical AI-managed taxonomy
                 └─ topic_articles / topic_protocols   cite claim_ids per paragraph
```

Principles:

- **Raw insights are immutable.** Extraction output is never edited or merged
  in place. Re-extraction creates a new `pipeline_runs` row and new records.
- **Claims are the public atom.** Deduplication = attaching raw insights to
  claims via `claim_members`. Wrong merges are reversible because members can
  be detached; consolidation can be re-run as models improve.
- **Provenance is a chain, not a field:** article paragraph → `claim_ids` →
  `claim_members` → `raw_insights.locator` → source (+ timestamp).
- **Topics are AI-managed but human-audited.** The AI creates/assigns topics;
  the admin audit UI can rename, re-parent, merge, archive
  (`topics.reviewed_by_human` tracks audit state).

## Processing pipeline

Every stage is a job in the Postgres `jobs` table — idempotent, checkpointed
in `jobs.progress`, resumable after a killed invocation. Workers claim jobs
atomically via the `claim_next_job()` RPC (`FOR UPDATE SKIP LOCKED`; stale
running jobs with old `locked_at` heartbeats get reclaimed).

| Stage | Job type | What it does |
|---|---|---|
| Ingest | — (API route) | Create source + transcript (paste / YouTube / file), enqueue extract |
| Extract | `extract_source` | Chunk transcript, per-chunk LLM extraction → `raw_insights` + embeddings (batched, inline). Checkpoint = chunk index |
| Consolidate | `consolidate_source` | Per raw insight: ANN over `claims.embedding` (`match_claims` RPC) → LLM adjudication SAME/DIFFERENT/UNSURE → attach member, create claim, or create provisionally + queue `merge_reviews` |
| Sweep | `claim_sweep` | Periodic claim-vs-claim ANN pass to catch accumulated near-duplicates |
| Tag | `tag_claims` | Assign claims to topics (ANN over `topics.embedding` + LLM multi-label) |
| Discover | `discover_topics` | Review unfiled claims + over-broad topics, propose new topics with parent placement, flag affected claims `needs_tagging` and hand back to Tag |
| Synthesize | `generate_topic` | Prioritized claims → clinician article + protocol (per-paragraph `claim_ids`), patient article translated from clinician version |

Worker: `app/api/worker/tick` — invoked by Vercel cron (see `vercel.json`),
by a fire-and-forget ping after enqueue, or manually from the admin UI.
It works within a ~250s budget and exits; checkpoints make that safe.

### Model providers

All generative calls go through `lib/llm.ts` (`claudeJson`). Stages never talk
to a provider SDK directly. Two tiers:

| Tier | Model | Used by |
|---|---|---|
| Bulk | `claude-haiku-4-5` | `extract_source`, reference-mention extraction — one call per transcript chunk |
| Judgment | `claude-opus-4-8` | dedup adjudication, topic assignment/discovery, reference matching, `generate_topic` |

**Embeddings are the one exception and stay on OpenAI**
(`text-embedding-3-small`, 1536-d, `lib/embeddings.ts`). Anthropic ships no
embeddings model, and both `match_claims` (dedup) and `match_topics` (tagging)
are pgvector ANN searches — without them consolidation degenerates from a
~10-candidate shortlist per insight into a full-corpus comparison. Changing
embedding provider means re-embedding every `raw_insights`, `claims`, and
`topics` row, and a migration if the new model isn't 1536-dimensional.

`LLM_BACKEND` selects how Claude is reached:

- `api` (default) — `ANTHROPIC_API_KEY`. What the deployed worker uses.
- `claude-code` — shells out to the local `claude` CLI, billing a Claude
  subscription rather than API credits. This is the default in
  `npm run pipeline`, so a developer can drive extraction, consolidation, and
  tagging locally without spending API credit. Embeddings still need
  `OPENAI_API_KEY` in this mode.

### Human-curated taxonomy

`discover_topics` only *creates* topics; it never assigns claims. It flags the
claims it touched `needs_tagging` and enqueues `tag_claims`, so placement stays
in one code path. Because the topic tree is curated, the stage supports a
dry run — `npm run pipeline -- discover --dry-run` prints what it would create
and writes nothing.

### `pipeline_runs` lifecycle

`pipeline_runs` is the human-readable history behind the jobs queue, and every
row must reach a terminal state exactly once. Stages go through
`lib/pipelineRuns.ts` (`startOrResumeRun` / `finishRun` / `failRun`) rather than
writing the table directly, which enforces two rules:

- **A resumed stage reuses its run.** The run id rides in the stage's
  checkpoint, so a stage that yields on its time budget and resumes on the next
  tick continues the same row. Opening a fresh run per invocation abandons the
  previous one (tagging used to leak a row every ~4 minutes this way).
- **A throwing stage closes its run.** Each stage catches, calls `failRun`, and
  rethrows so the job's own retry/backoff still applies. Without this, any
  provider outage leaves rows stuck in `running` forever.

A budget yield is deliberately *not* terminal — the row stays `running` because
the work genuinely is still in flight.

### Deployment / cron cadence (Vercel plan constraint)

The project currently runs on the Vercel **Hobby** plan, which caps cron jobs at
**once per day** and function `maxDuration` at 60s. The worker cron is therefore
set to `0 8 * * *` (daily). This is safe because prompt processing does **not**
depend on the cron: the fire-and-forget `pingWorker` after each enqueue
(`app/api/admin/sources/route.ts`) starts work within seconds, and the admin
"Run worker now" button triggers it on demand. The daily cron is only a
safety-net sweep for jobs that stalled (a tick that yielded on its budget, or a
ping that didn't land).

**When we upgrade to Vercel Pro** (unblocks sub-daily crons + 300s `maxDuration`,
which `app/api/worker/tick/route.ts` already assumes):

- Restore the worker cron to **every 15 minutes** — `*/15 * * * *` — **not**
  every minute. Per-minute (`* * * * *`) was the original Phase 1 setting; 15 min
  is plenty given the enqueue ping already handles real-time starts, and it keeps
  invocation volume/cost sane.
- No code change needed for `maxDuration`; it's already 300 in the tick route and
  only takes effect on Pro.

### Consolidation thresholds

- ANN similarity floor for candidates: **0.80** (below → automatic new claim).
- Adjudicator (gpt-5-mini) verdict SAME with confidence ≥ **0.85** → auto-attach.
- UNSURE / low-confidence SAME → create claim provisionally + `merge_reviews`
  row. Accept in the review UI collapses the two claims; reject keeps both.
  Nothing blocks the pipeline on human review.

## Taxonomy durability & maintenance

The taxonomy must stay coherent from 6 sources to thousands over months/years.
The governing principle: **incremental by default, scheduled maintenance for
structure, full re-derivation almost never.** Regenerating the whole taxonomy
per source is rejected — it destroys human curation, drifts non-deterministically
(breaking URLs and article citations), and re-does O(all claims) of work that
didn't change.

### Three cadences

1. **Per-source (continuous, automatic)** — `tag_claims` assigns new claims into
   the *existing* taxonomy (ANN hints + LLM), minting a new topic only when a
   claim fits nothing. Append-mostly, O(new claims), so the core never moves.
   This is the default and is implemented today.
2. **Scheduled maintenance (periodic; the `taxonomy_maintenance` job — planned)**
   — evaluates the tree and emits *proposals* (split an oversized/multi-modal
   topic, merge near-duplicates, re-parent a drifted topic, re-home stranded
   claims). Most decisions are cheap vector math on **topic centroid embeddings**
   (mean of member-claim embeddings), not LLM scans; the LLM only names new
   splits and adjudicates borderline merges. Safe proposals on unreviewed AI
   topics auto-apply; everything else routes to the merge-review queue.
3. **Full re-derivation** — rare, deliberate, never automatic; done as a
   migration with an old→new topic mapping so URLs redirect and content re-homes.

### Durability invariants

- **Frozen slugs.** A topic's `slug` is assigned once at creation; rename changes
  only the display `name` (and re-embeds for matching). URLs and generated-article
  references depend on the slug, so it never changes. Enforced in
  `lib/taxonomy.ts` (creation) and `app/api/admin/topics/[id]` (rename).
- **Merge/archive, never delete.** A merged topic is archived with
  `merged_into_id` pointing at the survivor, so old slugs 301-redirect instead of
  404 (the public read side resolves the chain). Claims and children move to the
  survivor.
- **Human-reviewed topics are pinned.** Once `reviewed_by_human` is set,
  automated maintenance may *propose* changes but never applies them silently —
  they go to the review queue. Automation moves freely only on unreviewed AI
  leaves. This keeps the curated spine stable while the edges stay fluid.

### Generated content is decoupled

Article/protocol regeneration is separate from taxonomy maintenance: each carries
`claims_snapshot_at`, and a scheduled sweep regenerates only topics whose claim
set changed materially (lazy, per-topic) — the tree reshuffling does not trigger
a mass regen.

### Name-embedding vs centroid (planned)

`topics.embedding` today embeds the topic *name* (good for matching a claim's
meaning to a topic). Structural maintenance instead needs a **centroid** = what
the topic has *become* (mean of its claims). Cadence 2 adds a separate centroid
column; the name-embedding stays for tagging.

## v3 evidence layer + scale invariants

To support training physicians (verbatim evidence + primary literature), v3 adds
two trust primitives and hardens the system against volume.

**Trust primitives**
- **Verbatim quotes**: `raw_insights.direct_quote` (+ char offsets into the chunk)
  captured at extraction — the exact source words behind each claim.
- **Verified references**: sources' third-party citations are extracted
  (`reference_mentions`, immutable/raw) then resolved against CrossRef/PubMed into
  canonical, deduped `references_`. Resolution is conservative by design: a
  minimum-specificity gate + strict title/year match + an **LLM verification gate**
  ("is this candidate actually the work the speaker meant?"). Vague or
  unverifiable mentions are marked `not_found` and **never surfaced** — a wrong
  citation is worse than none. `claim_references` links verified works to claims.

**Article views** are distinct surfaces: the **patient** article is plain and
reference-free; the **clinician** article carries inline `[R#]` citations and a
**deterministically-appended** References section built from verified data (the
model places markers but never authors citations, so it cannot invent one).

**Scale invariants** (must hold as content grows):
- Vector search uses **HNSW** (claims/topics/references) — accurate into the
  millions; ivfflat retired.
- No code path builds an `IN(...)` from an unbounded id list. Topic claim
  retrieval goes through the **`topic_claims()` / `topic_claim_count()` RPCs**
  (recursive subtree CTE + scoring + `LIMIT` in SQL). Synthesis and the Evidence
  tab both use it.
- External resolution (CrossRef/PubMed) is **throttled + cached + deduped**, never
  inline; a work cited many times resolves once.
- Reference dedup and (future) claim relations are **ANN-bounded + incremental**,
  never O(n²).
- All long-running work stays in the `jobs` queue with checkpoints.

New job types: `extract_references`, `resolve_references` (+ `compute_relations`
reserved for Phase 8). `extract_source` fans out to both consolidation and
reference extraction.

## v3.1 target spec — physician-grade comprehensiveness (agreed, not yet built)

The product goal: a **B2B knowledge product sold to lifestyle-medicine
physicians**. Clinicians rely on it, so it must be detailed, trustworthy, and
never silently lossy. The following is the canonical target agreed with Paul
(July 2026); it extends — does not replace — the v3 evidence layer above.

### Comprehensiveness — no caps

- **Remove `MAX_CLAIMS = 250`** in `lib/synthesis.ts`. The clinician view is an
  **exhaustive, claim-complete reference**: every deduplicated claim on a topic
  appears, rewritten into the project's common prose (complete in substance, not
  a verbatim transcript), organized by sub-theme, each carrying its verbatim
  quote + verified reference. No source cap either — if a topic draws on 12
  sources, all 12 are represented.
- The first source on a topic is ~all-new, so its article is near-complete
  coverage of what it said; later sources contribute only their *novel* claims.
- **Generate section-by-section** (one sub-theme cluster of claims per LLM pass),
  then assemble — so "no cap" scales past what a single call can hold instead of
  quietly truncating. A **coverage gate** verifies every input claim made it into
  the article (target 100%; flag any drop). The patient view is the plain-language
  translation of the same complete body.

### Novelty & corroboration (the core value made visible)

- Dedup already attaches an overlapping insight as another evidence member of an
  existing claim (SAME) vs. minting a new claim (DIFFERENT). Surface, **per new
  source, the novelty split** ("41 new claims — 23% novel; the rest reinforced
  existing knowledge"). This is the thing traditional media can't do: you never
  re-consume overlap.
- Surface `claims.source_count` (already computed) so heavily-corroborated claims
  are recognized as well-established.

### Consensus / contested labeling — auto, with human override

- Every claim gets a consensus dimension (**established / emerging-single-opinion
  / contested**), **derived automatically** from `sources.authority_tier` +
  multi-source agreement (`source_count`) + contradictions (`claim_relations`,
  Phase 8). Paul can **override contested calls** in the admin.
- Articles state established knowledge plainly and flag contested points as "for
  discussion" — heterodox/debate content is never silently asserted as settled.

### Timestamped provenance

- Capture **where in the source** each insight came from. YouTube/video: a real
  timestamp in `raw_insights.start_ms`, rendered as a **deep-link**
  (`source.url` + `&t=<seconds>`) for one-click manual review. Pure-text
  transcripts: an approximate locator (segment/char position). Verbatim quotes
  are already 100% captured; this adds the *location*. (As of this writing,
  `start_ms` is populated on 0 insights — net-new ingestion work.)

### Human claim review/edit

- Admin surface to review and edit claims directly (beyond the merge-review
  queue) — correct a bad rewrite, split/retag, adjust consensus.

## v3.2 incremental update model — section-level regen + living documents (agreed, not yet built)

Full-article regeneration on every new source is wrong on two counts: it is
expensive (a 6,000-word Opus rewrite to fold in one added claim), and it churns
prose physicians have already read and trust, making a revisited article feel
unstable. The update unit is therefore the **section**, not the whole article —
which the sectioned synthesis (v3.1) already makes natural, since the stored
`outline` is `sections[] → paragraphs[] → claim_ids`.

### Three update tiers (by what actually changed)

When consolidation + tagging finish for a new source, each affected topic is
classified by the strongest change it received:

1. **Reinforcing only** — every new insight was a SAME verdict (attached as
   evidence to an existing claim; no new claim). Prose does not change. Update
   **metadata only**: `source_count`, the representative quote, the evidence
   grade. No LLM prose call. ~$0.
2. **New claim in an existing theme** — regenerate **only the section(s)** whose
   claim set changed, claim-complete over the larger set. Every other section's
   stored prose is reused byte-for-byte; `body_markdown` is re-assembled from
   unchanged + regenerated sections. ~1/N of a full regen.
3. **New claim fits no section** — generate **one new section** and insert it.

Reinforcing-heavy sources (the common case as the corpus matures) cost ~$0; a
genuinely novel source costs one or a few section regenerations.

### Coherence valve (periodic full regen)

Sections are generated independently, so a patch cannot propagate a *reframing*
claim across the whole article, and many successive patches drift toward a
patchwork. Each topic therefore also carries a **full-regen trigger**: rebuild
the entire article when its claim set has grown past a threshold (e.g. >25%)
since the last full build, or every N incremental updates. Cheap section
patches for freshness; a periodic full rewrite for coherence. Per-section
versioning records which sections changed when.

### Propagation across article versions

A changed clinician section ripples minimally: the corresponding **patient**
section is re-translated (patient is already a per-section translation); the
**protocol** regenerates only if the new claim is actionable — a purely
mechanistic claim does not change "what to do."

### Living document (the feature this unlocks)

Because sections are stable and per-section versions are tracked, the read side
surfaces the delta — *"Evaluation section updated: 2 new findings since your
last visit"* — instead of silently rewriting the page. Reader trust plus a
premium B2B behavior; also the substrate for the Phase 8 changelog/diff.

### Contradiction — detected, then human-confirmed

The consolidation adjudicator gains a **CONTRADICTS** verdict alongside
SAME/DIFFERENT/UNSURE. A contradiction creates a new (opposing) claim + a
`claim_relations` row (`relation = contradicts`) and routes to a
**contradiction-review queue** (mirrors `merge_reviews`). Nothing is
auto-asserted — a human confirms genuine disagreement vs. context/nuance.
Confirmed contradictions surface both claims in that section's **"points of
debate"** treatment, clearly labeled contested (feeding the v3.1 consensus
dimension).

### Topic split (growth pressure-release)

When a topic grows too large or its claims form ≥2 distinct clusters (cheap to
detect on centroid embeddings), taxonomy maintenance **proposes a split**: the
LLM names the sub-topics; claims re-home to new children **under the same
curated parent**; the original slug 301-redirects (frozen-slug invariant); the
now-smaller topics regenerate. Structural, so **human-reviewed** (propose →
approve → apply), never silent. A source that floods a topic is a primary split
trigger — splitting and incremental update work together.

### Invariants

- **Article prose always uses the top model (Opus).** Cost levers (Haiku,
  batching, caching) apply only to mechanical steps (section grouping,
  groundedness audit, extraction, tagging) — never to clinician/patient prose.
  Quality is never traded for cost.
- **Reinforcing-only never triggers a prose regen** — only new claims, or the
  coherence valve, do.
- **Sections are the atomic, independently-versioned unit** of both storage and
  update.

## Models & the provider boundary

**Every generative call goes through Claude via `lib/llm.ts` (`claudeJson`).**
Verified across all five live stages — `extraction`, `consolidation`, `taxonomy`,
`references`, `synthesis`. The single exception is embeddings.

- **Embeddings — the only OpenAI dependency.** `text-embedding-3-small` (1536d,
  pgvector **HNSW** cosine) in `lib/embeddings.ts`. Anthropic ships no embeddings
  model, and `match_claims` / `match_topics` are vector searches, so this stays
  on OpenAI (Voyage is the alternative if we ever leave). Embeddings are ~$0.02/1M
  tokens — the whole corpus costs cents, so this is never the cost problem.
- **Judgment tier — Opus 4.8**: dedup adjudication, topic assignment, article
  generation. **Bulk tier — Haiku 4.5**: high-volume mechanical per-chunk work.
- **Reasoning depth is capped per call site** (`effort`). Adaptive thinking
  defaults to `high`, and thinking tokens bill as output ($25/M) — uncapped, most
  of a synthesis run's cost is invisible reasoning on mechanical work. Mechanical
  steps (section grouping, patient translation) run `low`; prose and the
  groundedness audit run `medium`. **We cap the reasoning, never the model** —
  article prose is always Opus.
- **Backends (`LLM_BACKEND`)**: `api` (ANTHROPIC_API_KEY, used by the deployed
  worker) or `claude-code` (shells to the local `claude` CLI, billing a Claude
  subscription instead of API credits). Both honor `effort`; the CLI takes
  `--effort`.

Legacy v1 modules (`autotag`, `conceptDiscovery`, `pipeline`, `topicNarrative`,
`topicProtocols`) still import OpenAI, but nothing live imports *them* — they
operate on the dropped `concepts` table and are inert pending deletion.

## Cost model (measured, July 2026)

Measured on real runs, so future decisions start from evidence rather than guesses.

- **A "topic" is ~30 model calls, not one** — section grouping + one call per
  section + one patient translation per section + protocol + groundedness. It
  produces ~13–15k words across three documents.
- **Measured: ~$1/topic** on the API at uncapped `high` effort. Five sample
  topics all hit coverage 1.00 at groundedness 0.91–0.96.
- **Ingestion is trivial**: ~$0.15/source. Synthesis dominates every estimate.
- **Scaling is sub-linear in sources.** Articles are per-*topic*, and dedup makes
  topic count plateau — 500 sources does not mean 500× the cost.

Levers, in order of impact (none of which touch prose quality):

1. **Batch API — 50% off.** Generation is not latency-sensitive; the bulk build
   is a perfect batch workload.
2. **Effort caps** (implemented) — kills the invisible thinking-token cost.
3. **Prompt caching** — ~30 calls/topic re-send the same system prompt.
4. **Incremental updates** (v3.2, implemented) — a new source patches only the
   sections it touched; reinforcing-only sources cost ~$0.
5. **Subscription backend** — flat-rate for spot/incremental work.

Full-library build lands ≈ **$400–600** with the levers stacked, vs ~$1,700 naive.

## Schema

Baseline: `supabase/migrations_v2/001_baseline.sql` (drops all derived v1
tables; `sources` + transcripts survive). v1 migrations in
`supabase/migrations/` are historical. Pre-reset JSON backup:
`backups/2026-07-18-pre-v2/` (local only, gitignored).

## Surfaces

- Admin (`/admin`): sources + job/run status, merge review queue, topics
  audit (tree edit), claims browser.
- Public: topic tree → topic page tabs (Patient / Clinician / Protocol /
  Evidence). Evidence lists claims paginated, expandable to member raw
  insights with source + locator. Semantic search over claims.

## Rebuild phases

0. Reset foundation (schema v2, dead-code removal, docs) ✅
1. Job runner + extraction (re-extract the 6 stored transcripts)
2. Consolidation + review queue
3. AI taxonomy + audit UI
4. Synthesis from claims
5. Public read side (tree, evidence provenance, search)
