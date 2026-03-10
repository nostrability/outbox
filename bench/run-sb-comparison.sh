#!/usr/bin/env bash
# Score Boost (SB) benchmark:
#   ndk-thompson vs ndk-thompson-cg3 vs ndk-thompson-sb
#
# SB replaces CG's hard forcing with a soft 5x score multiplier for
# sole-source relays. Uses standard Thompson scoring (not PW/SE).
# Sole-source pubkeys are processed first to ensure their relays
# enter the pool before the budget fills.
#
# 6 EN profiles x 1yr x 5 sessions = 30 runs
# Three-way paired comparison from identical relay snapshots.
set -uo pipefail

cd "$(dirname "$0")"

ALGOS="ndk-thompson,ndk-thompson-cg3,ndk-thompson-sb"
SESSIONS=5
COOLDOWN_PROFILE=60
COOLDOWN_SESSION=120

NAMES="fiatjaf hodlbod jb55 ODELL Gato Telluride"
PK_fiatjaf="3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d"
PK_hodlbod="97c70a44366a6535c145b333f973ea86dfdc2d7a99da618c40c64705ad98e322"
PK_jb55="32e1827635450ebb3c5a7d12c1f8e7b2b514439ac10a67eef3d9fd9c5c68e245"
PK_ODELL="04c915daefee38317fa734444acee390a8269fe5810b2241e5e6dd343dfbecc9"
PK_Gato="6a0c596c1484eae2e8131a030f269944921e52619c1dd143a029c64ea6cd9731"
PK_Telluride="2c65940725bbf10b452197fba41c6cb14afd41e28e0be22aab49bf246b0c84e3"

WINDOW="31536000"
PROGRESS_FILE=".cache/sb_comparison_progress.log"
touch "$PROGRESS_FILE"

COMMON="--verify --verify-concurrency 10 --nip66-filter liveness --no-phase2-cache --fast --output both"

echo "=== Score Boost (SB) Benchmark ==="
echo "Algorithms: $ALGOS"
echo "start=$(date +%s)" > ".cache/sb_comparison_timestamps.txt"
echo "Start: $(date)"
echo

# --- Score clearing (resume-safe) ---
MARKER=".cache/sb_${WINDOW}_scores_cleared"
if [ ! -f "$MARKER" ]; then
  echo "Clearing ndk-thompson, ndk-thompson-cg3, and ndk-thompson-sb scores for window=$WINDOW..."
  rm -f .cache/relay_scores_*_${WINDOW}_liveness_ndk-thompson.json
  rm -f .cache/relay_scores_*_${WINDOW}_liveness_ndk-thompson-cg3.json
  rm -f .cache/relay_scores_*_${WINDOW}_liveness_ndk-thompson-sb.json
  touch "$MARKER"
fi

# --- Main campaign ---
LOGDIR=".cache/sb_comparison_logs/${WINDOW}"
mkdir -p "$LOGDIR"

for session in $(seq 1 $SESSIONS); do
  for name in $NAMES; do
    pk_var="PK_${name}"
    pk="${!pk_var}"
    key="sb_${WINDOW}_${name}_s${session}"
    logfile="$LOGDIR/${name}_s${session}.log"

    # Skip completed
    if grep -qF "$key" "$PROGRESS_FILE" 2>/dev/null; then
      echo "SKIP: $key"
      continue
    fi

    echo "[S$session] $name — $(date)"
    deno task bench "$pk" --algorithms "$ALGOS" --verify-window "$WINDOW" $COMMON 2>&1 | tee "${logfile}.tmp"
    if [ ${PIPESTATUS[0]} -eq 0 ]; then
      mv "${logfile}.tmp" "$logfile"
      touch "${logfile}.done"
      echo "$key" >> "$PROGRESS_FILE"
      grep -iE '(Priority-Based|NDK\+Thompson)' "$logfile" | grep -iE 'Recall' | head -5
    else
      echo "FAILED: $key (log at ${logfile}.tmp)" >&2
    fi

    # Rate limit detection
    if grep -qi "rate.limit\|429\|too many\|throttl" "$logfile" "${logfile}.tmp" 2>/dev/null; then
      echo "WARNING: Rate limiting detected. Doubling cooldown."
      sleep $COOLDOWN_PROFILE
    fi

    echo "--- cooling ${COOLDOWN_PROFILE}s ---"
    sleep $COOLDOWN_PROFILE
  done
  echo "--- Session $session complete, cooling ${COOLDOWN_SESSION}s --- $(date)"
  sleep $COOLDOWN_SESSION
done

echo "end=$(date +%s)" >> ".cache/sb_comparison_timestamps.txt"
echo "=== SB benchmark complete === $(date)"
