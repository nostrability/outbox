#!/usr/bin/env bash
set -uo pipefail

# Re-run Stage 2 Greedy+Thompson 1yr with score persistence fix
# Previous runs were all cold-start due to greedy-thompson missing from THOMPSON_IDS.
# This re-run lets Thompson learn across sessions S1→S5.
#
# 6 EN profiles × 5 sessions × 1yr = 30 runs

BENCHDIR="$(cd "$(dirname "$0")" && pwd)"
cd "$BENCHDIR"

WINDOW=31536000
ALGOS="greedy,greedy-thompson"
SESSIONS=5
COOLDOWN=60
PROFILE_COOLDOWN=120
LOGDIR=".cache/stage2_greedy_rerun_logs/${WINDOW}"
PROGRESS_FILE=".cache/stage2_rerun_progress.log"

NAMES="fiatjaf hodlbod jb55 ODELL Gato Telluride"
PK_fiatjaf="3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d"
PK_hodlbod="97c70a44366a6535c145b333f973ea86dfdc2d7a99da618c40c64705ad98e322"
PK_jb55="32e1827635450ebb3c5a7d12c1f8e7b2b514439ac10a67eef3d9fd9c5c68e245"
PK_ODELL="04c915daefee38317fa734444acee390a8269fe5810b2241e5e6dd343dfbecc9"
PK_Gato="6a0c596c1484eae2e8131a030f269944921e52619c1dd143a029c64ea6cd9731"
PK_Telluride="2c65940725bbf10b452197fba41c6cb14afd41e28e0be22aab49bf246b0c84e3"

mkdir -p "$LOGDIR"
touch "$PROGRESS_FILE"

COMMON="--verify --verify-window $WINDOW --verify-concurrency 10 --nip66-filter liveness --no-phase2-cache --fast --output both"

echo "=== Stage 2 Re-run: Greedy+Thompson 1yr with learning ==="
echo "Started: $(date)"
echo "Fix: greedy-thompson now loads/saves Thompson priors across sessions"
echo ""

for name in $NAMES; do
  pk_var="PK_${name}"
  pk="${!pk_var}"

  # Clear greedy-thompson scores for fresh learning sequence
  MARKER=".cache/stage2_rerun_${WINDOW}_${name}_scores_cleared"
  if [ ! -f "$MARKER" ]; then
    rm -f ".cache/relay_scores_${pk:0:16}_${WINDOW}_liveness_greedy-thompson.json"
    touch "$MARKER"
    echo "Cleared greedy-thompson scores for $name"
  fi

  for s in $(seq 1 $SESSIONS); do
    key="stage2_rerun_${WINDOW}_${name}_s${s}"

    if grep -qF "$key" "$PROGRESS_FILE" 2>/dev/null; then
      echo "SKIP (already done): $key"
      continue
    fi

    logfile="${LOGDIR}/${name}_s${s}.log"
    echo "$(date '+%H:%M:%S') RUN: $key"

    deno task bench "$pk" \
      --algorithms "$ALGOS" \
      $COMMON \
      2>&1 | tee "${logfile}.tmp"

    if [ ${PIPESTATUS[0]} -eq 0 ]; then
      mv "${logfile}.tmp" "$logfile"
      touch "${logfile}.done"
      echo "$key" >> "$PROGRESS_FILE"
      echo "$(date '+%H:%M:%S') DONE: $key"
    else
      echo "$(date '+%H:%M:%S') FAILED: $key (log at ${logfile}.tmp)" >&2
    fi

    # Rate limit detection
    if grep -qi "rate.limit\|429\|too many\|throttl" "${logfile}.tmp" 2>/dev/null; then
      echo "WARNING: Rate limiting detected. Doubling cooldown."
      sleep $COOLDOWN
    fi

    sleep $COOLDOWN
  done
  echo "$(date '+%H:%M:%S') Profile $name complete"
  sleep $PROFILE_COOLDOWN
done

echo ""
echo "=== Stage 2 Re-run Complete ==="
echo "Finished: $(date)"
echo "Completed: $(wc -l < "$PROGRESS_FILE") / 30"
