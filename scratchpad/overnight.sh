#!/bin/zsh
# Overnight supervisor: keeps the re-tag loop alive across transient failures,
# under caffeinate so the machine never sleeps mid-run (the #1 past killer).
cd /Users/paulclancy/_lifestyleacademy/.claude/worktrees/topic-curation
LOG=scratchpad/overnight.log
echo "=== supervisor start $(date) ===" >> $LOG
for attempt in 1 2 3 4 5 6 7 8; do
  echo "--- retagLoop attempt $attempt $(date) ---" >> $LOG
  SKIP_SYNTHESIS_FANOUT=1 npx tsx --env-file=.env.local scripts/retagLoop.ts >> $LOG 2>&1
  code=$?
  echo "--- retagLoop exited code=$code $(date) ---" >> $LOG
  if [ $code -eq 0 ]; then echo "=== clean exit ===" >> $LOG; break; fi
  echo "retagLoop failed; backing off 30s then retrying" >> $LOG
  sleep 30
done
# Final taxonomy snapshot for the morning report.
npx tsx --env-file=.env.local scripts/snapshotTaxonomy.ts post-retag >> $LOG 2>&1
echo "=== supervisor done $(date) ===" >> $LOG
