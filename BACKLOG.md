# Backlog

Known outstanding work, captured 2026-07-22 during the v1 dead-code cleanup
(commits `0a37deb`..`ebe3697`). Everything here was verified against the code
or the live database at that time — items are written with enough context to
act on without re-deriving them.

`ARCHITECTURE.md` remains the authoritative design doc; this file is a to-do
list, not a spec. Items already specced there are linked rather than restated.

---

## P1 — Broken for users right now

### Legal pages 404 on every page of the site
`/privacy-policy` and `/terms-of-use` are linked from the global footer but no
routes exist. A sweep of every static internal `href` in `app/` and
`components/` against the route tree found these are the only two dead links
left. Most consequential item here, especially with a membership offering
planned.

**Done when:** both routes exist with real policy text. Needs actual legal
copy — scaffolding empty pages is not a fix.

### Lever copy on `/start` is unreviewed placeholder
See `TODO(copy)` in `lib/levers.ts`. The `tagline`, `description`, and
`primaryBenefits` for all five levers were drafted to get the grid rendering
after the v1 `concepts` table was dropped and the originals lost. This is
public marketing copy on a primary landing page.

**Done when:** all five levers carry copy you've written. Single file, no
schema involved.

### "Popular protocols" cards mismatch their destinations
`components/PopularProtocolsStrip.tsx` — a hardcoded list of six protocol cards
("Zone 2 Cardio Protocol", "Sleep Hygiene Protocol") that link to broad topic
pages (`/topics/exercise`). The links work; the specificity does not match.

Was six guaranteed 404s (pointing at `/admin/topics/{v1-slug}`, a route that
never existed); the stopgap remapped them to real v2 topic slugs.

**Done when:** sourced from the `topic_protocols` table instead of a hardcoded
array. Blocked on protocols actually being generated for these topics.

---

## P2 — Data & pipeline

### Verify the topic-merge fix against real data
`ebe3697` changed the `merge` action in `app/api/admin/topics/[id]/route.ts` to
drain claim links in batches and delete only the ids it just moved. Previously
a blanket `delete().eq("topic_id", id)` destroyed any link a concurrent
`tag_claims` job inserted mid-merge, silently dropping the claim's topic
assignment.

It was verified by type-check and build only — exercising it means running real
merges on production data.

**Done when:** a merge has been run with the worker active and claim counts
reconcile on both sides.

### ~~Reshape the taxonomy toward the curated top-level tree~~ — DONE 2026-07-22
Completed in `d0d4e83`..`89f4034`. The live tree is now 10 curated spine
branches with **zero** legacy roots, all 1,013 claims still tagged. The six
original headings were widened to ten because the corpus demanded it — most
of the library is reproductive/hormonal health and research methodology, which
had no home among the original six.

Three mechanisms now hold the line, in increasing order of reliability:
prompt (prefer existing topics) → code (`createChildTopic` requires a parent,
so no call site can mint a root) → database (unique index on
`(lower(name), parent)` for active topics, migration 008).

**Note still live:** `lib/levers.ts` pins lever cards to specific topic slugs.
If a lever's topic is archived or merged, that card silently disappears from
`/start`. Re-check the grid after any future reshaping.

### `claims.topic_fit` is not discriminating
Added in migration 007 to flag placements the tagger wasn't confident about, so
a human could review approximate filings. In the first real run all 77 claims
came back `good` — zero `approximate`, zero `unfiled`. The value is the model's
own self-report, and it does not currently separate a confident placement from
a resigned one, so it cannot be trusted to surface bad filings.

**Done when:** the signal is grounded in something measurable — e.g. derive it
from the ANN similarity to the chosen topic rather than asking the model — and
a spot-check shows `approximate` actually correlating with weak placements.

### `discover_topics` splits rather than consolidates
The stage samples claims **one existing topic at a time** and asks what finer
topics live inside. Two consequences: every proposal is a split (a dry run
produced 63 new topics against a 133-topic tree), and cross-cutting themes are
structurally invisible — supplement claims sat 1–2 apiece across eleven topics,
so no single batch ever saw enough of them to cluster. It never proposed
"Supplements" for exactly this reason.

Less urgent now that the spine constrains where anything can land, and that
`placeTopic` routes new roots to the approval queue rather than creating them.

**Done when:** clustering runs corpus-wide over `claims.embedding`, ignoring
current topic membership, so thin cross-cutting themes surface. Costs no new
embedding spend — every claim is already embedded; only creating a topic
embeds anything new.

### `topic_protocols` generation
Most topics have no generated protocol yet (all zero as of the cleanup). Gates
the P1 protocols-strip item above.

---

## P3 — Specced but not built

Three phases are agreed and written up in `ARCHITECTURE.md` but not
implemented. Not restated here — read the sections directly:

- **v3 evidence layer + scale invariants** (`## v3 evidence layer`)
- **v3.1 physician-grade comprehensiveness** (`## v3.1 target spec`) — marked
  *agreed, not yet built*
- **v3.2 incremental update model** (`## v3.2 incremental update model`) —
  section-level regeneration and living documents, also *agreed, not yet built*

---

## P4 — Documentation

### `ARCHITECTURE.md` status line is stale
Line 3 reads *"v2 rebuild in progress (branch `v2-rebuild`, started July
2026)"* while the same file carries v3, v3.1 and v3.2 sections below it, and
work has moved off that branch. Since `CLAUDE.md` designates this file as
authoritative, its status line is the first thing a reader trusts.

**Done when:** the header reflects actual current phase.

### `docs/archive/` is intentionally stale
v1 documentation kept for history. Not a to-do — listed so nobody "fixes" it.
`docs/archive/ARCHITECTURE-REPORT.md` still describes deleted components.

---

## P5 — Code hygiene

### 15 lint warnings (0 errors)
All pre-existing, all unused vars/imports except one hook-dependency warning.

| File | Warnings |
|---|---|
| `app/admin/sources/new/page.tsx` | `useEffect`, `isValidYouTubeUrl`, `data` unused |
| `lib/fileExtraction.ts` | `importError`, `error` unused (swallowed catches) |
| `components/TranscriptEditor.tsx` | `CardDescription`, `sourceId` unused |
| `app/admin/sources/page.tsx` | `CardHeader`, `CardTitle` unused |
| `components/WhatMattersMost.tsx` | `highlightedLevers` unused — see below |
| `components/TopicsAuditClient.tsx` | `byId` unused |
| `components/SourceEditorClient.tsx` | `useState` unused |
| `components/membership/PaidFeatureGate.tsx` | `MembershipTier` unused |
| `app/api/admin/sources/fetch-youtube-transcript/route.ts` | `e` unused |
| `components/InsightReviewFilters.tsx` | `useEffect` missing dep `searchQuery` |

Two are worth more than a lint pass:

- **`WhatMattersMost` ignores `highlightedLevers`.** The prop is declared,
  documented, and passed from `app/start/page.tsx`, but never read in the
  component body. The intended visual feedback on the priority selector was
  never wired up. `LeverGrid` does use it, so the feature half-works.
- **`lib/fileExtraction.ts` swallows two caught errors** without logging, which
  can hide ingestion failures.

### Membership is stubbed
`lib/membership.ts` has two TODOs standing in for database lookups until auth
exists. Expected, not rot.

### `eslint.config.*` doesn't scope out nested worktrees
Its `ignores` list (`.next/**`, `node_modules/**`, `dist/**`, `coverage/**`,
`src/**`) only matches those directories at the top level. Claude Code worktrees
live inside the repo at `.claude/worktrees/<name>/` — a full nested checkout,
each with its own `.next`, and potentially its own `dist/`/`src/`. None of the
current patterns match a `.next` (or `dist`, `src`) three levels down, so
`npm run lint` run from the real repo root while any such worktree exists
sweeps up that worktree's build output and duplicate source tree as if it were
part of the project.

Hit this directly merging `claude/stoic-blackburn-91d7db` into `main`
(2026-07-22): `npm run lint` from the repo root reported 24,599 problems.
Excluding `.claude/**` brought it back to the true baseline (0 errors, 15
warnings, matching a lint run from inside the worktree itself). Not a real
regression — a scope gap that will misfire the same way for anyone who lints
from the repo root while a worktree is present.

**Done when:** `ignores` in `eslint.config.*` excludes `.claude/**` (or uses
`**/.next/**`, `**/dist/**`, `**/src/**` so nested copies at any depth are
caught, not just top-level).

---

## Verified — do not re-investigate

Recorded to save the next person the trip:

- **There are no duplicate active topics *now* — but `medications-supplements-2`
  and `risks-2` were a real bug, not transient noise.** Two concurrent
  `seedSpine` runs each read the topic list before either had written, both
  found no `Risks`, and both created it — splitting the spine in half across
  duplicate roots. They were merged by hand (children re-parented onto the
  survivor, then deleted); they held no claims or articles, so nothing was lost.

  The cause is structural: the seeder reads once and inserts what's missing, and
  slug collisions resolve by appending `-2`, so concurrent duplicate inserts
  *succeed silently*. No application-level find-or-create can close that window.
  Migration 008 adds a unique index on `(lower(name), parent)` for active
  topics, turning it into a loud unique violation.

  Unrelated: the remaining `-2` slugs (`reproductive-biology-2`,
  `child-development-2`) are the *live* topics — their same-named predecessors
  are correctly `archived` with `merged_into_id` set. Slugs are frozen and never
  reused, so `-2` there is normal collision handling.
- **`components/SourceEditor.tsx` and `components/TranscriptEditor.tsx` are
  live**, not orphans. They
  are the presentational halves behind `SourceEditorClient` /
  `TranscriptEditorClient`, rendered by `app/sources/[id]/page.tsx`. An import
  scan that only matched single-quoted relative imports missed this.
- **No code references any dropped v1 table.** `insights`, `insight_sources`,
  `insight_concepts`, `concepts`, `concept_connections`, `concept_parents`,
  `source_processing_runs` — all clear as of `ebe3697`.
- **`openai` is imported only by `lib/embeddings.ts`**, matching the claim in
  `CLAUDE.md`.
