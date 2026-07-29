#!/usr/bin/env bash
#
# 1c — per-source extraction fidelity flagging as a STANDING post-extraction stage
# (v4 spec §7.2; BACKLOG "🔨 BUILD-NEXT PLAN" step 1c).
#
# For each source id, run the full pipeline for that source and THEN judge its
# claims for extraction over-reach, in this strict order:
#
#     extract  →  drain (consolidate → tag)  →  extraction_fidelity flagging
#
# Why a serial orchestration and not a worker job: fidelity judging is ~1 LLM
# call per claim on the same local CLI the drain uses. Enqueuing it as a job
# would let the worker claim it MID-DRAIN and the two heavy CLI consumers would
# throttle each other. Sequencing it after the drain empties (per source) is the
# constraint the spec names ("never run alongside a pipeline drain"). This is the
# standing stage for the laptop-CLI execution model; when the drain moves to the
# deployed worker (harness-hardening milestone) it becomes a low-priority job.
#
# The flags land in `claim_flags` (rule = 'extraction_fidelity') and feed the §7
# review lifecycle. They DO NOT quarantine: nothing here sets claims.status =
# 'flagged'. Auto-quarantine waits until the judge is certified against Paul's
# gold labels (judge↔human κ, Phase 1a) — flagging in "shadow mode" until then is
# deliberate, so an uncertified judge can never bury a faithful claim.
#
# Usage:
#   caffeinate -dimsu scripts/extract_with_fidelity.sh <source_id> [<source_id> …]
#
# Env (defaults are the safe re-processing settings):
#   LLM_BACKEND=claude-code       subscription CLI (flat-rate), not API credit
#   SKIP_SYNTHESIS_FANOUT=1       tag claims into the tree but DON'T regen articles
#                                 (article build is deferred to the Phase 3 rewrite)
# Run on AC power under caffeinate — a local drain freezes if the laptop sleeps.

set -euo pipefail
cd "$(dirname "$0")/.."

export LLM_BACKEND="${LLM_BACKEND:-claude-code}"
export SKIP_SYNTHESIS_FANOUT="${SKIP_SYNTHESIS_FANOUT:-1}"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <source_id> [<source_id> …]" >&2
  exit 1
fi

drain_until_idle() {
  # `pipeline work` drains within a time budget and may yield on a big source;
  # loop it until the jobs queue reports idle. Bounded to avoid an infinite loop
  # if a job is stuck failing (it will hit max retries and the count won't clear
  # — cap the passes and surface it).
  local pass=0
  while [ "$pass" -lt 40 ]; do
    if npm run --silent pipeline -- status 2>/dev/null | grep -qE 'jobs +idle'; then
      return 0
    fi
    npm run --silent pipeline -- work
    pass=$((pass + 1))
  done
  echo "  ⚠ queue still not idle after $pass drain passes — check 'pipeline status'." >&2
  return 1
}

for sid in "$@"; do
  echo ""
  echo "============================================================"
  echo "SOURCE $sid"
  echo "============================================================"

  echo "── extract ──"
  npm run --silent pipeline -- extract "$sid"

  echo "── drain (consolidate → tag), SKIP_SYNTHESIS_FANOUT=$SKIP_SYNTHESIS_FANOUT ──"
  drain_until_idle || true

  echo "── extraction_fidelity flagging (post-drain, no CLI contention) ──"
  npx tsx --env-file=.env.local scripts/flagClaims.ts fidelity --source "$sid"

  echo "── flags for this source recorded (shadow mode — no quarantine). ──"
done

echo ""
echo "All sources processed. Review flags:  npx tsx --env-file=.env.local scripts/flagClaims.ts report"
