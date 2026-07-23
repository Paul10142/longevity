# Measurement harness (v4 Phase 0)

The instrument that proves the de-duplication engine before anything is built on
it. See `docs/synthesis-v4-spec.md` §6.1 and `docs/v4-build-risks-and-cost.md`
§D Phase 0. This directory holds the harness's inputs and outputs; the code is in
`scripts/evalDedup.ts` and `scripts/evalArticles.ts`.

## Dedup accuracy — the headline

The engine's core job is merging insights into claims. The failure that matters
is a **false merge**: fusing two claims that are not truly identical, which
silently averages away a clinical distinction (dose / population / threshold) no
article score can catch. So the headline metric is the **false-merge rate**.

```
npm run eval:dedup extract        # DB → eval/dedup-eval-pairs.json (needs .env.local)
# → label the pairs into eval/dedup-goldset.json (ground truth; see below)
npx tsx scripts/evalDedup.ts run v1   # baseline: current prompt (no DB; LLM only)
npx tsx scripts/evalDedup.ts run v2   # fixed prompt (§A2)
npx tsx scripts/evalDedup.ts score    # false-merge rate v1 vs v2, recall, κ, threshold
```

`run` and `score` need no database — only the LLM backend
(`LLM_BACKEND=claude-code` uses the local `claude` CLI, no API key). Only
`extract` touches Supabase.

### The gold set is a durable, checked-in asset

`eval/dedup-goldset.json` is the human-labelled ground truth (Paul is the ruler —
labels are grounded in the source `direct_quote`s and the merge rule: *merge only
when materially identical; a dose/population/threshold/timeframe/caveat difference
→ DIFFERENT*). Each entry:

```json
{ "id": "merge:<raw_insight_id>", "label": "SAME|DIFFERENT",
  "confirmed": true, "labeled_by": "paul", "rationale": "…" }
```

`confirmed: false` marks a Claude-proposed label awaiting Paul's sign-off; `score`
flags any run that includes unconfirmed labels as PROVISIONAL.

Beyond the one-time before/after, the gold set is the standing instrument that
lets consolidation eventually run **unattended**: it certifies an automated judge
(the `judge↔human κ` in `score`) and sets the **auto-accept confidence
threshold** — the band above which merges are never wrong on the gold set. Human
review then covers only the uncertain band, so review volume stays flat as the
corpus grows. Keep a small rolling sample labelled per new batch to confirm the
judge still tracks Paul as the corpus diversifies.

## Article quality

A fixed topic set whose metrics are recorded now, so later synthesis changes are
measured, not argued. Also produces the **sentence-level** groundedness baselines
the real floor is re-derived from (the stored scores are paragraph-level; the v4
rewrite scores sentences — spec §8/F5).

```
npm run eval:articles snapshot     # stored groundedness/coverage/length
npm run eval:articles sentences    # sentence-level groundedness audit (Haiku)
```

Generated `*.json` outputs are gitignored; this README and any committed gold set
are not.
