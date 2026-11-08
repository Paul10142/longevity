#!/bin/sh
# Sequential comparison run. Stops at the first failure (including the usage guard, exit 2).
set -e
cd "$(dirname "$0")/../.."
T="npx tsx scripts/evalExtractionPrompt.ts"
for v in haiku sonnet opus; do
  echo "=== $(date +%H:%M:%S) gold extract $v"; $T extract $v --source gold --conc 16
  echo "=== $(date +%H:%M:%S) gold judge $v";   $T judge $v --source gold --conc 16
done
for v in haiku sonnet opus; do
  echo "=== $(date +%H:%M:%S) extract $v";      $T extract $v --conc 16
  echo "=== $(date +%H:%M:%S) judge $v";        $T judge $v --conc 16
done
echo "=== $(date +%H:%M:%S) judge baseline";    $T judge baseline --conc 16
echo "=== $(date +%H:%M:%S) ALL DONE"
