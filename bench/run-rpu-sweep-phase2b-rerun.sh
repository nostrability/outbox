#!/usr/bin/env bash
# RPU Sweep Phase 2b RE-RUN (outbox-8j9)
#
# Phase 2b profiles (fiatjaf, hodlbod, Gato) had warm-started Thompson priors
# at all RPU values because markers from Phase 1/2a prevented score clearing.
#
# This script ONLY touches Phase 2b profiles.  Per pitfall P1, we do NOT
# modify run-per-pubkey-sweep.sh — instead this standalone script:
#   - Clears scores PER-PROFILE using ${pk:0:16} globs (not wildcards)
#   - Uses per-(RPU × profile) markers that cannot collide with Phase 1
#   - Has its own progress file
#
# 3 profiles × 5 RPU × 5 sessions = 75 runs
set -uo pipefail

cd "$(dirname "$0")"

SESSIONS=5
WINDOW=31536000
COOLDOWN_PROFILE=60
COOLDOWN_SESSION=120

# Phase 2b profiles ONLY
NAMES="fiatjaf hodlbod Gato"
PK_fiatjaf="3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d"
PK_hodlbod="97c70a44366a6535c145b333f973ea86dfdc2d7a99da618c40c64705ad98e322"
PK_Gato="6a0c596c1484eae2e8131a030f269944921e52619c1dd143a029c64ea6cd9731"

# All RPU values (full sweep)
RPUS="1 2 3 4 5"
ALGOS="rust-nostr,fd-thompson"

PROGRESS_FILE=".cache/rpu_sweep_phase2b_rerun_progress.log"
touch "$PROGRESS_FILE"

echo "=== RPU Sweep Phase 2b RE-RUN (outbox-8j9) ==="
echo "Profiles: $NAMES"
echo "RPU values: $RPUS"
echo "Sessions: $SESSIONS"
echo "Total runs: 75 (3 × 5 × 5)"
echo "start=$(date +%s)" > ".cache/rpu_sweep_phase2b_rerun_timestamps.txt"
echo "Start: $(date)"
echo

for rpu in $RPUS; do
  LOGDIR=".cache/rpu_sweep_logs/${WINDOW}/rpu${rpu}"
  mkdir -p "$LOGDIR"

  # Clear Thompson scores PER-PROFILE (pitfall P1: not wildcards)
  # Each profile gets its own marker scoped to (RPU × profile name)
  for name in $NAMES; do
    pk_var="PK_${name}"
    pk="${!pk_var}"
    pk_prefix="${pk:0:16}"

    MARKER=".cache/rpu_sweep_${WINDOW}_rpu${rpu}_${name}_rerun_scores_cleared"
    if [ ! -f "$MARKER" ]; then
      # Rule 3: Verify glob with ls BEFORE rm
      echo "Verifying score file glob for ${name} (${pk_prefix})..."
      ls -la .cache/relay_scores_${pk_prefix}_${WINDOW}_liveness_fd-thompson.json 2>&1 || true

      echo "Clearing fd-thompson scores for ${name} at rpu=${rpu}..."
      rm -f .cache/relay_scores_${pk_prefix}_${WINDOW}_liveness_fd-thompson.json
      touch "$MARKER"
    else
      echo "SKIP clear: ${name} rpu=${rpu} (marker exists)"
    fi
  done

  COMMON="--verify --verify-window $WINDOW --verify-concurrency 10 --nip66-filter liveness --no-phase2-cache --fast --output both --relays-per-user $rpu"

  for session in $(seq 1 $SESSIONS); do
    for name in $NAMES; do
      pk_var="PK_${name}"
      pk="${!pk_var}"
      key="rpu_p2b_rerun_${WINDOW}_rpu${rpu}_${name}_s${session}_${ALGOS}"
      logfile="$LOGDIR/${name}_s${session}_rerun.log"

      # Skip completed
      if grep -qF "$key" "$PROGRESS_FILE" 2>/dev/null; then
        echo "SKIP: $key"
        continue
      fi

      echo "[P2b-rerun rpu=$rpu S$session] $name — $(date)"
      deno task bench "$pk" --algorithms "$ALGOS" $COMMON 2>&1 | tee "${logfile}.tmp"
      if [ ${PIPESTATUS[0]} -eq 0 ]; then
        mv "${logfile}.tmp" "$logfile"
        touch "${logfile}.done"
        echo "$key" >> "$PROGRESS_FILE"
        grep -iE '(Filter Decomposition|FD\+Thompson)' "$logfile" | grep -iE 'Recall' | head -4
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
    echo "--- Session $session (rpu=$rpu) complete, cooling ${COOLDOWN_SESSION}s --- $(date)"
    sleep $COOLDOWN_SESSION
  done
done

echo "end=$(date +%s)" >> ".cache/rpu_sweep_phase2b_rerun_timestamps.txt"
echo "=== RPU Sweep Phase 2b RE-RUN complete === $(date)"
echo "Total: $(grep -c 'rpu_p2b_rerun' "$PROGRESS_FILE") / 75 runs"
