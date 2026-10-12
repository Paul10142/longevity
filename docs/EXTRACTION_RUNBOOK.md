# Extraction runbook — the RUNNER window

Standing instructions. Paul opens a window and says **"proceed with extraction"**
(also: "continue extraction", "check the overnight run", "start the run"). A
window that hears this follows this file and needs nothing else pasted in.

## The two-window rule (Paul, 2026-10-12)

- **One window is the RUNNER.** It starts the pipeline, watches it, restarts it
  within the limits below, and reports. It processes in the background — day or
  night — and does nothing else.
- **The runner never edits code.** Anything that needs a change (a bug, a new
  rule, a model change, a supervisor fix) becomes a **separate window** via
  `spawn_task`, with a self-contained prompt (file paths, evidence, the decision
  Paul made). The runner then carries on. Paul clicks the chip when he wants it
  worked.
- Code windows must not merge to `main` while a run is live (the running process
  loaded its code at start; a restart would pick up the new code mid-night).
  Say so in every spawned prompt. Merge after the run ends, or between runs.
- Never two runs at once. The writer lock (`~/.lifestyle-academy-writer.lock`)
  enforces it.

## 1. Pre-flight (read-only)

1. `ls -la ~/.lifestyle-academy-writer.lock` — absent, or older than 15 min
   with no live process.
2. `pgrep -fl 'extractDeepgram|overnightExtract|retireSourceClaims|repairDeepgramTiming|transcribeDeepgram'`
   — must be empty. If a writer is live: stop, tell Paul, do not kill it.
3. Database reachable from this Mac (REST call with the secret key from
   `.env.local` returns 200). If not, say so and wait; do not start.
4. The `claude` CLI is logged in. If a previous log shows `Unauthorized` or
   "not logged in", ask Paul to log in — it is his action.
5. Usage limit: if the last log shows "hit your session limit … resets <time>"
   and that time has not passed, say so and offer to start after the reset.
   The limit is shared with Paul's own sessions, so a **daytime run competes
   with his interactive work** — mention it, and start only if he asked for it.

## 2. What "proceed with extraction" runs

From the MAIN checkout (`/Users/paulclancy/_lifestyleacademy`, not a worktree),
as ONE background Bash command (`run_in_background: true`, no `caffeinate` —
Amphetamine keeps the Mac awake):

    cd /Users/paulclancy/_lifestyleacademy && git pull --ff-only && npx tsx --env-file=.env.local scripts/extractDeepgram.ts --hours 9 --batch 3

It drains queued jobs (consolidate / extract / tag), then extracts the
Deepgram-transcribed sources that have no insights yet. Idempotent and
resumable. Log: `scratchpad/runs/extractDeepgram-<stamp>.log`. Billing is Paul's
subscription through the local `claude` CLI, not API credits. The window's own
model does not affect the run's models (fixed in `lib/llm.ts`); Sonnet at
medium effort is plenty for the runner.

If no Deepgram-ready sources and no open jobs remain, there is nothing to
extract: report that and propose the next slice from the top "START HERE" block
of `BACKLOG.md`. **Transcription (`transcribeDeepgram.ts`) spends Deepgram
credit — never start it without Paul's yes in chat.**

## 3. Watching it (cheap — every extra turn costs usage)

1. After launch, one background `sleep 600`, then read the log ONCE. Healthy =
   the log shows work and none of: "Credit balance", "another writer holds the
   corpus", "Unauthorized". Per-round `cli:` stats print only when a round ends,
   so a quiet first 10 minutes is normal; confirm progress read-only instead:
   new `raw_insights` in the last 15 minutes, a `claude -p` child process, a
   fresh lock timestamp.
2. Then wait for the completion notification. Do **not** poll, schedule
   wakeups, or loop. If Paul asks "how did it go" mid-run, read the log and
   answer from it; do not restart a live run.

## 4. Known failure modes

| Log shows | Meaning | Runner does |
|---|---|---|
| `PAUSE — usage window 96% full, pausing before the limit …` or `PAUSE — usage limit reached; resets <time> …`, later `RESUME — paused 62m (…)` | The subscription window (shared with Paul's own sessions) is nearly full or full. **Expected, not a fault.** The supervisor stops calling the CLI, jobs keep their checkpoints and spend no retry attempts, and it wakes 90 s after the reset (never more than 6 h in one sleep; a reset after the run's deadline ends the run). It pauses at 95% full (`USAGE_PAUSE_AT`, a fraction), so calls do not fail first. | Do not kill or restart. Report the lost time from the `STOP` block (`usage-limit pauses: N, Xm lost`) or by adding up the `RESUME` lines. If a `PAUSE` says "after this run's deadline", the window reopens too late (weekly limit): the run ended by design; tell Paul when it resets. |
| `[worker] job … deferred: usage limit …` | A job parked by the pause above. Its attempts were not spent. | Nothing. |
| `hit your session limit` repeated many times with **no** `PAUSE` line, or `cli:` stats showing thousands of failed calls | Pre-2026-10-12 behaviour (the old supervisor hammered the CLI for an hour: 10,744 failed calls). Means the run is on old code. | Report it; do not restart mid-run. |
| `TypeError: fetch failed`, `paged select failed`, rounds "died … sleeping" | The Mac cannot reach Supabase (2026-10-12: ~3 h outage, transient). The supervisor backs off to 15 min and STOPs after ~3 h. | After a STOP: if the database is reachable now, restart once. Report the outage window. |
| `quarantined job <id> (<type>) — refused by the model's safety filter` or `— still failing after 3 retries` | A job that cannot succeed (the model's safety filter refused a passage, e.g. consolidate job 652e4ec4 on 2026-10-12) or that kept failing after 3 re-queues. The supervisor leaves it `failed`, stops re-spending calls on it, and the rest of the round and the run carry on. It is listed again in the `STOP` block. | Report the job id and reason. Do not retry by hand. (Separately, the dedup judge now keeps a refused pair apart instead of failing the job — see the `judge-opus-5-5-and-no-low-confidence-reviews` memory — so a refusal should rarely quarantine a consolidate job.) |
| `round N: drained X job(s), Y failed` with X = 0 | Every job in the round threw. Failures no longer count as progress, so the loop backs off (3, 6 … 15 min) instead of spinning. | Read the error class in the log; report. |
| A job `running` with `attempts` > `max_attempts` | Remnant of a killed run; self-healing. | Never fix by hand. |
| `Credit balance is too low` | The CLI saw an API key and billed it (pre-2026-10-11 bug; `lib/llm.ts` strips the key). | Stop, report, spawn a code task. |

Restart rule: at most ONCE per incident, only for launch problems (stale lock
with no live process, missing login, database back after an outage). Anything
else: report and let Paul decide.

## 5. Reporting (when the run ends, or when Paul asks)

1. Read the whole log: rounds, sources extracted, CLI call stats (calls /
   failed / mean seconds), every distinct error class with counts and time
   windows, whether the queued jobs drained.
2. Re-query live counts — never carry old ones — in Supabase project
   `vgzcrihdxcoozgcqadbt` (LifestyleAcademy; always pin it): sources,
   raw_insights, active claims, pending merge_reviews, open jobs, Deepgram
   sources by `processing_status`. Compare with the baseline in the top block of
   the `v4-build-state` memory. `jobs` has no `updated_at` / `last_error`
   columns; use `type`, `status`, `attempts`, `max_attempts`.
3. Update the top block of the `v4-build-state` memory (new dated block with the
   new baseline) and the top "START HERE" block of `BACKLOG.md`; land the docs
   on `main` (PR, docs only — no code in the runner window).
4. Reply in Paul's UPDATES / NEXT STEPS / TO-DO format, plain language, brief.
   Merge reviews: report the count; do not ask Paul to clear them (policy:
   hold; see the `judge-opus-5-5-and-no-low-confidence-reviews` memory).

## 6. What to spawn instead of fixing

Standing code tasks — spawn each at most once (check the memory index first):
- Judge → Opus 5.5, and no reviews for sub-0.80 "same" verdicts (decision
  recorded in memory `judge-opus-5-5-and-no-low-confidence-reviews`).
- ~~Limit-aware supervisor~~ — **built 2026-10-12** (`lib/usageLimit.ts`, the
  `PAUSE`/`RESUME` lines, quarantine of poison jobs). Do not spawn again. If a
  limit-related symptom appears that §4 does not describe, spawn a NEW task with
  the log lines as evidence.

## 7. The monitor page (Paul, 2026-10-12)

Paul keeps one at-a-glance page open: https://claude.ai/artifact/VtwisaCtVmZgNDK1ML6vHD
("Extraction Monitor"). Its live numbers (last fact written, facts in the last
15 minutes, new facts and claims, Deepgram episodes done, open jobs, pending
reviews) come straight from the database every minute, so they need no help.
The runner only keeps the **state note** current, in the `run/current` document
(`ArtifactData`, `update`, pin `if_version`): fields `state`
(`running|paused|stopped|finished|idle`), `note` (one plain sentence),
`started_at`, `deadline_at`, `counts_since` (ISO UTC; set to the first start of
the same night's run), `ended_at`, `incidents` (chronological list of
`{at, text}`; plain language, one line each) and `work` (changes in flight in
other windows: `{label, state: running|waiting|done, detail}`). The page also
lists the live pipeline jobs by itself under "Working on now", so it always
shows what is being worked on; keep `work` current whenever a code window is
spawned, finishes, or its PR merges.

Update it at milestones only, in one write each time: run started or restarted,
an incident found (usage limit, database outage, a stuck job; a log `PAUSE` line
means `state: paused` until the matching `RESUME`), run ended (set
`state` to `finished` or `stopped`, add `ended_at`). Never poll to keep it
fresh. If the page's URL ever changes, update this section and the memory note.

## 8. How a run ends, and when to stop it yourself

**The run now ends by itself** (2026-10-12, `lib/runnableWork.ts`). Each round
logs `N open job(s): M runnable job(s) (ignoring …)` and the supervisor exits
with `no remaining work — done.` when nothing is left to enqueue and no
*runnable* job is open. Not counted as work: jobs of a type this run skips
(`tag_claims` while `SKIP_TAGGING=1`, `update_topic`, the reference jobs, per the
`SKIP_*` flags), quarantined jobs, and jobs whose `run_after` is past the run's
deadline (the parked August `tag_claims` job, `run_after` 2027-01-01, is what
kept the 2026-10-12 run idling for ~45 minutes after the last episode). A job
backing off for a few minutes after a failure still counts. The `STOP` block
follows as before.

Idle `no progress (streak N)` rounds with a job still `runnable` are a different
thing (jobs that keep failing, or a long limit window) — see §4, do not stop
those.

Manual stop, only if a run on old code (no `runnable job(s)` in the round line)
is idling: if the log shows `0 source(s) left`, no job is `running` in the
database, no `claude -p` child of the run is alive, and the last write is older
than 15 minutes, the work is done: stop only that run's own process tree
(SIGTERM), confirm the lock is gone, set the monitor to `finished`, then report.

## 8. How long an episode takes (2026-10-12)

Measured from `pipeline_runs` on the 2026-10-12 run (ten finished sources, 89–244 facts each):

| stage | per episode | per fact |
|---|---|---|
| extraction (16 chunks at once) | ≈ 8 min | – |
| consolidation (search, judge, merge, enrich-merge rewrite) | ≈ 17–30 min | 5–17 s |

Consolidation is the larger half. Per fact the judge call is ≈ 4 s (about 40% of facts reach it) and the
enrich-merge rewrite ≈ 20 s (about 64% of merges). Since the speed-up (`docs/judge-speedup.md`):

- `CONSOLIDATION_JUDGE_CONCURRENCY` (default 4): the judge reads up to four of one source's facts at once;
  writes stay in order and an early verdict is used only if the candidate list is unchanged. 1 = the old loop.
- `ENRICH_NO_THINKING=1` (default OFF — Paul's call): the rewrite call skips the CLI's thinking pass,
  ≈ 20 s → 2.5 s per call.
- Each consolidated source now logs `[consolidate] source …: N fact(s) in Ts = X s/fact (judge concurrency 4;
  judged J, early verdict reused R, re-judged S, no candidates U)`. **Read those lines in the run report** — they are
  the first real end-to-end measurement of the speed-up; a `re-judged` share far above ~9% means facts from one source
  keep landing next to each other and the window should be lowered.
- Not worth doing (measured, `docs/judge-speedup.md`): a lower judge effort setting, fewer candidates, skipping the
  judge on very similar pairs.

