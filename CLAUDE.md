# Lifestyle Academy

Next.js 16 (App Router) + Supabase (Postgres/pgvector) + Claude.
Two halves: a public lifestyle-medicine site, and the **Medical Library**
knowledge engine (see `ARCHITECTURE.md` — read it before touching the
pipeline; `docs/archive/` is stale v1 documentation kept for history).

## ⛔ Session & phase discipline (READ FIRST — enforced by Paul, 2026-07-25)

This project bloated one window's context and scattered work across several
windows at once. To stop that recurring:

1. **One phase per window.** Work a single phase (the phase list is in
   `BACKLOG.md`) to its checkpoint, then STOP. Do NOT start the next phase in the
   same window.
2. **Stop early when context is large.** If the conversation is getting long
   (many tool calls / large context) even mid-phase, checkpoint and hand off
   rather than pushing on. A clean handoff beats a bloated window.
3. **Hand off before stopping.** Always: (a) commit all changes, (b) update the
   `v4-build-state` memory + the `BACKLOG.md` "WINDOW HANDOFF" block, (c) give
   Paul the exact one-paragraph prompt to paste into a fresh window.
4. **One active window at a time on this working tree.** Never run two windows'
   edits or pipeline/DB writes against the repo concurrently — that is what
   scattered and corrupted state on 2026-07-25. If another window may be live,
   coordinate through `ARCHITECTURE.md` and do not run pipeline/DB writes.
5. **Reply format:** follow the `standard-report-format` memory (Updates → Next
   Steps → To-do Items).

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
`ADMIN_PASSWORD` (the shared password for the `/admin` gate) and
`ADMIN_SESSION_SECRET` (HMAC key that signs the admin session cookie) protect
the workbench — `middleware.ts` blocks every `/admin` and `/api/admin` route
without a valid session, and the gate fails closed while either is unset.
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
