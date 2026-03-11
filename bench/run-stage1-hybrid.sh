#!/usr/bin/env bash
# Stage 1: Hybrid+Thompson EN (outbox-0jx)
# Algorithms: ditto-mew (base) + ditto-outbox (Thompson) — paired for delta variance
# 6 EN profiles × 2 windows × 5 sessions = 60 runs
set -uo pipefail

ALGOS="ditto-mew,ditto-outbox"
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

WINDOWS="31536000 94608000"
PROGRESS_FILE=".cache/stage1_progress.log"
touch "$PROGRESS_FILE"

echo "=== Stage 1: Hybrid+Thompson EN (outbox-0jx) ==="
echo "Algorithms: $ALGOS"
echo "Profiles: 6 EN × 2 windows × $SESSIONS sessions = 60 runs"
echo "start=$(date +%s)" > ".cache/stage1_timestamps.txt"
echo "Start: $(date)"
echo

for WINDOW in $WINDOWS; do
  # No --nip66-filter — hybrid models app-relay client without NIP-66
  COMMON="--verify --verify-window $WINDOW --verify-concurrency 10 --no-phase2-cache --fast --output both"
  LOGDIR=".cache/stage1_hybrid_logs/${WINDOW}"
  mkdir -p "$LOGDIR"

  # Resume-safe score clearing
  MARKER=".cache/stage1_${WINDOW}_scores_cleared"
  if [ ! -f "$MARKER" ]; then
    echo "Clearing ditto-outbox Thompson scores for window=$WINDOW..."
    rm -f .cache/relay_scores_*_${WINDOW}_none_ditto-outbox.json
    touch "$MARKER"
  fi

  for session in $(seq 1 $SESSIONS); do
    for name in $NAMES; do
      eval "pk=\$PK_${name}"
      key="stage1_${WINDOW}_${name}_s${session}"
      logfile="$LOGDIR/${name}_s${session}.log"

      # Skip completed
      if grep -qF "$key" "$PROGRESS_FILE" 2>/dev/null; then
        echo "SKIP: $key"
        continue
      fi

      echo "[S$session W$WINDOW] $name — $(date)"
      deno task bench "$pk" --algorithms "$ALGOS" $COMMON 2>&1 | tee "${logfile}.tmp"
      if [ ${PIPESTATUS[0]} -eq 0 ]; then
        mv "${logfile}.tmp" "$logfile"
        touch "${logfile}.done"
        echo "$key" >> "$PROGRESS_FILE"
        grep -iE '(Ditto-Mew|Ditto\+Outbox)' "$logfile" | grep -iE 'Recall' | head -2
      else
        echo "FAILED: $key (log at ${logfile}.tmp)" >&2
      fi

      # Rate limit detection (check final log location; .tmp only exists on failure)
      if grep -qi "rate.limit\|429\|too many\|throttl" "$logfile" "${logfile}.tmp" 2>/dev/null; then
        echo "WARNING: Rate limiting detected. Doubling cooldown."
        sleep $COOLDOWN_PROFILE
      fi

      echo "--- cooling ${COOLDOWN_PROFILE}s ---"
      sleep $COOLDOWN_PROFILE
    done
    echo "--- Session $session (W$WINDOW) complete, cooling ${COOLDOWN_SESSION}s --- $(date)"
    sleep $COOLDOWN_SESSION
  done
done

echo "end=$(date +%s)" >> ".cache/stage1_timestamps.txt"
echo "=== Stage 1 complete === $(date)"
