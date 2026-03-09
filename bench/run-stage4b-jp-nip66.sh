#!/usr/bin/env bash
# Stage 4b: JP NIP-66 comparison (outbox-rct)
# Algorithms: greedy, welshman, welshman-thompson (with NIP-66 liveness filter)
# 6 JP profiles × 2 windows × 5 sessions = 60 runs
set -uo pipefail

ALGOS="greedy,welshman,welshman-thompson"
SESSIONS=5
COOLDOWN_PROFILE=60
COOLDOWN_SESSION=120

NAMES="tanakei yutaro shion rokuyo darashi kojira"
PK_tanakei="78b3c1ed0a53b072fcfb8cc2e2e09cad31c9bfec869d1c8745c343d55033eea9"
PK_yutaro="75f457569d7027f819de92e8bb13795c0febe9750dc3fb1b5c42aeb502d0841d"
PK_shion="0c9b1e9fef76c88b63f86645dc33bb7777f0259ec41e674b61f4fc553f6db0e0"
PK_rokuyo="ec42c765418b3db9c85abff3a88f4a3bbe57535eebbdc54522041fa5328c0600"
PK_darashi="07804b786c6a3b400b7b20d9bfc945035f3ad213da797b0c50954767c375c543"
PK_kojira="b3e43e8cc7e6dff23a33d9213a3e912d895b1c3e4250240e0c99dbefe3068b5f"

WINDOWS="31536000 94608000"
PROGRESS_FILE=".cache/stage4b_progress.log"
touch "$PROGRESS_FILE"

echo "=== Stage 4b: JP NIP-66 Comparison (outbox-rct) ==="
echo "Algorithms: $ALGOS"
echo "Profiles: 6 JP × 2 windows × $SESSIONS sessions = 60 runs"
echo "start=$(date +%s)" > ".cache/stage4b_timestamps.txt"
echo "Start: $(date)"
echo

# NIP-66 coverage check for JP before running
echo "--- NIP-66 coverage probe for JP profiles ---"
deno task bench "$PK_tanakei" --algorithms greedy --nip66-filter liveness --fast --output table 2>&1 | head -20
echo "--- End NIP-66 probe (if >60% relays filtered, results may be unreliable) ---"
echo

for WINDOW in $WINDOWS; do
  COMMON="--verify --verify-window $WINDOW --verify-concurrency 10 --nip66-filter liveness --no-phase2-cache --fast --output both"
  LOGDIR=".cache/stage4b_jp_nip66_logs/${WINDOW}"
  mkdir -p "$LOGDIR"

  # Resume-safe score clearing (only welshman-thompson, JP pubkeys)
  MARKER=".cache/stage4b_${WINDOW}_scores_cleared"
  if [ ! -f "$MARKER" ]; then
    echo "Clearing welshman-thompson scores for JP profiles, window=$WINDOW..."
    for name in $NAMES; do
      eval "pk=\$PK_${name}"
      rm -f ".cache/relay_scores_${pk}_${WINDOW}_liveness_welshman-thompson.json"
    done
    touch "$MARKER"
  fi

  for session in $(seq 1 $SESSIONS); do
    for name in $NAMES; do
      eval "pk=\$PK_${name}"
      key="stage4b_${WINDOW}_${name}_s${session}"
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
        grep -iE '(Greedy|Welshman|Welshman\+Thompson)' "$logfile" | grep -iE 'Recall' | head -3
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

echo "end=$(date +%s)" >> ".cache/stage4b_timestamps.txt"
echo "=== Stage 4b complete === $(date)"
