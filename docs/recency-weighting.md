# Recency weighting — what shipped, and the decision that's left

**Paul's request (2026-07-28):** "If two sources conflict, the more recent one
should carry more weight — especially if it's the same author. Knowledge and
opinions update over time, so a newer claim should outrank an older one."

There are two distinct mechanisms hiding in that sentence, and they have very
different risk profiles. One shipped tonight; the other needs a decision from you.

---

## 1. Shipped — recency as an always-on scoring signal (safe, reversible, live)

**Migration `015_recency_scoring.sql`** adds a bounded recency bonus to the
`topic_claims()` composite score — the single formula that orders claims for
every article and for the public Evidence tab. Within a topic, the newer of two
otherwise-comparable claims now surfaces first.

- **A claim's recency** = the newest `sources.date` across its member insights
  (`claim_members → raw_insights → sources.date`).
- **Bonus curve:** `0..8` points, decaying ≈1.5 pts/yr, reaching 0 at ~5.3 years.
  Newest content = +8; a 1-year-old claim = +6.5; a 3-year-old = +3.5.
- **Why bounded at 8:** the other score terms are importance (≤30), actionability
  (5–15), evidence (0–15), corroboration (≤10). Eight points make recency a
  meaningful tiebreak among similar claims **without** letting a fresh expert
  aside leapfrog a well-corroborated older RCT. The weight is a single constant in
  the migration — tune it if you want recency to matter more or less.
- **Reversible & inert:** no rows changed; re-apply the pre-015 body to revert.
  Articles aren't regenerated tonight, so the only reader-visible effect today is
  the Evidence tab listing newer claims slightly higher.

**Prerequisite that also shipped — the date backfill.** Recency is worthless if
sources have no date, and **13 of 18 sources had `date = NULL`** (every episode
ingested on 2026-07-24 — i.e. the *newest* content, which recency most needs to
recognize). Those 13 were backfilled from their YouTube upload dates (via
`yt-dlp`), so **all 18 sources are now dated** and recency coverage jumped from
24% → ~100% of active claims. Newly-ingested back-catalog episodes carry their
air date from the Notion CSV; a post-ingest backfill covers any the transcript
API returns null for.

---

## 2. NOT shipped — "prefer the newer of two CONTRADICTING claims" (needs your call)

This is the literal reading of your example ("X causes Y" vs "Y causes X"), and
it is a genuinely different operation: a **pairwise tiebreak on conflict**, not a
global ranking nudge. It can't ship safely tonight because the machinery it needs
is designed-but-not-built:

1. **Contradictions aren't detected yet.** The live adjudicator (`ADJUDICATION_V3`)
   collapses "genuine contradiction" and "unrelated fact" into a single
   `DIFFERENT` verdict, and consolidation writes every `DIFFERENT` ANN-pair as
   `claim_links.kind = 'near_duplicate'`. So there are **0 `contradicts` links** in
   the corpus — nothing to apply a tiebreak to. The `contradicts` link kind and a
   `contradiction` flag rule already exist as schema (migration 013); they're
   groundwork with no producer.
2. **The "same author" boost is degenerate in this corpus.** Every source is Peter
   Attia, so an author-match term would fire on essentially every pair and change
   no ordering. It only starts to discriminate once the corpus holds other
   authors' content — at which point "same author, newer date" is the strong
   signal (the same person revising their own view), and "different author" is a
   genuine disagreement to keep as contested, not silently down-weight.

### Proposed build (additive; gated on your approval)

- **(a)** Add a `contradiction` boolean to the adjudicator's JSON so a `DIFFERENT`
  verdict splits into *contradiction* vs *unrelated*. Additive to the prompt +
  parser; existing behavior unchanged when the flag is false.
- **(b)** When that flag is set, write `claim_links.kind = 'contradicts'` (new
  `linkContradiction`) instead of `near_duplicate`. New links only; nothing
  existing is rewritten.
- **(c)** A pairwise tiebreak: on a `contradicts` link, the claim on the newer
  side gets a scoring bonus, **larger when the two claims share an author**. The
  article then leads with the newer position and labels the pair "points of
  debate" (the §7 contested treatment), rather than asserting one silently.

### The decision only you can make

Steps (a) and (b) are safe, additive code. What needs your sign-off is **(d) —
re-running consolidation over the existing corpus to populate `contradicts`
links.** That's an LLM re-adjudication pass (subscription-billed, ~hours on the
CLI), i.e. exactly the "reprocess is gated" rule in `CLAUDE.md`. Nothing forces
it: new contradictions would accrue naturally as future sources are consolidated
under the new adjudicator. So the choice is:

1. **Build (a)–(c) now, let contradictions accrue going forward only** — zero
   reprocess cost, but the existing 2,450 claims stay un-checked for contradiction.
2. **Build (a)–(c) + approve the (d) reprocess** — full contradiction coverage of
   the current corpus, at the cost of a gated re-adjudication run.
3. **Ship only the §1 recency signal** (done) and treat the contradiction tiebreak
   as a later phase.

My recommendation: **option 1** now (safe, forward-looking, no reprocess), and
fold the (d) reprocess into the next deliberate corpus pass if contradiction
coverage of the back-catalog proves valuable once more sources are in. The §1
recency signal already delivers the intuitive "newer ranks higher" behavior for
the common case; the contradiction tiebreak is the sharp instrument for the rarer
true-conflict case, and it's worth building once the corpus is multi-author.
