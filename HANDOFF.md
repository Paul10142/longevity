# Session Handoff — 2026-07-31

Prior context + future instructions for the next window. Two parts: **Part 1 is
plain-language for Paul** (non-technical); **Part 2 is technical** for the next
AI window. The living source of truth remains `BACKLOG.md` (top "state of play"
block) and the `v4-build-state` memory; this file is the consolidated snapshot.

---

# PART 1 — Plain language (for Paul)

## Where the project is
We're building the **Medical Library**: it reads Peter Attia "The Drive" episodes,
breaks each into individual facts, throws away duplicates, and keeps one clean,
trustworthy, source-linked body of knowledge for physicians.

- **The whole non-AMA back-catalog is loaded**: 231 new episodes ingested (249
  sources total), each with a word-for-word transcript and "jump to the moment"
  timestamps. (AMAs were excluded — they get cut off on YouTube.)
- **60 of ~249 episodes are fully processed** so far → **11,221 facts** boiled
  down to **9,925 unique claims**. Processing the rest just takes machine time.
- **Quality is verified**: 100% of stored quotes are genuinely word-for-word from
  the source, every new episode is timestamped, and nothing is corrupted.

## What got built this session
1. **Trust checks** — proved the extraction is faithful, built you a grading
   worksheet, and added automatic "double-check this fact" flagging on every source.
2. **Recency weighting** — newer sources now count for more (your request).
3. **Two review screens** in the admin: `/admin/flags` (facts to double-check) and
   `/admin/novelty` (how much of each source was genuinely *new* — right now ~75%
   of the corpus is new ground, ~12% was overlap the engine caught).
4. **Fixed the legal-page 404s** (privacy/terms links worked on no page before).
5. **"Hide thin topics"** so a barely-researched topic stays hidden from readers
   until it's substantial.
6. **Fixed a real bug** where an article could silently drop facts filed under a
   sub-topic; plus **88 automatic safety checks** (there were zero before).

## Decisions waiting on YOU (nothing is blocked, these are yours to make)
1. **Grade the fidelity worksheet** →
   https://claude.ai/code/artifact/4e9a442b-6d41-4be3-afcf-4941072823ff
   (rule each fact "faithful / added detail / etc.", Export, hand back). This is
   what lets us trust the auto-flagging enough to actually hide bad facts.
2. **Storage / Supabase Pro (time-sensitive).** The database is on the **free plan
   (500 MB cap)** and is at **339 MB (68%)**. It stops itself around ~90–100
   episodes to avoid locking. To process the *whole* catalog you need **Supabase
   Pro (~$25/month, 8 GB)**. Otherwise we stop at roughly the halfway point.
3. **Recency approach** — read `docs/recency-weighting.md` and pick an option (the
   "prefer the newer of two *contradicting* facts" part needs your go-ahead).

## ⚠ Why last night's run barely moved — and the fix
It was **NOT a rate limit** (you were right). Your **Mac was asleep most of the
night** — it's running **on battery, not plugged in**, and macOS sleeps
aggressively on battery. While asleep, the processing is frozen. Amphetamine alone
does **not** stop battery/lid-closed sleep. **For overnight runs: actually plug in
to AC power, and run under `caffeinate`** (I had removed `caffeinate` mid-session
when you said Amphetamine covered it — that was the mistake).

---

# PART 2 — Technical state (for the next window)

**Read first:** `BACKLOG.md` top "state of play" block, `v4-build-state` memory,
`ARCHITECTURE.md`, `CLAUDE.md`. Supabase project is **LifestyleAcademy
`vgzcrihdxcoozgcqadbt`** (always pin it).

## Corpus state (2026-07-31)
| metric | value |
|---|---|
| sources ingested | 249 (231 new non-AMA Drive eps, all dated + timestamped) |
| episodes extracted | 60 / 249 (**189 remaining**) |
| raw facts | 11,221 |
| active (deduped) claims | 9,925 |
| open extraction_fidelity flags | 7 (shadow mode, from source #310) |
| DB size | 339 MB = **68% of the free 500 MB cap** |
| jobs | idle supervisor; **7 stale queued/running + 1 failed** from the interrupted shift — auto-heal on next `overnightExtract.ts` run |

## Shipped & merged to `main` this session (all verified: tsc + `npm test` 88/88 + build)
- **Phase 1 extraction fidelity (BACKLOG §1):** 1b validated (`testExtractionFix.ts`,
  6% residual over-reach); 1c wired = `scripts/extract_with_fidelity.sh` (extract →
  drain → `extraction_fidelity` flag, serialized, **shadow mode — never sets
  status='flagged'** until the judge's κ is certified). 1a worksheet
  (`scripts/buildFidelityWorksheet.ts` → artifact) **awaiting Paul's labels** for
  judge↔human κ (`eval/extraction-goldset.json` then `evalExtraction.ts score`).
- **Recency (migration 015):** bounded recency bonus in `topic_claims()`; all
  sources dated (13 backfilled from YouTube). Contradiction/"same-author" half
  designed + **gated** in `docs/recency-weighting.md`.
- **Ingest:** `scripts/planIngest.ts` (CSV + `yt-dlp` channel dump → non-AMA video
  IDs), `scripts/backfillSourceDates.ts`. Plan in `scratchpad/ingest-plan.json`.
- **Overnight extraction supervisor:** `scripts/overnightExtract.ts` — batched,
  resilient, **idempotent (only extracts 0-insight sources)**, defers
  tagging/synthesis/references (`SKIP_TAGGING/SYNTHESIS_FANOUT/REFERENCES=1`).
- **Storage brake (migration 016 `database_size_bytes()`):** `--max-mb` (default
  460) stops before the free-plan lock.
- **Review screens:** `/admin/flags` (claim_flags triage), `/admin/novelty`
  (`lib/novelty.ts`, same classifier as the CLI `novelty` cmd).
- **Visibility gate (migration 018 `is_hidden`):** `lib/topicVisibility.ts`
  (VISIBILITY_MIN_CLAIMS=10) hides thin topics from public reads; `is_hidden`
  curator override wired into the topic SELECTs; admins bypass.
- **Bug fixes (migration 017 applied):** `stale_topics()` now recursive-subtree
  (was silently dropping child-subtree claims — verified: flags 12 stale topics);
  `enrichClinician` reads paged; `recomputeTopicCounts` active-filter;
  `discoverTopics` reflag-set persisted across budget yields.
- **v4 synthesis plumbing (§6):** `lib/blocks.ts` + `lib/blockRenderer.ts` +
  tests (sentence-block schema/renderer; **not wired into synthesis yet**).
- **Legal pages:** `/privacy-policy`, `/terms-of-use` (placeholder, counsel-review
  banner — fixes the footer 404s).
- **Tests:** first harness in the project → **88 tests** (`npm test`).

**Migrations applied & verified:** 015, 016, 017, 018. None pending.

## How to resume extraction (the ONLY thing that needs a machine babysitting)
Requires **AC power + caffeinate** (a local run freezes on sleep — see Part 1):
```bash
caffeinate -dimsu npx tsx --env-file=.env.local scripts/overnightExtract.ts --hours 9 --batch 4
```
Idempotent and resumable; it heals the stale/failed jobs and continues from
episode 61. **⚠ Only ONE pipeline/DB writer at a time.** **⚠ Storage:** it will
hit `--max-mb 460` around ~90 episodes — raise it only after upgrading to Pro.

## Next phases (forward plan, unchanged)
1. **Finish extraction** of the 189 remaining (storage-gated — needs Pro for the full set).
2. **Bulk re-tag + `pipeline discover --dry-run`** — file the new claims into the
   tree; new ROOT topics go to Paul for approval (`/admin/topics/proposals`).
3. **Phase 3 synthesis** — build the v4 article writer (the `lib/blocks.ts`
   plumbing + min-claims/groundedness gates + the §2a visibility gate front it).
4. Then: fidelity flagging pass over all sources before publishing.

## Deferred / known (do when extraction is idle — do NOT edit hot-path mid-run)
- **§4 consolidation.ts hot-path bugs** (mergeClaims topic-move, recomputeAggregates
  1000-cap) — deferred: too risky to edit the running consolidation path.
- **Recency contradiction path** — needs adjudicator change + a Paul-gated corpus
  reprocess (`docs/recency-weighting.md`).
- **is_hidden** override is wired in reads; no admin toggle UI yet.
- Cosmetic: footer still says "© 2024"; `parseGuests` treats only `&`/`and` (not
  `|`) as a guest separator (harmless for real Attia titles).

## Pointers
- Fidelity worksheet: https://claude.ai/code/artifact/4e9a442b-6d41-4be3-afcf-4941072823ff
- Admin: `/admin/flags`, `/admin/novelty`, `/admin/reviews`, `/admin/topics`
- Docs: `docs/recency-weighting.md`, `docs/synthesis-v4-spec.md`, `BACKLOG.md`, `ARCHITECTURE.md`
