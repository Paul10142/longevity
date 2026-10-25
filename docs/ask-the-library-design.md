# Ask the Library — question-driven synthesis over the vetted corpus

**Status:** design, written 2026-10-25 in a Fable planning window. Not built.
This is the buildable plan for the feature Paul described on 2026-10-25: a
physician types a question ("Tell me more about VO2 max training"), the system
pulls every relevant claim out of the Medical Library, writes a short, cited
brief, and links to the episodes behind it. Builds on `ARCHITECTURE.md` (data
model, trust principles) and reuses the v4 sentence model in `lib/blocks.ts`.
`BACKLOG.md` P3.5 lists this as "Physician Q&A (Phase 8) — last in the
sequence"; Paul has pulled it forward, for the reasons in §2.

---

## 1. What the physician gets

One box. One question. In under a minute:

1. **Bottom line** — two or three sentences that answer the question.
2. **What to do** — the actionable part first (targets, dosing, frequency,
   monitoring), when the evidence carries any. Protocol-led, as the product
   thesis already says (v4 spec §2).
3. **Key points** — grouped by theme, each sentence carrying a numbered
   citation `[3]`.
4. **Where experts differ** — when two retrieved claims disagree, both are
   shown, attributed, never averaged (principle 2).
5. **What the library does not cover** — a plain statement when the evidence
   is thin or absent, instead of an answer from general knowledge.
6. **Evidence panel** — every citation opens to the claim, the verbatim quote,
   who said it, the episode, the date, and a link to that minute of the video.
7. **Go deeper** — the episodes ranked by how much they contributed, the
   library pages (topic articles) that exist for the subject, and three
   follow-up questions.

The answer is a *brief*, not an article: about 250–400 words unless the
question asks for a full review. Depth is one click away in the evidence panel
and the episode list. (Decision A in §10.)

## 2. Why this is the B2B wedge

Every general chatbot can answer "tell me about VO2 max training". Ours is
worth paying for because of five properties no general tool has:

| Property | What it means for a practice |
|---|---|
| **Closed, vetted corpus** | Answers come only from 453 expert episodes already deduplicated and quarantined by the fidelity judge. Nothing from the open web, nothing from the model's memory. |
| **Provenance to the minute** | 98.5% of facts carry a timestamp, 93% a verbatim quote, 83% a named speaker. A citation is "Dr X, episode 405, 41:12", not "studies show". |
| **Honest about gaps** | "The library does not cover this yet" is a feature. A tool that admits ignorance is one a physician can trust at the point of care. |
| **Disagreement preserved** | Conflicting expert positions are shown side by side (principle 2), which is exactly what a clinician needs and what averaging chatbots hide. |
| **A learning loop** | Every question is logged. Unanswered questions become the ingestion roadmap; frequent questions become the curated protocols. The product gets better from being used. |

And one property that matters today: **the question path reaches the whole
library; the topic path reaches 1% of it.** Measured 2026-10-25: 41,449
active claims, of which 41,090 are still `needs_tagging` (tagging has been
parked since August). Only 4,296 claim-to-topic links exist, feeding 55
articles. Vector search over claims is the only door to the other 99% until
tagging resumes. Ask the Library opens that door now.

## 3. What the corpus supports today (measured 2026-10-25)

| | Count |
|---|---|
| Sources (episodes) | 453, of which 427 with timed transcripts |
| Raw facts (`raw_insights`) | 55,644 |
| Active claims | 41,449 (41,976 vectors in `claim_embeddings`) |
| Facts with a timestamp / quote / speaker | 54,816 / 51,800 / 46,379 |
| Active topics (spine) | 89 (48) |
| Claim → topic links | 4,296 (41,090 claims untagged) |
| Topic articles / protocols | 55 / 26 |
| Verified primary references | 17 (58 claim links) |
| Claims mentioning "VO2" literally | 390 |

Two consequences:

- **Citations are to experts and episodes, not to primary literature.** With 17
  verified references, the `[R#]` literature layer is near-empty. The UI says
  so ("Sources: expert interviews; primary-literature citations coming").
- **Caption/Deepgram twins still exist for some episodes** (the caption
  retirement is 12 of 75 done, 2026-10-16). Near-identical claims will show up
  in the same candidate set until retirement finishes; the composer de-duplicates
  at answer time (§6.2).

### 3.1 The retrieval ceiling (measured)

`match_claims` (migration 030) runs the HNSW index in plain mode with the
default `hnsw.ef_search = 40`. Probe, "VO2 max training", 2026-10-25:

| Request | Rows returned |
|---|---|
| threshold 0.20, count 200 | **34** |
| threshold 0.40, count 200 | 34 |
| threshold 0.50, count 200 | 34 |

Top similarity 0.80, 10th 0.75, last 0.70. Embedding 278 ms, round trip 1.3 s.
Asking for 200 returns 34 no matter what: the index hands back at most 40
neighbours and the status filter trims a few. That is fine for dedup (8
candidates) and useless for a question that touches 100–300 claims. **Fix
first (§6.1): a dedicated `search_claims` function with `ef_search` raised,
plus query expansion.**

## 4. The trust contract

The rules the feature must obey, each tied to a principle in
`ARCHITECTURE.md`:

1. **No new information** (principle 1). Every declarative sentence cites one
   or more claim ids, or is pure connective prose that asserts nothing. The
   composer is given claims and nothing else; the system prompt forbids
   outside facts, outside definitions and outside numbers. This is the v4
   sentence model (`lib/blocks.ts`: `sourced` / `synthesis` / `connective`)
   applied to a smaller unit — the first live consumer of that model.
2. **Never average** (principle 2). Two claims with different doses,
   populations or thresholds are both stated, both cited. Conflicts go under
   "Where experts differ".
3. **Say "not covered"** (principle 1, again). Below the evidence floor (§6.3)
   the answer is the gap statement plus the nearest library pages. Never a
   best-effort answer.
4. **Provenance is the chain, not a field.** A citation resolves claim →
   member fact → quote, speaker, source, timestamp through the existing
   `/api/claims/[id]/members` payload. Nothing is re-stated by the model.
5. **Contested stays contested.** Expert-opinion claims are labelled by
   evidence type in the panel; no claim is upgraded to "established" by the
   prose.
6. **Audited, not trusted.** A groundedness audit (Haiku) scores every stored
   answer asynchronously; low scores surface in the admin log for Paul.
7. **The best model writes the prose** (principle 7, invariant in v3.2). Opus
   5.5 composes; cheaper models do retrieval support and audits.

## 5. Architecture

```
question ─▶ embed + expand ─▶ search_claims (×1–4) ─▶ union, dedupe, rank
                                                            │
          ◀─ stream markdown with [n] markers ◀─ compose ◀─ candidates + provenance
          │
          ▼
   parse sentences → store answer + claim_ids → async audit → admin log
```

Five stages, all in `lib/ask/`:

| Stage | Module | Model | Budget |
|---|---|---|---|
| Expand | `expand.ts` | Haiku 5.5, low effort | 1 call, ~2 s. Turns the question into 2–4 search phrasings ("VO2 max interval protocols", "zone 2 vs VO2 max", "VO2 max and mortality"). Skipped for very short questions? No: always run, it is the biggest recall lever. |
| Retrieve | `retrieve.ts` | none | `search_claims` per phrasing (≤ 4), union by id, keep best similarity, cap 150 candidates, drop near-identical twins (cosine ≥ 0.95 among candidates). ~1.5 s. |
| Provenance | `provenance.ts` | none | For the candidates: one representative member per claim (quote, speaker, source, date, `start_ms`), evidence type, `source_count`; `claim_links` among the set (conflict hints); `match_topics` for related pages. Pages through `selectAllPaged`. |
| Compose | `compose.ts` | Opus 5.5, **low** effort, streaming | One call. Input: question + ≤ 150 candidates as `[n] (evidence type, k sources, date) statement — context`. Output: markdown brief with `[n]` markers and three follow-up questions. Selection happens inside the call (the cited `[n]` set *is* the evidence set); a separate selection pass is added later only if measurement says so. |
| Audit + store | `audit.ts`, `store.ts` | Haiku 5.5 | Parse the brief into typed sentences (a sentence with markers = `sourced`, without = `connective`); store; audit asynchronously (same shape as `scoreGroundedness` in `lib/synthesis.ts`). |

**Why stream markdown instead of the JSON block model.** Streaming is the
difference between "working…" for 30 s and words on screen in 10 s, and it
keeps the request inside Vercel's function limit (Hobby: 60 s, see
`ARCHITECTURE.md` "Deployment / cron cadence"). Structured JSON cannot be read
while it streams. So the composer writes markdown with short local markers,
the client renders it live, and the server parses the finished text into the
sentence model for storage and audit. The block renderer stays for topic
articles.

**Model calls go through `lib/llm.ts`** (convention: never a provider SDK from
a feature module). It needs one addition: `claudeStream(system, user, {model,
effort, maxTokens})` on the `api` backend, using the SDK's `messages.stream()`
with adaptive thinking (Opus 5.5: thinking cannot be disabled; effort is the
only lever, default `medium`, so pass `low` explicitly) and the server-side
refusal fallback (`fallbacks: "default"`, beta header
`server-side-fallback-2026-07-01`) so a safety-filter decline on a medical
question re-runs on a fallback model instead of failing the physician's
request. The `claude-code` backend is not used by the web app.

## 6. Design details

### 6.1 Migration 033 — `search_claims` and the answer tables

```sql
-- Question-time retrieval: deeper HNSW search than dedup needs.
create or replace function public.search_claims(
  query_embedding extensions.vector,
  match_threshold double precision default 0.45,
  match_count integer default 100
) returns table(
  id uuid, canonical_statement text, context_note text,
  best_evidence_type text, max_importance integer, source_count integer,
  insight_type text, similarity double precision)
language sql stable
set hnsw.ef_search = 300          -- per-function GUC: plain-mode depth
set search_path to 'public', 'extensions'
as $$ ... same body as match_claims, joining claims for the extra columns ... $$;

create table public.ask_answers (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  question_norm text not null,            -- lower, trimmed, whitespace-collapsed
  question_embedding extensions.halfvec(1536),
  status text not null default 'answered', -- answered | not_covered | failed
  candidates jsonb not null,              -- [{id, similarity}] as retrieved
  cited_claim_ids uuid[] not null default '{}',
  body_markdown text,
  sentences jsonb,                        -- lib/blocks Sentence[] after parsing
  follow_ups text[],
  model text, effort text,
  latency_ms integer, input_tokens integer, output_tokens integer,
  groundedness_score numeric,             -- async audit, null until scored
  corpus_claims integer,                  -- active claims at answer time (staleness)
  asked_by text,                          -- 'admin' until accounts exist
  created_at timestamptz default now()
);
create index on public.ask_answers (question_norm);
create index on public.ask_answers using hnsw (question_embedding halfvec_cosine_ops);

create table public.ask_feedback (
  id uuid primary key default gen_random_uuid(),
  answer_id uuid references public.ask_answers(id) on delete cascade,
  rating smallint check (rating in (-1, 1)),
  note text,
  created_at timestamptz default now()
);
```

Both tables are service-role-only like everything else (RLS on, no policies —
see the `supabase-security-posture` memory). Applied through the SQL editor.

### 6.2 Ranking and de-duplication of candidates

Union of the per-phrasing results, best similarity kept. Rank by
`similarity + 0.02·min(source_count,5) + evidence bonus (MetaAnalysis/RCT
+0.04, Cohort +0.02) + recency (0..0.03 over 5 years)`, the same shape as
`topic_claims()` scaled to cosine units. Keep the top 150. Then drop any
candidate whose vector is ≥ 0.95 cosine to a higher-ranked one (caption twins)
— the lower one is kept in the answer record as `collapsed_into` so the
evidence panel can still show it.

### 6.3 The evidence floor ("not covered")

From the probe, a well-covered subject returns top similarities ≈ 0.80 and a
40-deep tail still ≥ 0.70. Starting rule, to be calibrated on the eval set
(§8): **fewer than 5 candidates ≥ 0.55 → `not_covered`**; 5–15 → answer with a
"thin evidence" banner; more → normal. The not-covered response lists the
three nearest topics with visible articles and logs the question with
`status = 'not_covered'`. That log is the content roadmap.

### 6.4 The composer prompt (rules, not wording)

- Answer *this question*; do not cover every claim. Coverage of the question,
  not of the candidate set, is the goal (unlike topic articles).
- Use only the numbered claims. No outside facts, numbers, mechanisms or
  definitions. If a term the question uses is not defined in any claim, say
  the library does not define it.
- Every declarative sentence ends with one or more markers `[n]`. A sentence
  with no marker must assert nothing (transition, framing).
- When two claims disagree, state both with their markers under "Where
  experts differ". Never merge numbers into a range the claims do not state.
- Order: bottom line → what to do (only if actionable claims exist) → key
  points by theme → where experts differ → what is not covered. Headings as
  `###`. 250–400 words unless the question asks for a full review.
- Physician register. No source narration in the prose ("the podcast said");
  attribution lives in the citation layer. No mention of "claims".
- End with `FOLLOW_UPS:` and three short questions the library can answer
  from the same candidate set.

### 6.5 Parsing and audit

`parseBrief(markdown, candidateMap)` splits the body into sentences; a
sentence with markers becomes `{kind:'sourced', claim_ids}` (two or more ids
and a conclusion word: `synthesis`), without markers `connective`; the
`FOLLOW_UPS:` tail becomes `follow_ups`. Markers that do not resolve to a
candidate are stripped and counted (`dangling_markers`, surfaced in the admin
log). The audit runs the stored sentences through the same prompt shape as
`scoreGroundedness`, on Haiku 5.5, as a background call after the response is
sent (`after()` in the route handler, or a `jobs` row of type `audit_answer`
if the Vercel runtime cuts it off — decide in build, prefer the job).

### 6.6 Caching

Before any model call: exact `question_norm` hit → serve the stored answer;
else nearest `question_embedding` ≥ 0.95 → serve it, labelled "answered
<date>". A stored answer is stale when `corpus_claims` has grown by more than
10% since; the UI offers "refresh". Phase 2 turns this into "what changed
since you asked" by diffing the cited set against a re-run.

### 6.7 API and UI

- `POST /api/ask` `{ question }` → NDJSON stream, one event per line:
  `{type:'retrieval', count, thin:boolean}` → `{type:'delta', text}` ×N →
  `{type:'done', answer_id, cited:[{n, claim_id}], follow_ups, latency_ms}`,
  or `{type:'not_covered', nearest_topics}` or `{type:'error', message}`.
  Cached answers send `retrieval` then one `delta` with the whole body.
- `GET /api/ask/[id]` → the stored answer (for sharing and the admin log).
- `POST /api/ask/[id]/feedback` `{ rating, note }`.
- `/ask` page: question box, six example chips, streaming body with `[n]`
  rendered as chips, right-hand evidence panel driven by
  `/api/claims/[id]/members` (already returns quote, speaker-less for now,
  source links, `start_ms`; add `speaker` and `sources.date` to that payload),
  "Go deeper" episode list, related pages, feedback, follow-ups.
- Gate: add `/ask` and `/api/ask` to `UNRELEASED` in `middleware.ts` so only
  the admin session sees it (Decision C).
- `/admin/ask`: table of answers — question, status, latency, tokens,
  groundedness, dangling markers, feedback; filter `not_covered`.

Timestamp links use `timestampLink()` from `lib/transcriptView.ts` (already
used by `TranscriptReader`) and never `sources.url` (private feed; see
`lib/sourceLinks.ts`).

## 7. Cost and latency (estimates, to be measured in Phase 0)

Per *new* question, API list prices 2026-10 (Opus 5.5 $4/$20 per MTok,
Haiku 5.5 $0.10/$0.50):

| Stage | Tokens | Cost |
|---|---|---|
| Expand (Haiku 5.5) | ~0.6k in / 0.1k out | < $0.001 |
| Compose (Opus 5.5, low) | ~12k in / 1.5k out (+ ~1k thinking) | ~$0.10 |
| Audit (Haiku 5.5) | ~4k in / 0.2k out | < $0.001 |
| **Total** | | **≈ $0.10–0.15**; cached repeats $0 |

1,000 new questions a month ≈ $100–150. Prompt caching on the composer's
system prompt trims a little more; the candidate block changes per question so
it cannot be cached.

Latency, first words / complete: embed 0.3 s + expand ~2 s + retrieval ~1.5 s
+ first token ~3 s ≈ **7 s to first words**, ~25–35 s to complete at ~60–80
tokens/s. The whole request must finish inside the Vercel function limit;
streaming starts the response early, which is what keeps the 60 s Hobby cap
survivable. **Verify the cap in build**: if `maxDuration` cannot cover p95,
fall back to the queue (`jobs` type `answer_question`, page polls) for the
compose stage, as the CLAUDE.md convention prefers.

## 8. Measurement (principle 6: build the ruler first)

An eval set `eval/ask-questions.json` of 30 questions physicians would ask
(Paul writes 10 in his words; 20 drafted from the spine topics), each with:
expected `covered: true|false`, and for covered ones 3–5 claim ids that must
be cited. Script `scripts/evalAsk.ts` runs them and reports:

| Metric | Gate before any physician sees it |
|---|---|
| Groundedness (audit) | ≥ 0.95 mean, no answer < 0.85 |
| Must-cite recall | ≥ 0.80 of expected claim ids cited |
| Not-covered precision | 0 false "not covered" on covered questions; 0 answers on the 5 off-corpus questions |
| Dangling markers | 0 |
| Latency | p50 ≤ 35 s complete, p95 inside the function limit |
| Paul's usefulness rating | ≥ 4 / 5 on 20 of 30 |

Re-run after any change to the prompt, thresholds or models (as
`evalTwinRecall.ts` is for dedup).

## 9. Phases

**Phase 0 — plumbing and a usable MVP (two Sonnet build windows, parallel).**

- Window A, backend: migration 033; `lib/ask/*`; `claudeStream` in
  `lib/llm.ts`; `/api/ask` stream, `/api/ask/[id]`, feedback; `speaker` +
  `date` added to the claim-members payload; unit tests for union/dedupe,
  the evidence floor, `parseBrief`, marker resolution (fake candidates, no
  model calls, node:test).
- Window B, frontend: `/ask` page and components against the §6.7 event
  contract (mock stream in dev), evidence panel, `/admin/ask`, middleware gate,
  header link for admins.
- Done when: Paul asks ten real questions on the deployed site and gets cited
  briefs; an off-corpus question returns "not covered"; the admin log shows
  every ask with latency and tokens; `npm test` and `npm run build` green.

**Phase 1 — the ruler and the honesty calibration (one window).**
Eval set + `evalAsk.ts`; async audit wired; thresholds calibrated; caching
and near-duplicate question reuse; prompt tuned until the §8 gates pass.
Done when the gates pass and the numbers are in this doc.

**Phase 2 — the B2B layer (later, separate specs).** Accounts and practices
(Supabase Auth; `lib/membership.ts` is a stub today), saved and shared
answers, patient-language translation of a brief (principle 5), "what changed
since you asked", question analytics → content roadmap, a 3–5 physician pilot.
Nothing here is needed to prove the feature.

## 10. Decisions for Paul

| | Decision | Options | Recommendation |
|---|---|---|---|
| A | Answer shape | (a) brief, 250–400 words, depth in the panel; (b) full custom article per question; (c) brief now, "build the full article" button that saves a page | **(a)**; (c) is a Phase 2 button once briefs are trusted |
| B | Writer model | (a) Opus 5.5 at low effort, ≈ $0.10/question, ~30 s; (b) Sonnet 5.5, ≈ half the cost and time | **(a)** — the v3.2 invariant says prose is Opus; switch only if measured latency breaks the function limit |
| C | Who sees it first | (a) admin password only (Paul and whoever he hands it to); (b) public behind the existing site | **(a)** until Phase 2 accounts |
| D | Approve this plan | read §1, §4, §9 | build Phase 0 |

## 11. Risks

- **Function time limit on Vercel Hobby.** Mitigated by streaming; fallback is
  the job queue (§7). Measure p95 in Phase 0 before Phase 1.
- **Untagged corpus means sparse "related pages".** Expected; the episode list
  carries the depth until tagging resumes.
- **Caption twins** double-cite until retirement finishes; the ≥ 0.95 collapse
  hides most of it.
- **Safety-filter refusals** on legitimate medical questions (seen in the dedup
  judge): the server-side fallback handles it; a refused compose is logged as
  `failed` with the category, never retried on the same model.
- **The model answering from memory** is the one failure that spends trust.
  The audit, the marker rule and the eval gates exist for it; an answer that
  fails the audit is hidden from the share link and flagged in the admin log.
- **Speaker attribution is model-inferred** (migration 020): the panel shows
  the speaker as "attributed to", and the episode is the authority.
