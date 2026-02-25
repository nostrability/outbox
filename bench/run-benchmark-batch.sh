#!/bin/bash
# Benchmark batch runner: multi-profile × multi-window × multi-session × filter modes
#
# Resumable: each completed run writes a marker to a progress file.
# On restart, it skips already-completed runs.
#
# Usage:
#   chmod +x run-benchmark-batch.sh
#   ./run-benchmark-batch.sh
#
# To reset progress:
#   rm bench/.cache/batch_progress.log

set -uo pipefail  # no -e: individual failures logged, batch continues

ALGOS="greedy,welshman,greedy-epsilon,welshman-thompson,mab"
CONCURRENCY=10
SESSIONS=5
PROGRESS_FILE=".cache/batch_progress.log"

# Profiles ordered by follow count (ascending), Telluride last (risk 5)
PROFILES=(
  "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6"  # fiatjaf ~200
  "npub1dgx9jmq5sn4w96qnrgps7f5egjfpu5npnswazsaq98ryafkdjucshaaej8"  # Gato ~400
  "npub1m5af0yqwxdla858364pz9pp0rvj9vel8epgh4nafadsjf4dgmunqes0s9s"  # ValderDama ~1000
  "npub193jegpe9h0csh7al22mkcstqva2ygyny7ura8kwvrn4tsmtnl4lsrxny6k"  # Telluride ~2800
)

PROFILE_NAMES=(
  "fiatjaf"
  "gato"
  "valderdama"
  "telluride"
)

WINDOWS=(604800 31536000 94608000)
WINDOW_NAMES=("7d" "1yr" "3yr")

mkdir -p .cache
touch "$PROGRESS_FILE"

run_if_needed() {
  local key="$1"; shift
  if grep -qF "$key" "$PROGRESS_FILE" 2>/dev/null; then
    echo "SKIP (already done): $key"
    return 0
  fi
  echo ""
  echo "=========================================="
  echo "RUN: $key"
  echo "=========================================="
  if "$@"; then
    echo "$key" >> "$PROGRESS_FILE"
    echo "DONE: $key"
  else
    echo "FAILED: $key (will retry on next batch run)"
  fi
}

total_runs=$((${#PROFILES[@]} * ${#WINDOWS[@]} * SESSIONS * 2))
completed=0

echo "=== Benchmark Batch ==="
echo "Profiles: ${#PROFILES[@]}"
echo "Windows: ${WINDOWS[*]}"
echo "Sessions per config: $SESSIONS"
echo "Filter modes: liveness, none"
echo "Total runs: $total_runs"
echo "Algorithms: $ALGOS"
echo "Concurrency: $CONCURRENCY"
echo ""

for pi in "${!PROFILES[@]}"; do
  npub="${PROFILES[$pi]}"
  pname="${PROFILE_NAMES[$pi]}"
  echo ""
  echo "######################################"
  echo "# Profile: $pname ($npub)"
  echo "######################################"

  for wi in "${!WINDOWS[@]}"; do
    window="${WINDOWS[$wi]}"
    wname="${WINDOW_NAMES[$wi]}"

    for session in $(seq 1 $SESSIONS); do
      for filter in "liveness" "none"; do
        key="${pname}_w${wname}_s${session}_${filter}"

        if [ "$filter" = "liveness" ]; then
          run_if_needed "$key" \
            deno task bench "$npub" --verify --verify-window "$window" \
              --verify-concurrency "$CONCURRENCY" --algorithms "$ALGOS" \
              --nip66-filter liveness --fast
        else
          run_if_needed "$key" \
            deno task bench "$npub" --verify --verify-window "$window" \
              --verify-concurrency "$CONCURRENCY" --algorithms "$ALGOS" --fast
        fi

        completed=$((completed + 1))
        echo "--- Progress: $completed / $total_runs ---"

        # 30s cooldown between runs (same profile)
        sleep 30
      done
    done
  done

  echo ""
  echo "--- Profile $pname done, cooling 90s ---"
  sleep 90
done

echo ""
echo "=== Batch complete ==="
echo "Total runs attempted: $total_runs"
echo "Progress file: $PROGRESS_FILE"
