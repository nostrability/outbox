#!/usr/bin/env bash
# Relays-per-user (RPU) sweep at 1yr with Thompson (outbox-8j9)
#
# Clients default to 2-3 relays per author based on fiatjaf-only 7d Greedy data.
# This sweep validates the sweet spot at 1yr with FD+Thompson and plain FD.
#
# Phase 1: Reduced sweep (3 profiles × 3 rpu × 5 sessions = 45 runs)
#   to detect the trend before committing to the full matrix.
# Phase 2 (optional): Full sweep (6 profiles × 5 rpu × 5 sessions = 150 runs per algo)
#
# Note: some authors have fewer than 5 write relays. The script reports
# the distribution of declared write relay counts for each profile.
set -uo pipefail

cd "$(dirname "$0")"

SESSIONS=5
WINDOW=31536000
COOLDOWN_PROFILE=60
COOLDOWN_SESSION=120

# Phase 1: 3 representative profiles (small/medium/large follow graphs)
# Phase 2: all 6 EN profiles
PHASE1_NAMES="jb55 ODELL Telluride"
PHASE2_NAMES="fiatjaf hodlbod Gato"
PK_fiatjaf="3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d"
PK_hodlbod="97c70a44366a6535c145b333f973ea86dfdc2d7a99da618c40c64705ad98e322"
PK_jb55="32e1827635450ebb3c5a7d12c1f8e7b2b514439ac10a67eef3d9fd9c5c68e245"
PK_ODELL="04c915daefee38317fa734444acee390a8269fe5810b2241e5e6dd343dfbecc9"
PK_Gato="6a0c596c1484eae2e8131a030f269944921e52619c1dd143a029c64ea6cd9731"
PK_Telluride="2c65940725bbf10b452197fba41c6cb14afd41e28e0be22aab49bf246b0c84e3"

# Phase 1 RPU values: endpoints + midpoint
PHASE1_RPUS="1 3 5"
# Phase 2 full sweep
PHASE2_RPUS="2 4"

PROGRESS_FILE=".cache/rpu_sweep_progress.log"
touch "$PROGRESS_FILE"

echo "=== RPU Sweep: Relays-per-User at 1yr (outbox-8j9) ==="
echo "start=$(date +%s)" > ".cache/rpu_sweep_timestamps.txt"
echo "Start: $(date)"
echo

run_rpu_set() {
  local names="$1" rpus="$2" algos="$3" phase_label="$4"

  for rpu in $rpus; do
    LOGDIR=".cache/rpu_sweep_logs/${WINDOW}/rpu${rpu}"
    mkdir -p "$LOGDIR"

    # Clear Thompson scores per RPU value to avoid cross-contamination
    # Marker scoped to phase_label so Phase 2b clearing isn't skipped by Phase 1 markers
    MARKER=".cache/rpu_sweep_${WINDOW}_rpu${rpu}_${phase_label}_${algos}_scores_cleared"
    if [ ! -f "$MARKER" ]; then
      echo "Clearing Thompson scores for rpu=$rpu ($algos)..."
      if echo "$algos" | grep -q "fd-thompson"; then
        rm -f .cache/relay_scores_*_${WINDOW}_liveness_fd-thompson.json
      fi
      if echo "$algos" | grep -q "greedy-thompson"; then
        rm -f .cache/relay_scores_*_${WINDOW}_liveness_greedy-thompson.json
      fi
      touch "$MARKER"
    fi

    COMMON="--verify --verify-window $WINDOW --verify-concurrency 10 --nip66-filter liveness --no-phase2-cache --fast --output both --relays-per-user $rpu"

    for session in $(seq 1 $SESSIONS); do
      for name in $names; do
        pk_var="PK_${name}"
        pk="${!pk_var}"
        key="rpu_sweep_${WINDOW}_rpu${rpu}_${name}_s${session}_${algos}"
        logfile="$LOGDIR/${name}_s${session}.log"

        # Skip completed
        if grep -qF "$key" "$PROGRESS_FILE" 2>/dev/null; then
          echo "SKIP: $key"
          continue
        fi

        echo "[$phase_label rpu=$rpu S$session] $name — $(date)"
        deno task bench "$pk" --algorithms "$algos" $COMMON 2>&1 | tee "${logfile}.tmp"
        if [ ${PIPESTATUS[0]} -eq 0 ]; then
          mv "${logfile}.tmp" "$logfile"
          touch "${logfile}.done"
          echo "$key" >> "$PROGRESS_FILE"
          grep -iE '(Filter Decomposition|FD\+Thompson|Greedy|Greedy\+Thompson)' "$logfile" | grep -iE 'Recall' | head -4
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
}

# ─── Phase 1: Reduced sweep with FD+Thompson ───
echo "=== Phase 1: Reduced sweep (3 profiles × 3 rpu × $SESSIONS sessions = 45 runs) ==="
run_rpu_set "$PHASE1_NAMES" "$PHASE1_RPUS" "rust-nostr,fd-thompson" "P1"

echo
echo "Phase 1 complete. Review results before proceeding to Phase 2."
echo "Completed: $(grep -c 'rpu_sweep' "$PROGRESS_FILE") runs"
echo

# ─── Phase 2: Fill in remaining RPU values and profiles ───
echo "=== Phase 2: Fill sweep (remaining rpu values + profiles) ==="
# Add rpu=2,4 for Phase 1 profiles
run_rpu_set "$PHASE1_NAMES" "$PHASE2_RPUS" "rust-nostr,fd-thompson" "P2a"
# Add all RPU values for remaining profiles
run_rpu_set "$PHASE2_NAMES" "$PHASE1_RPUS $PHASE2_RPUS" "rust-nostr,fd-thompson" "P2b"

echo "end=$(date +%s)" >> ".cache/rpu_sweep_timestamps.txt"
echo "=== RPU Sweep complete === $(date)"
echo "Total: $(grep -c 'rpu_sweep' "$PROGRESS_FILE") runs"
