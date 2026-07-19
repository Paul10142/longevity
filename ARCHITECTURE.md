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

### Consolidation thresholds

- ANN similarity floor for candidates: **0.80** (below → automatic new claim).
- Adjudicator (gpt-5-mini) verdict SAME with confidence ≥ **0.85** → auto-attach.
- UNSURE / low-confidence SAME → create claim provisionally + `merge_reviews`
  row. Accept in the review UI collapses the two claims; reject keeps both.
  Nothing blocks the pipeline on human review.

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
