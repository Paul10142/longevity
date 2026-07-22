# Medical Library

The knowledge-engine half of LifestyleAcademy: Next.js 16 (App Router) +
Supabase (Postgres/pgvector) + Claude.

This file covers setup and orientation. **`ARCHITECTURE.md` is the
authoritative description of the data model and pipeline** — read it before
touching pipeline code. `docs/archive/` holds stale v1 documentation kept for
history; do not treat it as current.

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set up environment variables** in `.env.local`:

   - `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — publishable key (`sb_publishable_...`)
   - `SUPABASE_SECRET_KEY` — secret key (`sb_secret_...`, server-only)
   - `ANTHROPIC_API_KEY` — Claude, used for every generative call
   - `OPENAI_API_KEY` — embeddings only (see Model providers below)
   - `YOUTUBE_TRANSCRIPT_API_TOKEN` — YouTube transcript ingestion

   **Note:** Supabase updated their API key system in 2025. Use the
   `sb_publishable_...` / `sb_secret_...` formats. Legacy JWT keys (`eyJ...`)
   still work but are deprecated in late 2026.

3. **Database schema:**
   Migrations live in `supabase/migrations_v2/` as numbered SQL files, applied
   by hand via the Supabase SQL Editor — there is no local CLI or psql access.
   The v2 baseline dropped the entire v1 insight/concept schema; `sources`
   (including transcripts) was preserved and everything else is re-derived.

   The layered model, each level re-derivable from the one above:

   ```
   sources          metadata + full transcript (immutable original)
     └─ chunks          segments with locator (+ timestamps when known)
          └─ raw_insights   immutable per-chunk extraction records
               └─ claims        canonical deduplicated knowledge units
                    ├─ claim_members   claim ← raw insights
                    ├─ claim_topics → topics   AI-managed taxonomy
                    └─ topic_articles / topic_protocols
   ```

4. **Run the development server:**
   ```bash
   npm run dev
   ```

## Routes

### Admin
- `/admin` — index
- `/admin/sources`, `/admin/sources/new` — ingest and manage sources
- `/admin/insights/review` — browse raw extractions
- `/admin/reviews` — resolve borderline duplicate claims
- `/admin/topics` — audit and edit the taxonomy

### Public
- `/medical-library` — entry point
- `/topics`, `/topics/[slug]` — generated articles and protocols
- `/sources/[id]` — a source, its transcript, and its extractions
- `/search` — semantic search over claims

## How it works

1. **Ingest.** Create a source at `/admin/sources/new` (paste a transcript,
   pull a YouTube transcript, or upload a file). This stores the source and
   enqueues an `extract_source` job.

2. **Process.** Every stage runs as a job in the Postgres `jobs` table —
   idempotent, checkpointed in `jobs.progress`, and resumable. Extraction
   chunks the transcript and writes immutable `raw_insights`; consolidation
   deduplicates them into `claims`; tagging and discovery maintain the topic
   taxonomy; synthesis generates per-topic articles and protocols with
   `claim_ids` cited per paragraph.

   Long-running work never happens inline in a request handler. The worker is
   `app/api/worker/tick`, driven by Vercel cron, a fire-and-forget ping after
   enqueue, or the admin UI. See `ARCHITECTURE.md` for the full stage table.

3. **Read.** Articles cite claims, claims resolve to raw insights, and raw
   insights carry a locator back to the source segment and timestamp, so every
   generated sentence traces to its origin.

Run the pipeline locally with:

```bash
npm run pipeline -- status
```

Other subcommands: `work`, `discover [--dry-run]`, `sweep`,
`extract <source_id>`. This defaults to `LLM_BACKEND=claude-code`, which bills
your Claude subscription through the local `claude` CLI instead of API credits.

## Architecture notes

- **Supabase client:** `lib/supabaseClient.ts` — client-side, publishable key,
  respects RLS. Never import the server client into a client component.
- **Supabase server:** `lib/supabaseServer.ts` — server-side, secret key,
  bypasses RLS.
- **Model providers:** every generative call goes through `lib/llm.ts`; never
  call a provider SDK directly from a pipeline stage. `lib/embeddings.ts` is
  the only module that imports the `openai` package — Anthropic ships no
  embeddings model, and `match_claims` / `match_topics` are vector searches.
- **Types** for all v2 tables live in `lib/types.ts`. Legacy v1 types below the
  marker in that file are being phased out; don't build new code on them.
- **UI:** Tailwind + shadcn/ui in `components/ui/`.
