# Lifestyle Academy

Next.js 16 (App Router) + Supabase (Postgres/pgvector) + Claude.
Two halves: a public lifestyle-medicine site, and the **Medical Library**
knowledge engine (see `ARCHITECTURE.md` — read it before touching the
pipeline; `docs/archive/` is stale v1 documentation kept for history).

## Commands

- `npm run dev` — dev server
- `npm run build` — production build (run before considering work done)
- `npm run lint` — ESLint
- `npm run pipeline -- <cmd>` — run the knowledge pipeline locally
  (`status`, `work`, `discover [--dry-run]`, `sweep`, `extract <source_id>`).
  Defaults to `LLM_BACKEND=claude-code`, which bills your Claude subscription
  through the local `claude` CLI instead of API credits.
- `npm run seed-spine [-- --dry-run]` — seed/repair the curated taxonomy spine.
  **Always dry-run first**, and never run two copies concurrently (that raced
  and split the spine across duplicate roots once; migration 008 now makes it
  fail loudly instead).
- `npm run regen -- <topicId>` — regenerate one topic's article off-queue,
  bypassing the job system. Same subscription-billing default as `pipeline`.

## Environment

`.env.local`: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_SECRET_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`YOUTUBE_TRANSCRIPT_API_TOKEN`.
Server code uses `lib/supabaseServer.ts` (secret key, bypasses RLS);
client code uses `lib/supabaseClient.ts`. Never import the server client
into a client component.

**Model providers.** Every generative call goes through `lib/llm.ts` —
never call a provider SDK directly from a pipeline stage. `OPENAI_API_KEY`
is used *only* by `lib/embeddings.ts`: Anthropic ships no embeddings model,
and `match_claims` / `match_topics` are vector searches. It is the only
module that imports the `openai` package.

## Conventions

- DB schema changes go in `supabase/migrations_v2/` (numbered SQL, applied
  via the Supabase SQL Editor — there is no local CLI/psql access).
- v2 data rules: `raw_insights` are immutable (never UPDATE their content);
  dedup happens only through `claims`/`claim_members`; long-running work goes
  through the `jobs` table (checkpoint in `progress`), never inline in a
  request handler.
- Types for all v2 tables live in `lib/types.ts` (legacy v1 types below the
  marker are being phased out — don't build new code on them).
- UI: Tailwind + shadcn/ui in `components/ui/`; admin pages under
  `app/admin/`, public under `app/`.
