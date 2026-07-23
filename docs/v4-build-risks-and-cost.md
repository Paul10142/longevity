# v4 Build — Risks, Edge Cases, and Cost

**Purpose.** The guiding document for *what to build next and in what order*. It
sits on top of [`synthesis-v4-spec.md`](synthesis-v4-spec.md) (what to build) and
`ARCHITECTURE.md` (the enduring design). Written 2026-07-22 after a full re-read
of both against the live code and database. Every finding here is grounded in a
specific file/line or a measured number, not a hunch.

Three things it does: (A) names where the docs now contradict each other and the
code, (B) lists the edge cases and failure modes that could sink the plan, ranked,
(C) ranks the cost levers — including three the current cost model misses. It ends
(D) with a revised build sequence that resolves the ordering traps, and (E) names
three **strategic risks that sit above the build** — the ones that decide whether
the whole venture works, which the rest of this doc set is silent on.

---

## E. Strategic risks above the build (added 2026-07-22)

The A–D findings are about building the thing right. These three are about whether
the thing should be built the way it is — surfaced in a zoom-out review of the
whole plan against the Lifestyle Academy mission. None is an engineering bug; each
could sink the product regardless of how well the engine works.

### E1. Content rights — SHELVED for now (Paul, 2026-07-23).

The corpus is largely one creator's copyrighted transcripts, and reselling
derived works commercially would be a real legal question (bigger than the image
note in spec §10). **Paul's call: not a concern now** — the product is *internal /
educational* (to teach himself and other physicians), not a commercial entity.
Left recorded, not deleted: **selling is the trigger.** If this ever becomes a
sold product, revisit before launch — a license, explicit permission, a
defensible transformation position, or commercial-reuse-friendly sources. Until
then, no action.

### E2. No customer-validation checkpoint — heavy build before any physician reacts.

Principle 4 ("prove on a little") is currently interpreted only as *proving the
engine* (the measurement harness). It does not yet mean *proving the product*: no
step puts real clinician articles in front of a real physician before Phase 4's
$2–5k full build. The entire plan builds the engine, then scales, on the
assumption that a claim-complete deduplicated reference is what a physician will
pay for — an assumption never tested with a buyer.

**Recommended checkpoint (added to §D):** after Phase 3 produces the first handful
of gate-passing v4 clinician articles, put them in front of 2–3 practicing
physicians and ask the only question that matters — *would you trust and use
this?* — **before** the full build. Cheap insurance on the largest single spend,
and the most mission-aligned reading of "prove on a little."

### E3. Authority = named guest experts, not source repetition (resolved 2026-07-23).

Original concern: the corpus is predominantly one *voice* (Attia), so deriving the
consensus dimension from `source_count` would measure him repeating himself, not
field agreement — labelling a claim "established" because one person said it ten
times. **Resolved by Paul's clarification:** each episode's *guest* is the domain
expert (Turek, Allison, Hooven…), and Attia is the interviewer. So:

- **Authority comes from the credentialed guest expert**, modelled as a
  first-class credibility layer (spec §5.5), and **`source_count` is retired as an
  authority signal.** "Established" is gated on credentialed-expert support +
  `authority_tier` + primary references — never on repetition.
- **The corpus will diversify** beyond Attia (Paul adding other sources), further
  weakening any single-voice effect.
- **Still true and still the weakest link:** the primary-literature reference is
  what ultimately earns physician trust, and resolution works ~5% today
  (`BACKLOG.md` P2). Fixing it is a prerequisite for the consensus feature to mean
  anything — already in the sequence.

Net: revise the v3.1 consensus design to key off experts + references, not
`source_count`, before that feature is built (ARCHITECTURE.md §Consensus is
annotated to match).

---

## A. Contradictions to reconcile first

These are places where following one document breaks another. They are cheap to
fix (mostly doc edits + one prompt change) and dangerous to leave, because the
execution agent will trust whichever it reads first.

### A1. The architecture still endorses the padding v4 exists to kill. **(must fix)**

`ARCHITECTURE.md` §v3.1 (lines 304–318) is the canonical target: *"exhaustive,
claim-complete reference… No word limit… No source cap."* The v4 spec's entire
thesis is that this instruction **is the cause** of the padding — on a thin topic
the model writes to "exhaustive / no limit" and fills the gap with outside
knowledge (AMPK: 0.40 groundedness).

They are reconcilable but only if stated precisely: **"cover every claim"
(coverage = 1.0) is kept; "write exhaustively / no word limit" is deleted.**
Claim-complete, not prose-maximal. Until §v3.1 is annotated as superseded by the
v4 spec on this exact point, the two guiding docs give opposite instructions.

**Action:** mark ARCHITECTURE §v3.1's "no caps / exhaustive" language as
superseded; point to spec §2 and §5.1.

### A2. The consolidation prompt instructs the exact false merge F1 warns about. **(highest-leverage code change)**

Not a risk — a live instruction. `lib/consolidation.ts:56`:

> "Same claim means the same substantive assertion… even if worded differently,
> **at a different level of detail**, or with different examples."

So the adjudicator is told that "protein 1.6 g/kg for adults" and "2.2 g/kg for
older adults" are the SAME claim (different level of detail), and merges them —
producing the nuance-destroying blend the whole product exists to prevent. The
v4 merge-fidelity rule (spec §6, §7.2 rule 2) is downstream cleanup for a prompt
that is actively causing the problem upstream.

**Action:** this is the single most important code change in the v4 work, and it
is small. Rewrite the adjudication prompt so a **material difference in dose,
population, threshold, timeframe, or caveat → DIFFERENT** (kept separate, linked
as `near_duplicate` per spec §6). "Different level of detail" stops being grounds
for SAME. Do this *before* re-consolidating anything, or every merge inherits the
old rule.

### A3. Stale model reference: the adjudicator is Opus, not "gpt-5-mini."

`ARCHITECTURE.md:200` says *"Adjudicator (gpt-5-mini)."* The code
(`lib/consolidation.ts:21`, `CLAUDE_JUDGMENT_MODEL`) uses **Opus 4.8**. This
matters for cost (§C3): the corpus runs ~46k Opus adjudications, not mini ones.
Fix the line so the cost model is trusted.

### A4. The cost model predates both v4 and the real scale.

`ARCHITECTURE.md` §Cost model: full build *"≈ $400–600,"* *"ingestion is
trivial ~$0.15/source."* Both are small-corpus artifacts:
- "Ingestion trivial" ignores that consolidation is **one Opus call per raw
  insight** — ~46k calls at target scale (§C3), a cost comparable to synthesis,
  not a rounding error.
- The $400–600 is for 133 topics on the *old* synthesis. Target scale is ~$2–5k
  (spec §4), and v4 *adds* a per-article semantic audit (§C2).

**Action:** replace the cost model's headline with the spec §4 figures and add
the consolidation line.

---

## B. Edge cases & failure modes (ranked by damage)

### B1. Re-extracting for `start_ms` destroys any claim review already done. **(severe — ordering trap)**

`raw_insights.start_ms` is null on all 1,072 rows; capturing it means
re-extraction (backlog P2). **Re-extraction deletes and rebuilds chunks**
(`lib/extraction.ts:281`), which own `raw_insights`, which own `claims` via
`claim_members`. So re-extracting the 5 existing sources throws away the current
claims — and with them any v4 flagging, approval, and merge-fidelity review done
in spec build steps 2–4.

**The trap:** the v4 build order (steps 2–4) reviews claims; the backlog puts
`start_ms` in Stage 1. If `start_ms` re-extraction runs *after* the review, the
review is wasted. **`start_ms` must be captured before the existing corpus is
reviewed, or accept that the 5 seed sources ship without timestamps and only new
ingests get them.** This is a real fork; §D resolves it.

### B2. v4's strict merging quietly raises steady-state cost. **(severe — cost interaction)**

v3.2's incremental model (ARCHITECTURE §v3.2) rests on *"reinforcing-only sources
cost ~$0"* — a source whose insights are all SAME verdicts triggers no prose
regen. But v4's merge rule (A2) makes far fewer things SAME: a new dose or
population is now DIFFERENT (a new claim), not reinforcing. So more sources cross
into "new claim → section regen," and the ~$0 common case erodes. Strict merging
is correct for fidelity, but it **shifts the cost model** — more claims per topic
(pushing the 300–600 range up) and more incremental regens. Budget for it; don't
assume v3.2's cheap-steady-state still holds.

### B3. 300–600 claims/topic collides with the topic-split mechanism. **(design decision needed)**

ARCHITECTURE §v3.2 "Topic split" proposes splitting a topic when its claims form
≥2 clusters — at 300–600 claims/leaf, *most* topics will trip that. But the
taxonomy is a deliberately-bounded curated spine (~40–60 leaves = Attia's own
structure). Splitting to relieve size **proliferates the tree beyond the curated
shape** and fights the spec's answer, which is in-article sub-sectioning (spec
§5.1, F4). These two mechanisms pull opposite ways on the same trigger.

**Decision:** at target scale, prefer **in-article sub-sectioning over topic
splitting** to preserve the Attia-shaped tree; reserve splits for genuinely
distinct subjects wrongly filed together, not for size alone. Retune the split
trigger from "size / cluster count" to "semantic distinctness," or it will
dismantle the curated spine.

### B4. Four review queues, one reviewer. **(operational)**

Paul is the sole reviewer, and the design now has **four** human queues:
`merge_reviews` (consolidation UNSURE), the v4 flagged-claims queue (spec §7),
the contradiction-review queue (ARCHITECTURE §v3.2), and `topic_proposals`. Each
was designed in isolation. At 200-podcast scale this is four inboxes to check.

**Action:** unify into **one review inbox** with typed items (merge / clarity /
fidelity / contradiction / new-topic), one queue to work top-down. Cheap if done
before the v4 review UI is built (spec §7.3 / §D Phase 2); expensive to retrofit after.

### B5. Vercel Hobby throttles the breadth ingest to a crawl. **(precondition)**

Hobby caps `maxDuration` at 60s and cron at once/day (ARCHITECTURE lines 176–185),
while the worker assumes 300s. Extracting a 73-chunk Attia episode plus ~230
consolidations, on 60s fire-and-forget ticks that must checkpoint-resume, means
ingesting 200 podcasts is painfully slow and leans on the daily safety-net cron.
**Vercel Pro (300s + sub-daily cron) is a practical precondition for Stage 3
breadth ingest**, not just a nice-to-have. Budget the plan upgrade into the
sequence.

### B6. The groundedness audit is a single call over the whole article. **(scale)**

`scoreGroundedness` (`lib/synthesis.ts:332`) flattens every paragraph into one
LLM call. At 300–600 claims → 200–400 sentences, that single call gets large
enough to degrade or truncate — exactly on the biggest, highest-stakes articles.
The v4 sentence-level audit (F2) makes the payload larger still.

**Action:** the v4 audit must run **per section**, not per whole article, and
aggregate. Fits the sectioned model already in place.

### B7. Near-duplicates are high-similarity, so the ANN floor never filters them. **(why F1 is load-bearing)**

A tempting mitigation for false merges is "raise the ANN candidate floor." It
does not help: two claims differing only in dose are ~identical in embedding
space (same words, same topic), so they sit at the *top* of the candidate list.
The ANN stage cannot distinguish them; **only the adjudicator can**, and today's
prompt (A2) is tuned to merge them. This is why the fix is the prompt + the
merge-fidelity gate, not a threshold.

---

## C. Cost minimization (ranked; ★ = missed by the current cost model)

### C1. Batch API — 50% off. (already the #1 lever)
For the one-time full build *and* the bulk re-extraction/re-consolidation of the
corpus. Neither is latency-sensitive. Applies to spec §4's $2–5k directly.

### C2. ★ Run the groundedness / fidelity audit on Haiku, not Opus.
The audit is mechanical verification, not prose — ARCHITECTURE §v3.2 itself lists
it as a valid cost-lever target. But the code runs it on **Opus**
(`lib/synthesis.ts:349`, `CLAUDE_MODEL`). Moving the audit (and the F2 per-section
audit) to Haiku 4.5 cuts a recurring per-article cost ~5× with no prose-quality
impact. Pure win; the guardrail stays, it just costs less to enforce.

### C3. ★ Two-tier consolidation adjudication.
Consolidation is ~46k Opus calls at target scale (§A4) — a major, currently
uncounted cost. Most are easy (clearly SAME or clearly DIFFERENT). **Route the
clear-cut cases to Haiku and reserve Opus for borderline / high-similarity
pairs** (the ones where fidelity actually matters). Because v4 needs a *more*
discriminating adjudicator for fidelity, this also concentrates the expensive
model exactly where the fidelity decision is hard. Potentially the largest single
saving at scale.

### C4. ★ Prompt-cache the adjudication system prompt.
The same ~300-token adjudication prompt is re-sent on all ~46k calls; only the
candidates vary. Caching the system prefix is a direct, mechanical saving on the
highest-volume LLM path. Same lever applies to the ~30 calls/topic in synthesis.

### C5. Incremental updates (v3.2, built) — with the B2 caveat.
Still the right default, but strict merging (B2) reduces how often it hits the
free "reinforcing-only" path. Real, smaller than the architecture claims.

### C6. Decide `start_ms` re-extraction once, deliberately (§B1).
Re-extracting the whole corpus is the costliest single ingest action. Do it
**once**, up front, batched (C1), before claim review — not piecemeal later.
The cost is unavoidable if timestamps are wanted on the seed corpus; the waste is
avoidable by sequencing it right.

---

## D. The revised sequence — what to work on next

This supersedes the stage ordering where it conflicts, and resolves B1/B5/A2.
Rationale: **do the cheap high-leverage corrections first, capture `start_ms`
before any review so review isn't thrown away, and gate the breadth ingest on
Pro.**

**Phase 0 — corrections & instrument (cheap, unblocks everything).** Ordered so
the merge-prompt fix's effect is *measurable*, not assumed:
1. **Labelled ground-truth eval set** (spec §6.1): Paul labels a sample of the
   consolidator's merge decisions (SAME/DIFFERENT). This is the ruler, and it must
   exist before the prompt changes.
2. **Baseline the current adjudication prompt** against that set — record today's
   false-merge rate.
3. **Fix the adjudication prompt** (A2) — material difference → DIFFERENT — and
   re-measure. The single highest-leverage change; the before/after on the same
   eval set proves it helped. Everything consolidated afterward inherits it.
4. **Finish the harness** (spec §6.1): the article eval set (~5 topics, current
   groundedness/coverage/length + sentence-level baselines), audit moved to Haiku
   (C2).
5. **The two independent fixes**, any time in Phase 0: `catch { return 1 }` →
   `null` (spec §8); verify the doc reconciliations (A1/A3/A4) still hold in-repo.

**Phase 0.5 — reshape the taxonomy to the 10-branch frontier tree** (before any
re-tagging, so claims file into the new tree). Target and mapping in the
proposed-taxonomy memory: **6 pillars** (Exercise, Nutrition, Sleep, Meds &
Supplements, Mental Health & Cognition, Reducing Risks) + **4 clinical/context**
(Reproductive & Hormonal Health, Healthy Aging, Research & Evidence, Public Health
& Policy). Mostly renames (Mental Health & Psychology → Mental Health & Cognition;
Risks → Reducing Risks, with the chronic diseases as its sub-branches; Sexual &
Reproductive Health → Reproductive & Hormonal Health). **Plus subtopic
consolidation** — fold the over-granular micro-topics (Sperm Chemotaxis,
Blood-Testis Barrier, Bicycle Saddle Ergonomics…) into their general parent so
they become article bullets, not nodes. Same mechanics as the 2026-07-22 reshape:
edit `scripts/seedSpine.ts` SPINE → dry-run → apply → archive retired branches
with `merged_into_id`. Must precede Phase 2 tagging. **Also bias the tagger prompt
toward general topics first** (`BACKLOG.md` P2 — subtopics auto-create then land
in an approve/deny queue; the generality bias is what keeps that queue short) or
re-tagging re-fragments the tree.

**Phase 1 — re-process the seed corpus ONCE (resolves B1).**

Corrected 2026-07-22 after checking the data: of the 5 seed sources, **only the
one YouTube video can gain timestamps.** The other four are *manually-pasted*
plain-text transcripts (`transcript_origin = 'manual'`) with no timing to
recover, and the article never had any. So Phase 1 splits:

- **Timestamp demonstration — the one YouTube source.** "Dr. Peter Attia —
  NON-NEGOTIABLES" (`youtube.com/watch?v=s-qapZuy0GY`). The path, end to end:
  - **Stop discarding the timing.** The YouTube Transcript API already returns
    each segment as `{ text, start, duration }`; our fetch route
    (`app/api/admin/sources/fetch-youtube-transcript/route.ts:109-111`) currently
    maps to `segment.text` and joins, throwing `start`/`duration` away. Preserve
    the timed segments.
  - **Carry the clock through.** Chunking assigns each chunk a `start_ms`/`end_ms`
    from its segments (the `chunks` columns already exist); extraction copies the
    chunk's `start_ms` onto each `raw_insight` (that column exists too).
  - **Deep-link at the reader.** An Evidence citation renders
    `source.url + &t=<seconds>` — one click from a claim to the moment in the
    video. This is the visible proof.
  - Re-extract → re-consolidate *this source only*, under the new merge prompt.
  - **Transcript hygiene is part of this step, not optional** (see box below).
- **The other four sources: re-consolidate, do not re-extract.** They gain
  nothing from re-extraction (no timing), so keep their existing `raw_insights`
  and only re-run consolidation under the *new* adjudication prompt (fixed in
  Phase 0), with the dedup-accuracy harness watching false-merge rate. First real
  test of the fidelity rule; do it before human review so review lands on shipping
  claims.

> **Transcript hygiene — a trust filter, not tidiness (permanent ingestion rule).**
> YouTube captions carry cold-open hype clips, **sponsor reads/ad breaks**, and
> subscribe/outro segments. Extraction cannot tell a sponsor read
> ("brought to you by AG1, which supports gut health") from a clinical statement,
> so left in, an ad becomes a *claim* and pollutes the one source of truth with
> advertising presented as medical guidance — a direct principle-1 violation.
> **Every ingested transcript (paste or YouTube) must pass a hygiene step that
> strips intro/outro/sponsor/ad segments before chunking.** Likely a cheap
> per-transcript LLM pass (Haiku) that marks and removes non-content spans;
> conservative — when unsure, keep, and surface for review rather than delete
> silently. Build it with the timestamp step, since both touch ingestion, and it
> applies to all future uploads Paul does directly.

**Phase 2 — the claim gate (spec §7, now on the re-consolidated claims).**
- Claim status lifecycle + `near_duplicate` link table, then **bulk-approve** the
  re-consolidated claims — this runs here, *after* Phase 1 re-consolidation, never
  on today's claims (spec §7.4).
- Flagging (four rules incl. merge-fidelity) over the re-consolidated corpus.
- **One** unified review inbox (B4), not four queues. Validate the standalone
  rubric on ~30 claims (spec §7.2) here.

**Phase 3 — synthesis rewrite (spec §5, §8, §10).**
- Sentence-level block schema + renderer; per-section audit (B6).
- Rewrite clinician + protocol prompts (length-follows-evidence, glossary-only,
  no source narration); re-derive the floor on sentence scores (spec F5);
  prompt-cache the shared prompts (C4).
- **Protocol-led delivery** (spec §2, §10): the protocol is the reader's front
  door, the reference is depth-on-demand. Reorder the read-side surfaces.
- **Experts credibility layer** (spec §5.5): `experts` table + claim↔expert
  links (derived from member insights' source guests); the guest is captured at
  ingest/extraction (`sources.authors` is the hook — do the capture back in
  Phase 1's re-extraction and for all future ingests); surface as an article
  byline + in the Evidence panel; retire `source_count` as the authority signal.
- Prefer in-article sub-sectioning over topic split (B3); retune the split
  trigger to distinctness.

**⛳ Checkpoint before Phase 4 — Paul's explicit gate (2026-07-23).** Between
Phase 3 and Phase 4, **stop and do two things before spending tokens on the full
build:**
1. **Build the cost infrastructure first** (Paul's instruction): the levers in §C
   are not "apply later" — they are built *here*, before the run. Batch API path
   (C1), two-tier adjudication (C3), audit-on-Haiku (C2, if not already), prompt
   caching (C4), and a **spend cap** (B-series gap). Reduce the per-run cost
   *before* running it at scale.
2. **Validate the product** (E2): Paul is the reviewing physician; look at the
   first gate-passing v4 clinician articles + protocols and confirm they're worth
   scaling. A "no" here is worth more than a polished library nobody wanted.

**Phase 4 — scale out (only after the gate).**
- Upgrade to Vercel Pro (B5) — precondition for breadth.
- Ingest breadth — **pillar-driven** (Exercise, Nutrition, Sleep, Cognition,
  etc.), diversifying beyond Attia; two-tier adjudication (C3) live.
- The one budgeted full build, Batch API (C1). Cross-linking + novelty buckets
  (spec §9) as the review-and-proof layer.
- Consensus labelling (v3.1) — gate "established" on credentialed-expert support
  (spec §5.5) + primary references, **not** `source_count` (E3).
