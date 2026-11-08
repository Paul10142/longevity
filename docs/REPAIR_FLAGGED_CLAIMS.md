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

### Writing a split (not enabled yet: waits for Paul's go on this design)

`--apply` writes single-claim repairs only; a claim that would split is reported and left hidden (picked up again
later). What a split must do, in one transaction-like sequence, with the old wording saved first in `claim_repairs`:

| Thing | What happens to it |
| --- | --- |
| `claim_members` | `raw_insight_id` is unique, so each insight is MOVED (update `claim_id`) to the claim chosen by `assignMembers`; `matched_by` kept. An insight that backs two resulting claims is placed in the better one (shown as ALSO FITS). Backing both would need a schema change (a second link table, or relaxing the unique key, which consolidation, `reconcile_claim_membership()` and the aggregates all assume). |
| `claims` rows | Claim 0 keeps the original id and row (its flag, tags, article references stay valid). Each other group is a new row (`needs_tagging = true`, copied `context_note` / qualifiers, status `active`). Aggregates (`member_count`, `source_count`, `max_importance`, evidence type) are recomputed for every resulting claim with `recomputeAggregates`. |
| Embeddings | `claim_embeddings` is refreshed for claim 0 and created for each new claim from `insightEmbeddingText({statement, context_note})` (a new claim whose embedding fails is deleted, as in consolidation). |
| Tags | Claim 0 keeps its `claim_topics`; new claims have `needs_tagging = true` so the normal `tag_claims` job files them. Because claim 0's wording shrank, set `needs_tagging = true` there too so its topics are re-judged. |
| `claim_flags` | The original flag resolves as `reworded` (the gate, `statusAfterResolution`, then sets claim 0 active; the resolution `split` would not restore it) and its evidence records the split. New claims start with no flag. |
| Links, articles | `near_duplicate` links between the siblings are added so the review queue does not offer them as new duplicates. Articles that cite the original id still resolve to claim 0; flagged claims are invisible to synthesis (`status = 'active'` filters), so no published article cites a quarantined claim. |
| `claim_repairs` | One audit row per resulting claim, all pointing at the original id and run. |

## Order, safety, resuming

Cost: one judge call per fact (more for a fact no passage supports) plus two model calls to cut and group, so a
claim takes a few minutes; read the dry-run timing before estimating the full run.

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

# Full repair (after migration 037 is applied and Paul has approved the dry run)
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
* An insight can belong to one claim only. When a split gives it two homes it goes to the better fit and the other claim keeps the fact without that insight as a source.
* A fact supported only by a passage outside the 17 most relevant (6 judge calls) cannot be proved unsupported,
  so a removal for such a claim is refused and the claim stays hidden for Paul.
