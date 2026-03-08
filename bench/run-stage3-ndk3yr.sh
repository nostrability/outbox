#!/usr/bin/env bash
# Stage 3: NDK+Thompson 3yr EN (outbox-2ak)
# Algorithms: ndk (base) + ndk-thompson (paired for delta variance)
# 6 EN profiles × 1 window (3yr) × 5 sessions = 30 runs
set -uo pipefail

ALGOS="ndk,ndk-thompson"
SESSIONS=5
WINDOW=94608000
COOLDOWN_PROFILE=60
COOLDOWN_SESSION=120

NAMES="fiatjaf hodlbod jb55 ODELL Gato Telluride"
PK_fiatjaf="3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d"
PK_hodlbod="97c70a44366a6535c145b333f973ea86dfdc2d7a99da618c40c64705ad98e322"
PK_jb55="32e1827635450ebb3c5a7d12c1f8e7b2b514439ac10a67eef3d9fd9c5c68e245"
PK_ODELL="04c915daefee38317fa734444acee390a8269fe5810b2241e5e6dd343dfbecc9"
PK_Gato="6a0c596c1484eae2e8131a030f269944921e52619c1dd143a029c64ea6cd9731"
PK_Telluride="2c65940725bbf10b452197fba41c6cb14afd41e28e0be22aab49bf246b0c84e3"

COMMON="--verify --verify-window $WINDOW --verify-concurrency 10 --nip66-filter liveness --no-phase2-cache --fast --output both"
LOGDIR=".cache/stage3_ndk3yr_logs"
PROGRESS_FILE=".cache/stage3_progress.log"
mkdir -p "$LOGDIR"
touch "$PROGRESS_FILE"

echo "=== Stage 3: NDK+Thompson 3yr EN (outbox-2ak) ==="
echo "Algorithms: $ALGOS"
echo "Profiles: 6 EN × 1 window (3yr) × $SESSIONS sessions = 30 runs"
echo "start=$(date +%s)" > ".cache/stage3_timestamps.txt"
echo "Start: $(date)"
echo

# Resume-safe score clearing
MARKER=".cache/stage3_${WINDOW}_scores_cleared"
if [ ! -f "$MARKER" ]; then
  echo "Clearing ndk-thompson Thompson scores for window=$WINDOW..."
  rm -f .cache/relay_scores_*_${WINDOW}_liveness_ndk-thompson.json
  touch "$MARKER"
fi

for session in $(seq 1 $SESSIONS); do
  for name in $NAMES; do
    eval "pk=\$PK_${name}"
    key="stage3_${name}_s${session}"
    logfile="$LOGDIR/${name}_s${session}.log"

    # Skip completed
    if grep -qF "$key" "$PROGRESS_FILE" 2>/dev/null; then
      echo "SKIP: $key"
      continue
    fi

    echo "[S$session] $name — $(date)"
    deno task bench "$pk" --algorithms "$ALGOS" $COMMON 2>&1 | tee "${logfile}.tmp"
    if [ ${PIPESTATUS[0]} -eq 0 ]; then
      mv "${logfile}.tmp" "$logfile"
      touch "${logfile}.done"
      echo "$key" >> "$PROGRESS_FILE"
      grep -iE '(Priority-Based|NDK\+Thompson)' "$logfile" | grep -iE 'Recall' | head -2
    else
      echo "FAILED: $key (log at ${logfile}.tmp)" >&2
    fi

    # Rate limit detection
    if grep -qi "rate.limit\|429\|too many\|throttl" "${logfile}.tmp" 2>/dev/null; then
      echo "WARNING: Rate limiting detected. Doubling cooldown."
      sleep $COOLDOWN_PROFILE
    fi

    echo "--- cooling ${COOLDOWN_PROFILE}s ---"
    sleep $COOLDOWN_PROFILE
  done
  echo "--- Session $session complete, cooling ${COOLDOWN_SESSION}s --- $(date)"
  sleep $COOLDOWN_SESSION
done

echo "end=$(date +%s)" >> ".cache/stage3_timestamps.txt"
echo "=== Stage 3 complete === $(date)"
