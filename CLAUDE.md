# Lifestyle Academy

Next.js 16 (App Router) + Supabase (Postgres/pgvector) + OpenAI.
Two halves: a public lifestyle-medicine site, and the **Medical Library**
knowledge engine (see `ARCHITECTURE.md` — read it before touching the
pipeline; `docs/archive/` is stale v1 documentation kept for history).

## Commands

- `npm run dev` — dev server
- `npm run build` — production build (run before considering work done)
- `npm run lint` — ESLint

## Environment

`.env.local`: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_SECRET_KEY`, `OPENAI_API_KEY`, `YOUTUBE_TRANSCRIPT_API_TOKEN`.
Server code uses `lib/supabaseServer.ts` (secret key, bypasses RLS);
client code uses `lib/supabaseClient.ts`. Never import the server client
into a client component.

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
