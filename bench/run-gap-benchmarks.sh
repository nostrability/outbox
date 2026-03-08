#!/usr/bin/env bash
# Master orchestrator: runs all gap-filling benchmark stages in sequence
# Addresses beads: outbox-0jx, outbox-uzu, outbox-2ak, outbox-zfe, outbox-rct, outbox-3sq
# Also closes outbox-evp (delta variance) via paired runs in each stage
#
# Total: ~315 invocations across 5 stages, estimated ~40 hours
#
# Usage: caffeinate -i bash bench/run-gap-benchmarks.sh
set -uo pipefail

BENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$BENCH_DIR"

STAGE_COOLDOWN=300

echo "========================================"
echo "  Gap-Filling Benchmark Campaign"
echo "========================================"
echo "Start: $(date)"
echo "Stages: 5 (hybrid, greedy, ndk-3yr, jp-fdndk, jp-nip66, connlimit)"
echo "Total runs: ~315"
echo

# ── Smoke test: greedy-thompson sanity check ──
echo "--- Smoke test: greedy-thompson cold start ---"
SMOKE_PK="6a0c596c1484eae2e8131a030f269944921e52619c1dd143a029c64ea6cd9731"  # Gato
SMOKE_LOG=".cache/greedy_thompson_smoke.log"
deno task bench "$SMOKE_PK" --algorithms greedy,greedy-thompson --verify --verify-window 604800 --fast --no-phase2-cache --output table > "$SMOKE_LOG" 2>&1
SMOKE_EXIT=$?
if [ $SMOKE_EXIT -ne 0 ]; then
  echo "ERROR: Smoke test failed (exit $SMOKE_EXIT). Fix greedy-thompson before continuing."
  echo "Log: $SMOKE_LOG"
  exit 1
fi
echo "Smoke test passed. Greedy-thompson output:"
grep -iE '(Greedy Set-Cover|Greedy\+Thompson)' "$SMOKE_LOG" | head -4
echo

# ── Stage 1: Hybrid+Thompson EN (outbox-0jx) ──
echo "========================================"
echo "  Stage 1: Hybrid+Thompson EN"
echo "========================================"
bash run-stage1-hybrid.sh

echo "Backing up after Stage 1..."
bash backup-results.sh
echo "--- Cooling ${STAGE_COOLDOWN}s before Stage 2 ---"
sleep $STAGE_COOLDOWN

# ── Stage 2: Greedy+Thompson EN (outbox-uzu) ──
echo "========================================"
echo "  Stage 2: Greedy+Thompson EN"
echo "========================================"
bash run-stage2-greedy.sh

echo "Backing up after Stage 2..."
bash backup-results.sh
echo "--- Cooling ${STAGE_COOLDOWN}s before Stage 3 ---"
sleep $STAGE_COOLDOWN

# ── Stage 3: NDK+Thompson 3yr EN (outbox-2ak) ──
echo "========================================"
echo "  Stage 3: NDK+Thompson 3yr EN"
echo "========================================"
bash run-stage3-ndk3yr.sh

echo "Backing up after Stage 3..."
bash backup-results.sh
echo "--- Cooling ${STAGE_COOLDOWN}s before Stage 4a ---"
sleep $STAGE_COOLDOWN

# ── Stage 4a: FD/NDK+Thompson JP (outbox-zfe) ──
echo "========================================"
echo "  Stage 4a: FD/NDK+Thompson JP"
echo "========================================"
bash run-stage4a-jp-fdndk.sh

echo "Backing up after Stage 4a..."
bash backup-results.sh
echo "--- Cooling ${STAGE_COOLDOWN}s before Stage 4b ---"
sleep $STAGE_COOLDOWN

# ── Stage 4b: JP NIP-66 comparison (outbox-rct) ──
echo "========================================"
echo "  Stage 4b: JP NIP-66 Comparison"
echo "========================================"
bash run-stage4b-jp-nip66.sh

echo "Backing up after Stage 4b..."
bash backup-results.sh
echo "--- Cooling ${STAGE_COOLDOWN}s before Stage 5 ---"
sleep $STAGE_COOLDOWN

# ── Stage 5: Adaptive connection limits (outbox-3sq) ──
echo "========================================"
echo "  Stage 5: Adaptive Connection Limits"
echo "========================================"
bash run-stage5-connlimit.sh

echo "Final backup..."
bash backup-results.sh

echo
echo "========================================"
echo "  Campaign Complete"
echo "========================================"
echo "End: $(date)"
echo
echo "Verification checklist:"
echo "  wc -l .cache/stage1_progress.log  # expect 60"
echo "  wc -l .cache/stage2_progress.log  # expect 60"
echo "  wc -l .cache/stage3_progress.log  # expect 30"
echo "  wc -l .cache/stage4a_progress.log # expect 60"
echo "  wc -l .cache/stage4b_progress.log # expect 60"
echo "  wc -l .cache/stage5_progress.log  # expect 45"
echo "  ls .cache/stage*_logs/*.tmp 2>/dev/null  # should be empty (no failures)"
