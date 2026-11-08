# Repairing Flagged Claims

`scripts/repairFlaggedClaims.ts` fixes claims the fidelity judge quarantined, in place, instead of
re-extracting the library (Paul, 2026-11-08). Code: `lib/claimRepair.ts` (decisions),
`lib/repairRules.ts` (Paul's wording rules, kept apart from `lib/extraction.ts` so the extraction
session's final wording can be adopted by editing one constant), `lib/repairFlags.ts` (flag notes).

## What it does to one claim

Starts from every open `extraction_fidelity` flag whose claim is `status = 'flagged'`.

1. **Current wording already passes?** Only for claims with several insights whose wording differs from
   the seed insight: the flag was raised on the seed insight, so enrichment may already have fixed the
   claim. Judge it against the seed passage; `FAITHFUL` means keep the wording, resolve the flag
   (`false_positive`), claim goes back to `active`. Outcome `canonical_ok`.
2. **Another insight supports the claim.** The judge only ever read the seed passage. Each other member's
   own statement (closest to the claim's wording first, at most 3) is judged against its own passage;
   the first `FAITHFUL` one is adopted verbatim. No model wrote it. Outcome `repaired`, source `member`.
3. **Rewrite.** Opus 5.5 (`lib/llm.ts`, `LLM_BACKEND=claude-code`) rewrites the claim from the failing
   passage under `REPAIR_RULES`, given the judge's verdict, offending phrase and reasoning. A guard rejects a
   rewrite that states a number the passage never says (the guard's only grounding is the passage), then the
   same judge (`lib/extractionFidelity.ts`) re-reads it. Pass means `repaired`, source `rewrite`. A failed
   rewrite is retried once with the rejection reason; two failures mean `failed` and the claim stays hidden.
4. The model may instead answer `needs_video` (depends on something shown on screen) or `cannot_repair`
   (no supportable version). The claim stays hidden and its flag gets a `NEEDS VIDEO CHECK:` /
   `CANNOT REPAIR:` / `REPAIR FAILED TWICE:` prefix on `detail`, the original detail kept in
   `evidence.repair.original_detail`. `needs_video` also sets `needs_video_check_at` when migration 036
   (the review screen's list) is applied.

A repaired claim: the old wording goes into `claim_repairs` first, then `claims.canonical_statement` and
`claim_embeddings` are updated, the flag resolves as `reworded`, and the gate puts the claim back
(`statusAfterResolution`, which now treats `reworded` like `false_positive`). `needs_tagging` is left alone:
the topic filing was made on the longer wording and a narrower claim still belongs where it is.
`raw_insights` are never touched.

## Order, safety, resuming

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
* A rewrite is anchored on the seed passage only, so a several-insight claim can come out narrower than
  its enriched wording. That is the price of a sentence the judge can check against one passage.
