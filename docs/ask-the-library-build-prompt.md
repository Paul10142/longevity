# Build prompts for "Ask the Library" Phase 0

Design approved by Paul 2026-10-25. Each window reads only its own files; the two
windows touch disjoint files (middleware.ts belongs to Window A).

## Window A — backend

```text
Build Phase 0 (backend half) of "Ask the Library" for the Lifestyle Academy Medical Library.
Read docs/ask-the-library-design.md in full first; it is the spec. Then read only: ARCHITECTURE.md
"Core principles" and "Data model"; lib/llm.ts; lib/synthesis.ts lines 364-400 (scoreGroundedness);
lib/embeddings.ts exports; lib/pagination.ts; app/api/search/route.ts; app/api/claims/[id]/members/route.ts;
supabase/migrations_v2/030_claim_vectors_finish.sql and 015_recency_scoring.sql (for the SQL shape);
lib/blocks.ts header (Sentence types). Load the claude-api skill and read its TypeScript streaming page
before touching lib/llm.ts.

Deliver, on a new branch from main:
1. supabase/migrations_v2/034_ask_the_library.sql: search_claims(query_embedding, match_threshold, match_count)
   with `set hnsw.ef_search = 300` (design §6.1), plus ask_answers and ask_feedback tables with RLS on and
   no policies. Apply it yourself: turn on the "Supabase LifestyleAcademy" connector (set_session_connector_enabled,
   project vgzcrihdxcoozgcqadbt) and use its apply_migration tool; the migration only adds a function and two tables,
   so it is safe even if an extraction run is live. Turn the connector off when done.
2. lib/llm.ts: add claudeStream(system, user, {model, effort, maxTokens}) on the api backend using
   messages.stream() with thinking {type:"adaptive"}, output_config effort, and the server-side fallback beta.
   Keep claudeJson untouched.
3. lib/ask/expand.ts, retrieve.ts, provenance.ts, compose.ts, parse.ts, store.ts, audit.ts exactly as design §5-§6:
   Haiku 5.5 expansion (2-4 phrasings), union + rank + 0.95 twin collapse capped at 150, provenance via one
   representative member per claim, Opus 5.5 low-effort streaming composer with the §6.4 rules, parseBrief into
   lib/blocks sentences with dangling-marker count, exact + nearest-question cache (§6.6), evidence floor (§6.3),
   async Haiku groundedness audit written back to ask_answers.groundedness_score.
4. Routes: POST /api/ask (NDJSON stream, §6.7 event contract), GET /api/ask/[id], POST /api/ask/[id]/feedback.
   Add /ask and /api/ask to UNRELEASED in middleware.ts (you own middleware.ts; the frontend window does not touch it).
   Add `speaker` and the source `date` to the
   /api/claims/[id]/members payload.
5. Tests with node:test, no model calls (fake candidates): union/rank/collapse, evidence floor, parseBrief,
   marker resolution, cache lookup. npm test, npm run lint and npm run build green.
6. Measure on five real questions after I apply the migration: candidates returned, first-token and total latency,
   tokens and cost per stage; put the numbers in a short table at the end of docs/ask-the-library-design.md §7.
   If total latency is near 60 s, say so and propose the job-queue fallback; do not build it unprompted.

Rules: never call a provider SDK outside lib/llm.ts; never import lib/supabaseServer into client code;
raw_insights are read-only; follow the commit identity and reply format in ~/.claude/CLAUDE.md; open the PR
and land it when green (pull-requests rules), but hold the merge if an extraction run is live (docs/EXTRACTION_RUNBOOK.md). Report in Paul's UPDATES / NEXT STEPS / TO-DO ITEMS format.
```

## Window B — frontend

```text
Build Phase 0 (frontend half) of "Ask the Library" for the Lifestyle Academy Medical Library.
Read docs/ask-the-library-design.md §1, §6.7 and §9 first; §6.7 is the event contract you build against.
Then read only: app/search/page.tsx and components/SearchBar.tsx (patterns), components/TranscriptReader.tsx
and lib/transcriptView.ts (timestampLink), components/TopicTabs.tsx (tabs style), app/admin/ (one existing
admin table page for layout), components/ui/ (shadcn), middleware.ts (UNRELEASED list).

Deliver, on a new branch from main, with a mock NDJSON stream in dev so you do not depend on the backend window:
1. /ask page: question box with six example chips; streaming body that renders [n] markers as numbered citation
   chips; right-hand evidence panel that opens a citation to the claim statement, verbatim quote, speaker
   ("attributed to"), episode title and date, and a timestamp link to the public video (never the private feed
   URL); "Go deeper" list of contributing episodes ranked by citations; "Related pages" (topic links);
   three follow-up question buttons that re-ask; thumbs feedback posting to /api/ask/[id]/feedback;
   "not covered" state with the nearest topics; "thin evidence" banner; "answered <date>, refresh" for cached answers.
2. /admin/ask: table of answers (question, status, latency, tokens, groundedness, dangling markers, feedback)
   with a not-covered filter, linking each row to /ask?id=.
3. Header link to /ask visible only to the admin session. Do NOT edit middleware.ts: the backend window adds
   /ask and /api/ask to UNRELEASED, and your dev server runs with the admin session anyway.
4. Mobile layout: evidence panel becomes a bottom sheet under 768 px.
5. Lint and build green; a tiny node:test for the marker-to-chip parser.

Rules: Tailwind + shadcn only; Title Case for headings, buttons and labels; no source narration in the prose
(the model's text is rendered as-is, attribution lives in the chips); follow the commit identity and reply format
in ~/.claude/CLAUDE.md; open the PR and land it when green, but hold the merge if an extraction run is live
(docs/EXTRACTION_RUNBOOK.md). Report in Paul's UPDATES / NEXT STEPS / TO-DO ITEMS format.
```
