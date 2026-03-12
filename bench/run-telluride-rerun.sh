#!/usr/bin/env bash
set -uo pipefail

# Re-run corrupted Telluride benchmarks (11 runs total)
# Stage 1 Hybrid 1yr: s4, s5 (2 runs)
# Stage 1 Hybrid 3yr: s1, s2 (2 runs) -- not strictly needed (3/5 is OK) but fills out
# Stage 2 Greedy 1yr: s1-s5 (5 runs) -- total loss, all 5 needed
# Stage 3 NDK 3yr: s1-s4 (4 runs) -- only s5 valid, need 4 more
# Total: 11 + (2 optional Stage 1 3yr) = 11 runs

BENCHDIR="$(cd "$(dirname "$0")" && pwd)"
cd "$BENCHDIR" || exit 1

PUBKEY="2c65940725bbf10b452197fba41c6cb14afd41e28e0be22aab49bf246b0c84e3"
COOLDOWN=60
PROGRESS_FILE=".cache/telluride_rerun_progress.log"
touch "$PROGRESS_FILE"

run_bench() {
  local stage="$1" window="$2" session="$3" algos="$4" extra_flags="$5" logdir="$6"
  local key="${stage}_${window}_Telluride_s${session}"

  if grep -qF "$key" "$PROGRESS_FILE" 2>/dev/null; then
    echo "SKIP (already done): $key"
    return 0
  fi

  mkdir -p "$logdir"
  local logfile="${logdir}/Telluride_s${session}.log"

  echo "$(date '+%H:%M:%S') RUN: $key"
  deno task bench "$PUBKEY" \
    --algorithms "$algos" \
    --verify --verify-window "$window" --verify-concurrency 10 \
    --no-phase2-cache --fast --output both \
    $extra_flags \
    2>&1 | tee "${logfile}.tmp"

  if [ ${PIPESTATUS[0]} -eq 0 ]; then
    mv "${logfile}.tmp" "$logfile"
    touch "${logfile}.done"
    echo "$key" >> "$PROGRESS_FILE"
    echo "$(date '+%H:%M:%S') DONE: $key"
  else
    echo "$(date '+%H:%M:%S') FAILED: $key (log at ${logfile}.tmp)" >&2
  fi

  sleep "$COOLDOWN"
}

echo "=== Telluride Re-run: 11 corrupted benchmarks ==="
echo "Started: $(date)"

# --- Stage 1: Hybrid 1yr (s4, s5) ---
# No NIP-66 filter, no Thompson scores to clear (ditto-outbox has no filter suffix)
echo ""
echo "--- Stage 1: Hybrid 1yr (s4, s5) ---"
for s in 4 5; do
  run_bench "stage1" "31536000" "$s" "ditto-mew,ditto-outbox" "" ".cache/stage1_hybrid_logs/31536000"
done

# --- Stage 1: Hybrid 3yr (s1, s2) ---
echo ""
echo "--- Stage 1: Hybrid 3yr (s1, s2) ---"
for s in 1 2; do
  run_bench "stage1" "94608000" "$s" "ditto-mew,ditto-outbox" "" ".cache/stage1_hybrid_logs/94608000"
done

# --- Stage 2: Greedy 1yr (s1-s5) ---
# Need fresh Thompson scores for greedy-thompson
echo ""
echo "--- Stage 2: Greedy 1yr (s1-s5) ---"
echo "Clearing greedy-thompson scores for 1yr..."
rm -f ".cache/relay_scores_${PUBKEY:0:16}_31536000_liveness_greedy-thompson.json"
for s in 1 2 3 4 5; do
  run_bench "stage2" "31536000" "$s" "greedy,greedy-thompson" "--nip66-filter liveness" ".cache/stage2_greedy_logs/31536000"
done

# --- Stage 3: NDK 3yr (s1-s4) ---
# Need fresh Thompson scores for ndk-thompson 3yr
# s5 already valid, so we run s1-s4 with fresh learning that builds up to s5's level
echo ""
echo "--- Stage 3: NDK 3yr (s1-s4) ---"
echo "Clearing ndk-thompson scores for 3yr..."
rm -f ".cache/relay_scores_${PUBKEY:0:16}_94608000_liveness_ndk-thompson.json"
for s in 1 2 3 4; do
  run_bench "stage3" "94608000" "$s" "ndk,ndk-thompson" "--nip66-filter liveness" ".cache/stage3_ndk3yr_logs"
done

echo ""
echo "=== Telluride Re-run Complete ==="
echo "Finished: $(date)"
echo "Completed: $(wc -l < "$PROGRESS_FILE") / 11"
