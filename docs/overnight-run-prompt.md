# Overnight run — the prompt for a fresh Claude Code window

Paul starts the overnight extraction by pasting the block below into a new
Claude Code window on LifestyleAcademy (written 2026-10-12; keep it current
when the run command or the checks change). Recommended session settings:
**Sonnet 5.5, medium effort** — the window only launches and watches; the
run's own AI calls use the models fixed in `lib/llm.ts` (Haiku for bulk
extraction, Opus for adjudication) and are not affected by the window's model.
The run lives inside that window's session: the Claude app must stay open all
night, and the Mac must stay awake (Paul uses Amphetamine; no `caffeinate`).

```
LifestyleAcademy — start and watch tonight's overnight extraction run. This window has ONE job: start the run, confirm it is healthy, wait for it to finish, and report. Do no other work, and run nothing else that writes to the database.

Context first: read the top block of the v4-build-state memory and the top "START HERE" block of BACKLOG.md (Phase B finished 2026-10-12 02:10 UTC; the writer lock is free). The run drains the 5 leftover jobs from August, then extracts the 18 Deepgram-transcribed episodes, using the signed-in `claude` command-line tool (my subscription), not the API. Its own model choices are fixed in code; nothing in this window changes them.

Steps:
1. Pre-flight, read-only: confirm `~/.lifestyle-academy-writer.lock` is absent or older than 15 minutes, and that no `extractDeepgram`, `overnightExtract`, `retireSourceClaims` or `repairDeepgramTiming` process is running (`pgrep -fl tsx`). If a live writer exists, stop and tell me; do not kill it.
2. Start the run from the MAIN checkout (not a worktree) as ONE background Bash command (run_in_background: true), exactly:
   cd /Users/paulclancy/_lifestyleacademy && git pull --ff-only && npx tsx --env-file=.env.local scripts/extractDeepgram.ts --hours 9 --batch 3
   No caffeinate: Amphetamine keeps the Mac awake. The log lands in /Users/paulclancy/_lifestyleacademy/scratchpad/runs/extractDeepgram-<stamp>.log.
3. Wait ten minutes with a single background `sleep 600` (one notification), then read that log ONCE. Healthy = the first round's CLI stats show calls succeeding and no "Credit balance", "another writer holds the corpus" or "Unauthorized" lines. If the run has already exited, diagnose from the log, fix only what is clearly a launch problem (a stale lock, a missing login), restart at most ONCE, and tell me what happened. Never run two copies.
4. Then wait for the background task's completion notification. Do NOT poll, schedule wakeups, start monitors or re-read the log in a loop: every extra turn costs usage, and one completion notification is enough. There is nothing else to do in this window until it arrives.
5. When the run ends, or when I say "check the overnight run" in the morning: read the whole log and report rounds completed, sources extracted, CLI call stats (successes, failures, retries), every error, and whether the 5 leftover jobs drained. Re-query the live counts in Supabase (project vgzcrihdxcoozgcqadbt: sources, raw_insights, active claims, pending merge_reviews, open jobs) and compare them with the 02:10 UTC baseline in the memory (547 / 33,120 / 29,383 / 197 / 6). Update the memory top block and the BACKLOG top block with the result and commit the docs to main. Reply in the UPDATES / NEXT STEPS / TO-DO ITEMS format, in plain language.
```
