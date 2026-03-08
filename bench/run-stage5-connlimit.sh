#!/usr/bin/env bash
# Stage 5: Adaptive connection limits (outbox-3sq)
# Algorithm: welshman-thompson at cap@10, cap@15, cap@30
# 3 profiles × 3 budgets × 5 sessions = 45 runs
# (cap@20 already exists from prior benchmarks)
set -uo pipefail

ALGO="welshman-thompson"
SESSIONS=5
WINDOW=31536000
COOLDOWN_PROFILE=60
COOLDOWN_SESSION=120

# 3 representative profiles: small (84), medium (399), large (2784) follow graphs
NAMES="tanakei Gato Telluride"
PK_tanakei="78b3c1ed0a53b072fcfb8cc2e2e09cad31c9bfec869d1c8745c343d55033eea9"
PK_Gato="6a0c596c1484eae2e8131a030f269944921e52619c1dd143a029c64ea6cd9731"
PK_Telluride="2c65940725bbf10b452197fba41c6cb14afd41e28e0be22aab49bf246b0c84e3"

BUDGETS="10 15 30"
PROGRESS_FILE=".cache/stage5_progress.log"
touch "$PROGRESS_FILE"

echo "=== Stage 5: Adaptive Connection Limits (outbox-3sq) ==="
echo "Algorithm: $ALGO"
echo "Profiles: 3 × 3 budgets × $SESSIONS sessions = 45 runs"
echo "start=$(date +%s)" > ".cache/stage5_timestamps.txt"
echo "Start: $(date)"
echo

for BUDGET in $BUDGETS; do
  COMMON="--verify --verify-window $WINDOW --verify-concurrency 10 --max-connections $BUDGET --nip66-filter liveness --no-phase2-cache --fast --output both"
  LOGDIR=".cache/stage5_connlimit_logs/cap${BUDGET}"
  mkdir -p "$LOGDIR"

  # Clear scores before EACH budget point (fresh learning per cap)
  MARKER=".cache/stage5_cap${BUDGET}_scores_cleared"
  if [ ! -f "$MARKER" ]; then
    echo "Clearing welshman-thompson scores for cap@$BUDGET..."
    for name in $NAMES; do
      eval "pk=\$PK_${name}"
      rm -f ".cache/relay_scores_${pk}_${WINDOW}_liveness_welshman-thompson.json"
    done
    touch "$MARKER"
  fi

  for session in $(seq 1 $SESSIONS); do
    for name in $NAMES; do
      eval "pk=\$PK_${name}"
      key="stage5_cap${BUDGET}_${name}_s${session}"
      logfile="$LOGDIR/${name}_s${session}.log"

      # Skip completed
      if grep -qF "$key" "$PROGRESS_FILE" 2>/dev/null; then
        echo "SKIP: $key"
        continue
      fi

      echo "[S$session cap@$BUDGET] $name — $(date)"
      deno task bench "$pk" --algorithms "$ALGO" $COMMON 2>&1 | tee "${logfile}.tmp"
      if [ ${PIPESTATUS[0]} -eq 0 ]; then
        mv "${logfile}.tmp" "$logfile"
        touch "${logfile}.done"
        echo "$key" >> "$PROGRESS_FILE"
        grep -iE 'Welshman\+Thompson' "$logfile" | grep -iE 'Recall' | head -1
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
    echo "--- Session $session (cap@$BUDGET) complete, cooling ${COOLDOWN_SESSION}s --- $(date)"
    sleep $COOLDOWN_SESSION
  done

  echo "--- Budget cap@$BUDGET complete ---"
done

echo "end=$(date +%s)" >> ".cache/stage5_timestamps.txt"
echo "=== Stage 5 complete === $(date)"
