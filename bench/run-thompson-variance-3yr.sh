#!/usr/bin/env bash
# Thompson variance measurement: 10 independent runs × 5 sessions, 3yr
# Each independent run starts with fresh Thompson scores (alpha=1, beta=1)
# Spread out to avoid relay rate limiting
set -uo pipefail

ALGOS="welshman-thompson,fd-thompson,ndk-thompson"
WINDOW=94608000
COMMON="--verify --verify-window $WINDOW --nip66-filter liveness --no-phase2-cache --fast --output table"

NAMES="fiatjaf hodlbod jb55 ODELL Gato Telluride"
PK_fiatjaf="3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d"
PK_hodlbod="97c70a44366a6535c145b333f973ea86dfdc2d7a99da618c40c64705ad98e322"
PK_jb55="32e1827635450ebb3c5a7d12c1f8e7b2b514439ac10a67eef3d9fd9c5c68e245"
PK_ODELL="04c915daefee38317fa734444acee390a8269fe5810b2241e5e6dd343dfbecc9"
PK_Gato="6a0c596c1484eae2e8131a030f269944921e52619c1dd143a029c64ea6cd9731"
PK_Telluride="2c65940725bbf10b452197fba41c6cb14afd41e28e0be22aab49bf246b0c84e3"

TOTAL_RUNS=10
SESSIONS=5
LOGDIR="thompson-variance-3yr"

echo "=== Thompson Variance Benchmark (3yr) ==="
echo "Algorithms: $ALGOS"
echo "Runs: $TOTAL_RUNS independent × $SESSIONS sessions × 6 profiles"
echo "Start: $(date)"
echo

for run in $(seq 1 $TOTAL_RUNS); do
  RUNDIR="$LOGDIR/run$(printf '%02d' $run)"
  mkdir -p "$RUNDIR"

  # Clear ALL Thompson scores for this window to start fresh
  echo "=== Independent Run $run/$TOTAL_RUNS — clearing Thompson scores ==="
  rm -f .cache/relay_scores_*_${WINDOW}_liveness_welshman-thompson.json
  rm -f .cache/relay_scores_*_${WINDOW}_liveness_fd-thompson.json
  rm -f .cache/relay_scores_*_${WINDOW}_liveness_ndk-thompson.json
  echo "Scores cleared. Starting fresh at $(date)"

  for session in $(seq 1 $SESSIONS); do
    for name in $NAMES; do
      eval "pk=\$PK_${name}"
      logfile="$RUNDIR/${name}_s${session}.log"

      # Skip if already completed
      if [ -f "$logfile" ] && grep -q "Phase 2" "$logfile" 2>/dev/null; then
        echo "SKIP: run$run ${name}_s${session}"
        continue
      fi

      echo "[Run $run S$session] $name — $(date)"
      deno task bench "$pk" --algorithms "$ALGOS" $COMMON > "$logfile" 2>&1 || true
      grep -E '(Welshman\+Thompson|FD\+Thompson|NDK\+Thompson)' "$logfile" | grep -E 'Recall' | head -3
      echo "--- cooling 45s ---"
      sleep 45
    done
    echo "--- Session $session complete, cooling 90s --- $(date)"
    sleep 90
  done

  echo "=== Run $run complete === $(date)"
  echo "--- Cooling 180s before next independent run ---"
  sleep 180
done

echo "=== All Thompson variance (3yr) runs complete === $(date)"
