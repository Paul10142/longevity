# Repairing Flagged Claims

`scripts/repairFlaggedClaims.ts` fixes claims the fidelity judge quarantined, in place, instead of
re-extracting the library (Paul, 2026-11-08). Code: `lib/claimRepair.ts` (decisions),
`lib/repairRules.ts` (Paul's wording rules, kept apart from `lib/extraction.ts` so the extraction
session's final wording can be adopted by editing one constant), `lib/repairFlags.ts` (flag notes).

## What it does to one claim (keep everything a member supports; split distinct facts)

Paul's hard rules (2026-11-08): a repair must not lose information, and a merged claim that holds several
distinct facts becomes several claims. The judge that flagged a claim only read the seed insight's one passage, so
repairing from that passage alone deleted true content; now a claim keeps everything ANY of its member insights
supports and only what NO member supports may be removed or softened (the old wording stays in `claim_repairs`).

Starts from every open `extraction_fidelity` flag whose claim is `status = 'flagged'`.

1. **Cut into facts** (Opus 5.5). One self-contained sentence per fact, subject restated, hedges, scope, numbers
   and attributions kept inside the fact. A coverage audit checks the cut: every number survives, none is
   invented, and 90% of the claim's wording is in some fact. One retry with the reason, then the claim is cut at
   its sentences instead (`cutAt: 'sentences'`).
2. **Judge each fact against ALL the claim's passages** (the distinct transcript chunks of every member
   insight), most relevant first, with the same judge that flagged it (`lib/extractionFidelity.ts`): the two
   most relevant passages first, then threes, at most 6 calls. `FAITHFUL` against any group = supported, kept.
3. **Edit only a fact no passage supports**, with the smallest edit (rules in `lib/repairRules.ts`): restore a
   dropped hedge or scope, attribute a guess to the speaker, remove only what nothing supports. The edit has to
   pass the judge, a number guard rejects an invented number, and every fact the model removes is searched in
   EVERY passage: if any passage supports it (even with only a qualifier missing, or when the judge is unsure) the
   removal is rejected. The model must account for every word it drops. Two failed tries on a fact leave the
   whole claim hidden, `failed`.
4. **Group the surviving facts into claims** (Opus 5.5, indexes only: no wording changes) and **give every member
   insight to the claim it fits best**. Each member goes to exactly one claim because `claim_members.raw_insight_id`
   is unique; an insight that also fits another resulting claim is listed under "ALSO FITS". A claim never ends
   up without a member insight (a group nobody fits borrows a member from a group with two or more, else is
   folded into the most similar group). The claim with the most members keeps the original claim id.
5. **Check the whole.** Any number that a passage and the old claim both state must survive in some resulting
   claim, or the claim stays hidden (`failed`). Nothing supported at all is `cannot_repair`; a claim that depends
   on the screen is `needs_video`. Those stay hidden with a note on the flag (`NEEDS VIDEO CHECK:` /
   `CANNOT REPAIR:` / `REPAIR FAILED TWICE:`; original detail kept in `evidence.repair.original_detail`).
   If every fact was already supported and they all stay in one group, the claim is a false alarm
   (`canonical_ok`, wording unchanged, flag resolves as `false_positive`).

The dry-run report states, per claim: how many claims it becomes, characters before / after (restating a subject
makes facts a little longer; only the "unsupported content removed" figure is information that left), which fact
went to which claim, and each removed fact with the reason and how many passages were searched.

### Writing a split (needs migration 041)

`--apply` writes a split as ONE database transaction: the function `apply_claim_split` in
`supabase/migrations_v2/041_claim_split_repair.sql`, called through `lib/claimSplit.ts`. Either every row below is
written or none is (a failure rolls the whole split back, so no insight is ever lost or left on two claims).
`--apply` refuses to start until 041 is applied (it probes the function and names the migration).

| Thing | What happens to it |
| --- | --- |
| `claim_repairs` | ONE audit row, written first inside the transaction, on the original claim id: the old wording, the judge's verdict, the per-fact ledger, and a `split` entry mapping each fact and insight to its resulting claim. (Earlier design: one row per resulting claim. Replaced: the table allows one `repaired` row per claim id, and the new column below carries the link.) |
| `claim_members` | `raw_insight_id` is unique, so each insight is MOVED (update `claim_id`) to the claim chosen by `assignMembers`; `matched_by` and `match_confidence` kept. An insight that backs two resulting claims is placed in the better one (shown as ALSO FITS). The function refuses if the plan's member set differs from the claim's current members. |
| `claims` rows | Claim 0 keeps the original id and row (its flag, tags, article references stay valid) with the new, shorter wording. Each other group is a new row (copied `context_note` / `actionability` / `primary_audience` / `insight_type` / qualifiers, status `active`) with the new column `claims.split_from_claim_id` pointing at the original. Aggregates (`member_count`, `source_count`, `max_importance`, best evidence type) are recomputed for every resulting claim inside the function (same rules as `recomputeAggregates`). |
| Embeddings | Computed BEFORE the transaction (a failure there writes nothing); `claim_embeddings` is replaced for claim 0 and created for each new claim from `insightEmbeddingText({statement, context_note})`. |
| Tags | Claim 0 keeps its `claim_topics`; every resulting claim gets `needs_tagging = true` so the normal tagging job files it (tagging is additive, so claim 0 keeps its old topics as well). Claims waiting for tagging are skipped by the fidelity judge, so a repaired claim is not re-flagged before it is tagged. |
| `claim_flags` | The original flag resolves as `reworded` (the gate, `statusAfterResolution`, then makes claim 0 active) and its evidence records the split. New claims start with no flag. |
| Links, articles | No `near_duplicate` links are added between the pieces (deliberate, replacing the earlier design): `lib/novelty.ts` counts a claim with a near-duplicate link as a "refinement", so links between pieces would skew the novelty numbers, and the duplicate review queue no longer exists. Articles that cite the original id still resolve to claim 0; flagged claims are invisible to synthesis (`status = 'active'` filters), so no published article cites a quarantined claim. |

Safety nets:

* **Already repaired:** if a `repaired` / `canonical_ok` audit row exists the function writes nothing and answers `already_applied`, so re-running a claim (even with freshly generated new-claim ids) changes nothing.
* **Changed meanwhile:** if the flag is no longer open, the claim is no longer `flagged`, its wording differs from the one that was judged, or its members changed, the function writes nothing and answers `stale`; the claim is left for the next run.
* **Failed write:** the split plan (new ids, wording, members) is saved to `scratchpad/runs/repair-pending-splits/<claimId>.json` before the write and deleted after it. If the write fails, the plan stays; the next `--apply` retries every saved plan FIRST (same ids, no new model calls), and the run stops with exit code 2 after three write failures in a row. `--stats` shows how many saved splits are waiting.
* **Undo:** the old wording is in `claim_repairs`, and `claims.split_from_claim_id` lists the pieces of any split.

Prove it without writing: `--dry-run` prints, per split, every row operation it would perform (`describeSplit`), and
`--replay <progress.jsonl>` feeds saved dry-run results (no model calls, still read-only) through the same code.

## Order, safety, resuming

Cost: one judge call per fact (more for a fact no passage supports) plus two model calls to cut and group, so a
claim takes a few minutes. Measured on the 20-claim dry run of 2026-11-08: 34.4 minutes (1.72 min per claim) and
305 model calls (15.3 per claim, Opus 5.5 through the Claude subscription), so the full run of 965 claims is about
27 hours and about 14,700 calls. Each written repair adds one small embedding request (OpenAI, a few cents in total).

* Claims with numbers or doses first, then cause-and-effect language, then the rest (`stakesTier`).
* One claim at a time. `sh ~/.claude/usage-guard/check.sh` before every batch (default 5 claims); exit 1 stops
  the run (exit code 3). A usage limit or halted CLI stops it with exit code 2. Re-running the same command
  continues: finished claims are skipped, and a claim whose audit row exists but whose claim row was not
  updated is finished first. A claim is never repaired twice (unique index on `claim_repairs`).
* The default mode is a dry run that writes nothing; `--apply` takes the exclusive writer lock
  (`lib/writerLock.ts`), so it refuses while a supervisor is running.
* Progress: `scratchpad/runs/repair-<stamp>.jsonl` (one JSON line per claim) plus the tee'd
  `repairFlaggedClaims-<stamp>.log`. A dry run also writes `repair-<stamp>-dryrun.md`.

## Commands

```bash
# Read-only counts (no model calls)
npx tsx --env-file=.env.local scripts/repairFlaggedClaims.ts --stats

# Dry run: 20 claims spread across both verdicts and across one-insight / several-insight claims
npx tsx --env-file=.env.local scripts/repairFlaggedClaims.ts --dry-run --limit 20

# Replay a saved dry run through the split writer (no model calls, writes nothing)
npx tsx --env-file=.env.local scripts/repairFlaggedClaims.ts --replay scratchpad/runs/repair-<stamp>-dryrun.jsonl

# Full repair (after migrations 037 and 041 are applied and Paul has approved the run).
# Re-running the same command resumes: saved splits are retried first, finished claims are skipped.
caffeinate -i npx tsx --env-file=.env.local scripts/repairFlaggedClaims.ts --apply

# Redo claims that ended failed / needs_video / cannot_repair / refused
npx tsx --env-file=.env.local scripts/repairFlaggedClaims.ts --apply --retry
```

Review what stays hidden at https://www.lifestyleacademy.health/admin/flags.

## Known limits

* Enrich-merge (`enrichClaimCanonical`) rebuilds a multi-insight claim's wording from its member insights.
  If a new insight is later attached to a repaired claim, that rebuild can bring back the seed insight's
  unfaithful wording, because the insight itself is immutable. The audit table shows which claims to check.
* A fact is judged on its own, so a link BETWEEN two supported facts is not checked; the cut keeps one assertion's two sides together.
* Pieces of a split are independent claims. The corpus sweep (`sweepCorpus`) could later judge two pieces to be duplicates and merge them again; the enrich-merge caveat above applies to them too.
* An insight can belong to one claim only. When a split gives it two homes it goes to the better fit and the other claim keeps the fact without that insight as a source.
* A fact supported only by a passage outside the 17 most relevant (6 judge calls) cannot be proved unsupported,
  so a removal for such a claim is refused and the claim stays hidden for Paul.
