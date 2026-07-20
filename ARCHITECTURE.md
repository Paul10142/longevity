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
| Discover | `discover_topics` | Cluster poorly-fitting claims, LLM proposes new topics with parent placement |
| Synthesize | `generate_topic` | Prioritized claims → clinician article + protocol (per-paragraph `claim_ids`), patient article translated from clinician version |

Worker: `app/api/worker/tick` — invoked by Vercel cron (see `vercel.json`),
by a fire-and-forget ping after enqueue, or manually from the admin UI.
It works within a ~250s budget and exits; checkpoints make that safe.

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

## Models

- Extraction + adjudication + tagging: `gpt-5-mini`
- Narrative/protocol synthesis: `gpt-5.1`
- Embeddings: `text-embedding-3-small` (1536d, pgvector ivfflat cosine)

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
