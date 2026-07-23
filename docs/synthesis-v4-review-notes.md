# v4 spec — red-team review notes

**Purpose.** An adversarial self-review of [`synthesis-v4-spec.md`](synthesis-v4-spec.md),
written 2026-07-22 before external review, so reviewers spend their time on the
load-bearing weaknesses rather than re-deriving them. Findings are ranked by how
badly they'd hurt if unaddressed. Each has a concrete failure scenario and a
proposed resolution. None is a reason not to build — several are reasons to
build a specific guard first.

The spec is internally coherent and the core instinct (gate claims upstream,
length follows evidence) is right. These are the places where it is optimistic.

---

## F1 — The review gate is at the wrong layer to catch the worst failure. **(most severe)** — ✅ RESOLVED in spec 2026-07-22

**Resolution applied:** spec §6 now emits a merge-fidelity signal per merged
claim, §7.2 adds rule 2 (merge-fidelity flag), §7.3 adds the source-fidelity
review view (member insights + verbatim quotes beside the canonical statement)
with split/narrow/confirm actions. The gate now catches an unfaithful-but-clear
merge. Original finding below for the record.

---


**The claim.** The spec names consolidation (hop 2) the riskiest, least-policed
step (§3): merging insights can produce a canonical statement none of the
sources said. It then puts the human gate on *claims* (§7). But a **bad merge
produces a claim that reads perfectly well standalone** — it is fluent, clear,
and wrong about what its sources actually support. The standalone-clarity test
(§7.2) is blind to it by construction: clarity and fidelity are different
properties.

**Failure scenario.** Source A: "protein 1.6 g/kg is sufficient for most
adults." Source B: "older adults need up to 2.2 g/kg." The consolidator over-
merges into one claim: "protein needs are 1.6–2.2 g/kg." That claim is clear,
passes the standalone test, gets approved, and enters an article as settled
fact — having erased the population distinction that was the actual clinical
content. No downstream gate catches it, because the article is perfectly
grounded *in the (bad) claim*.

**Why it matters most.** This is the exact failure the product exists to avoid,
and the design's human checkpoint cannot see it. Groundedness measures
prose-vs-claim; it never measures claim-vs-source.

**Resolution.** The review gate needs a **merge-fidelity view**, not just a
standalone-clarity view: when Paul reviews a claim, show the member insights and
their `direct_quote`s beside the canonical statement, so the question he answers
is "does this faithfully represent these sources?" not just "is this clear?" The
dedup-accuracy harness (§6.1) is the automated half of this; the review UI is the
human half. **The standalone test alone is insufficient** — add a flag rule:
"canonical statement asserts a range/qualifier that no single member carried."

---

## F2 — Sentence-level attribution does *not* make the audit mechanical.

**The claim.** §5.2 says typing each sentence `sourced | synthesis | connective`
with `claim_ids` makes groundedness "mechanical rather than an LLM judgement."

**The hole.** The mechanical part — "does every non-connective sentence carry
claim_ids?" — is **trivially gamed by the generator itself.** The model writes
the sentence *and* assigns the ids, so it will attach plausible-looking ids to a
sentence that doesn't actually derive from them, and mark an inferred sentence
`sourced` to avoid the stricter path. The check that a claim_id *is present*
proves nothing. The check that actually matters — does the cited claim *support*
the assertion — is still an LLM semantic judgement. Attribution moves the
judgement; it doesn't remove it.

**Consequence.** The audit cost the spec implies it saves is not saved. Worse, a
gamed `connective` label is an invisible hole: a sentence that asserts a fact but
is typed connective escapes the audit entirely.

**Resolution.** Keep sentence attribution — it earns its place for the block
schema and cross-linking (those are real) — but **stop claiming it makes the
audit mechanical.** The auditor stays semantic and must (a) verify support for
`sourced`/`synthesis` sentences and (b) independently check that `connective`
sentences truly assert nothing. Budget the audit as an LLM pass per article, not
a cheap structural check.

---

## F3 — Conservative merging fights the product's headline metric. — ✅ RESOLVED in spec 2026-07-22

**Resolution applied:** spec §6 now records a `near_duplicate` link when a merge
is blocked by a material difference, and §9.1 redefines novelty into three
buckets — redundant / refinement / novel — so the dedup engine's real work
(exact merges *plus* linked refinements) is counted, not just exact merges.
Original finding below for the record.

---


**The tension.** §6 says merge only when *materially identical*; different dose /
population / caveat blocks the merge. Correct for fidelity. But the marquee B2B
claim is "N% of this source was new" — proof the engine *deduplicates*. If the
merge rule is strict, very little merges, novelty stays high, and the dedup
engine looks like it barely dedupes. The two goals pull opposite ways.

**Second-order effect.** Strict merging also inflates claim count per topic —
pushing toward the high end of the 300–600 range — which worsens F5 (article
readability) and raises build cost.

**Resolution.** Reframe the metric honestly: the product isn't "we delete
redundancy," it's "we organize many sources into one reference and *show you*
what each added." Novelty % should count **near-duplicates that were
consolidated-but-linked**, not only exact merges — otherwise it under-reports the
engine's actual work. Decide this before novelty % is built (it's internal-only,
so lower stakes, but the definition affects how §6 is tuned).

---

## F4 — "Cover every claim exactly once" can produce a complete but unreadable article.

**The scenario.** A 500-claim topic, under "cover every claim exactly once, add
nothing," yields ~500 assertions. That is not padding — every sentence traces to
a claim — but it can read as an exhaustive list, which collides directly with
Paul's "engaging, something people keep reading" requirement. Coverage and
readability are in tension at high claim counts, and the spec resolves it only by
gesturing at "merge closely related claims into the same paragraph."

**The subtlety.** Merging claims *in prose* (one sentence citing five claim_ids)
is the pressure-release valve — but it reintroduces the exact spot where the
model can smuggle in connective substance while blending five claims, and it
makes the sentence-level audit harder (five claims, one sentence: did each get
represented, or did three get dropped?).

**Resolution.** Coverage should be satisfiable by **grouped** representation
(N claims → one well-formed sentence citing all N), and the coverage metric
already supports this (it counts claim_ids present, not sentences). But the spec
must state the rule: a claim is "covered" when its *substance* appears, and the
auditor must check grouped sentences represent *every* cited claim, not just one.
Add a readability ceiling separate from coverage — e.g. a target claims-per-
section that triggers sub-sectioning — so length stays a function of evidence
without becoming a wall of assertions.

---

## F5 — The 0.85 floor was derived from paragraph data; the rewrite scores sentences.

**The inconsistency.** §8 sets the floor at 0.85 and a cap of 2 ungrounded
units. Those numbers were read off the *current* articles, which are scored at
**paragraph** granularity (the table in `BACKLOG.md`). §5.2 moves scoring to
**sentences**. A ratio over sentences is a different, stricter distribution —
many more units, each smaller — so "0.85 of sentences" and "2 ungrounded
sentences" are not the same bars as their paragraph namesakes, and holding the
old numbers is a category error.

**Resolution.** Re-derive both thresholds against sentence-level scores on the
eval set *before* wiring the gate (build step 6 depends on step 0 producing
sentence-level baselines). Treat 0.85 / cap-2 as paragraph-era placeholders to be
replaced with measured sentence-era values. Cheap, but it must happen or the gate
holds the wrong things.

---

## F6 — The standalone test is calibrated to a target flag count, which isn't a principled threshold.

**The concern.** §7.2 tunes the standalone test to fire on ~100–150 of the
existing ~1,000 claims. Fitting a subjective LLM judgement to a desired *count*
risks a threshold that means "the 12% least clear claims" rather than "claims
that are actually unusable" — and that ratio won't generalize as the corpus and
its clarity distribution change. It also costs one LLM call per claim (~20k at
scale) every time it's re-run.

**Resolution.** Anchor the test to a *definition* Paul validates on a sample
(the standalone rubric in §7.2), then observe the resulting count — don't tune to
hit a count. If the definition yields far more than Paul can review, tighten the
*definition* (e.g. "missing a dose/population that a clinician would need to
act", not "could be clearer"), and record why. Run it incrementally per new
source, not corpus-wide each time.

---

## F7 — Admin-only synthesis marks are in tension with "every statement traces to source."

**The issue.** Paul chose (deliberately) to hide `synthesis`/inference marks from
readers (§5.4). So a physician cannot distinguish a directly-sourced sentence
from a model-bridged inference, and will trust both equally. For a product whose
entire pitch is traceability, presenting inference as indistinguishable from
sourced fact is a defensible product call but a real trust exposure — the one
place the reader is asked to trust the model's reasoning, invisibly.

**Not a re-ask** — Paul decided this. Flagged so the external reviewers weigh it
with eyes open. **Mitigation if it bites later:** the data supports a
reader-facing "show provenance" toggle (§5.2 stores the marks), so this is
reversible without a schema change. Lowest-risk path: ship admin-only, keep the
toggle one flag away.

---

## F8 — Everything still builds against production, and the blast radius just grew.

**The context.** No staging DB, no test harness at the start (both noted in
`BACKLOG.md`). v4 adds migrations for claim status, a glossary table, and the
sentence-level article schema — all against the live database that already got
its spine split once by a concurrent script.

**Resolution.** Not necessarily a staging DB (cost/friction for solo work), but
build step 0 should include the test harness for the pure functions the rewrite
touches (`outlineToMarkdown`, the new block renderer, coverage/groundedness
math), and every migration in steps 1–5 must be dry-run-and-verify per the
`CLAUDE.md` rule. The claim-status migration is the dangerous one — a wrong
`UPDATE` could quarantine the whole corpus out of synthesis. Gate it behind a
count-before/count-after check.

---

## What holds up well

- The upstream gate (claims before articles) genuinely designs out the
  edit-a-claim-an-article-depends-on cascade. That's a clean piece of design.
- "Length follows evidence" + the min-claims gate is the correct root-cause fix
  for padding, not a band-aid.
- Leaving old articles live during migration (§10) is the low-risk call and needs
  no dual-render because the site reads `body_markdown`.
- The measurement-harness-first ordering is exactly right, and F1/F5 both depend
  on it — which is further reason step 0 is non-negotiable.

## Net

**F1 and F3 are now resolved in the spec** (merge-fidelity gate + honest novelty
buckets). The spec is buildable as written. Remaining open items for the external
review to weigh: **F2** (don't over-claim that attribution makes the audit cheap
— it doesn't) and **F4/F5** (state the coverage-vs-readability rule and re-derive
the floor for sentence granularity) are "make the rule precise so the builder
doesn't guess"; **F7** (admin-only synthesis marks) is a product-framing call
Paul has made with eyes open, reversible via a stored toggle; **F8** (production
blast radius) is a build-discipline item the harness and dry-run rules cover.

Status: F1 ✅, F3 ✅, F2/F4/F5/F6 open-precise, F7 accepted-with-mitigation,
F8 process.
