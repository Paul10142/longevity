#!/bin/zsh
# Overnight plan for 2026-08-14, in order:
#   1. Re-dedup the ~1,550 claims the broken Vercel cron added without dedup.
#      Done FIRST because merging retires claims and frees storage — the DB is
#      the binding constraint (339/500 MB), so this makes room for step 2.
#   2. Extract new sources for the rest of the night.
# Both stages checkpoint and are safe to re-run.
set -u
cd /Users/paulclancy/_lifestyleacademy

echo "=== [$(date '+%H:%M:%S')] STAGE 1: scoped re-dedup of cron-era claims ==="
npx tsx --env-file=.env.local scratchpad/sweepCronEra.ts
echo "=== [$(date '+%H:%M:%S')] STAGE 1 exit=$? ==="

echo "=== [$(date '+%H:%M:%S')] STAGE 2: extraction ==="
npx tsx --env-file=.env.local scripts/overnightExtract.ts --hours 7 --batch 4
echo "=== [$(date '+%H:%M:%S')] STAGE 2 exit=$? — overnight run finished ==="
