#!/usr/bin/env bash
# Backup benchmark results: tar locally + commit to data branch via worktree
# Safe to run while benchmarks are active (never touches current checkout)
# Run periodically: e.g., watch -n 7200 bash bench/backup-results.sh
set -uo pipefail

BENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$BENCH_DIR/.." && pwd)"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="/tmp/outbox-bench-backup"
DATA_BRANCH="data/thompson-variance"
WORKTREE_DIR="/tmp/outbox-data-worktree"

# ── 1. Local tar backup ──
mkdir -p "$BACKUP_DIR"

DIRS_TO_BACKUP=""
for d in 3yr-base-results thompson-variance-1yr thompson-variance-3yr 1yr-results 1yr-results-ndk hjo-results neutral-thompson-results .cache/stage1_hybrid_logs .cache/stage2_greedy_logs .cache/stage3_ndk3yr_logs .cache/stage4a_jp_fdndk_logs .cache/stage4b_jp_nip66_logs .cache/stage5_connlimit_logs .cache/cg2_comparison_logs .cache/cg3_comparison_logs; do
  [ -d "$BENCH_DIR/$d" ] && DIRS_TO_BACKUP="$DIRS_TO_BACKUP $d"
done

if [ -n "$DIRS_TO_BACKUP" ]; then
  (cd "$BENCH_DIR" && tar czf "$BACKUP_DIR/bench-results-${TIMESTAMP}.tar.gz" $DIRS_TO_BACKUP 2>/dev/null)
  echo "Local backup: $BACKUP_DIR/bench-results-${TIMESTAMP}.tar.gz"

  # Keep only last 5 backups
  ls -t "$BACKUP_DIR"/bench-results-*.tar.gz 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null
else
  echo "No result directories to backup yet"
  exit 0
fi

# Count completed log files
COMPLETED=$(find "$BENCH_DIR"/3yr-base-results "$BENCH_DIR"/thompson-variance-1yr "$BENCH_DIR"/thompson-variance-3yr "$BENCH_DIR"/1yr-results "$BENCH_DIR"/1yr-results-ndk "$BENCH_DIR"/hjo-results "$BENCH_DIR"/neutral-thompson-results "$BENCH_DIR"/.cache/stage*_logs -name "*.log" 2>/dev/null | xargs grep -l "Phase 2\|Headline metrics" 2>/dev/null | wc -l | tr -d ' ')
echo "Completed logs: $COMPLETED"

if [ "$COMPLETED" -eq 0 ]; then
  echo "No completed logs to commit to git"
  exit 0
fi

# ── 2. Commit to data branch via worktree (never touches current checkout) ──

# Create data branch if it doesn't exist locally
if ! git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$DATA_BRANCH" 2>/dev/null; then
  if git -C "$REPO_DIR" show-ref --verify --quiet "refs/remotes/origin/$DATA_BRANCH" 2>/dev/null; then
    echo "Creating local branch $DATA_BRANCH from origin/$DATA_BRANCH..."
    git -C "$REPO_DIR" worktree add -b "$DATA_BRANCH" "$WORKTREE_DIR" "origin/$DATA_BRANCH" 2>/dev/null || {
      echo "Failed to create worktree from remote. Tar backup succeeded, git backup skipped."
      exit 0
    }
  else
    echo "Creating orphan branch $DATA_BRANCH..."
    git -C "$REPO_DIR" worktree add --orphan -b "$DATA_BRANCH" "$WORKTREE_DIR" 2>/dev/null || {
      echo "Failed to create worktree. Tar backup succeeded, git backup skipped."
      exit 0
    }
    (cd "$WORKTREE_DIR" && git rm -rf . --quiet 2>/dev/null; echo "# Benchmark Results Data" > README.md; git add README.md; git commit -m "Initialize data branch" --quiet)
  fi
fi

# Ensure worktree exists
if [ ! -d "$WORKTREE_DIR/.git" ] && [ ! -f "$WORKTREE_DIR/.git" ]; then
  git -C "$REPO_DIR" worktree add "$WORKTREE_DIR" "$DATA_BRANCH" 2>/dev/null || {
    # Worktree might already exist but be stale
    git -C "$REPO_DIR" worktree remove "$WORKTREE_DIR" --force 2>/dev/null
    git -C "$REPO_DIR" worktree add "$WORKTREE_DIR" "$DATA_BRANCH" 2>/dev/null || {
      echo "Failed to create worktree. Tar backup succeeded, git backup skipped."
      exit 0
    }
  }
fi

# Copy log files to worktree
for d in 3yr-base-results thompson-variance-1yr thompson-variance-3yr 1yr-results 1yr-results-ndk hjo-results neutral-thompson-results .cache/stage1_hybrid_logs .cache/stage2_greedy_logs .cache/stage3_ndk3yr_logs .cache/stage4a_jp_fdndk_logs .cache/stage4b_jp_nip66_logs .cache/stage5_connlimit_logs .cache/cg2_comparison_logs .cache/cg3_comparison_logs; do
  if [ -d "$BENCH_DIR/$d" ]; then
    # Recreate directory structure under bench/
    find "$BENCH_DIR/$d" -name "*.log" | while read -r f; do
      REL="${f#$BENCH_DIR/}"
      mkdir -p "$WORKTREE_DIR/bench/$(dirname "$REL")"
      cp "$f" "$WORKTREE_DIR/bench/$REL"
    done
  fi
done

# Also copy the benchmark scripts for reproducibility
for s in run-3yr-base.sh run-thompson-variance-1yr.sh run-thompson-variance-3yr.sh run-1yr.sh run-1yr-ndk.sh run-hjo.sh run-neutral-thompson.sh run-stage1-hybrid.sh run-stage2-greedy.sh run-stage3-ndk3yr.sh run-stage4a-jp-fdndk.sh run-stage4b-jp-nip66.sh run-stage5-connlimit.sh run-gap-benchmarks.sh; do
  [ -f "$BENCH_DIR/$s" ] && cp "$BENCH_DIR/$s" "$WORKTREE_DIR/bench/$s"
done

# Commit from worktree
cd "$WORKTREE_DIR"
git add -A
if git diff --cached --quiet; then
  echo "No new data to commit"
else
  git commit -m "Benchmark data snapshot ${TIMESTAMP} (${COMPLETED} completed logs)" --quiet
  echo "Committed to $DATA_BRANCH"

  git push origin "$DATA_BRANCH" --quiet 2>/dev/null && echo "Pushed to origin/$DATA_BRANCH" || echo "Push failed — run: git -C $WORKTREE_DIR push origin $DATA_BRANCH"
fi

echo "Done: $(date)"
