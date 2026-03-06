#!/usr/bin/env bash
# 1yr NDK + FD baseline + NDK+Thompson benchmark: 6 profiles × 5 sessions
# Complements run-1yr.sh (which covers greedy, welshman, welshman-thompson, fd-thompson)
set -uo pipefail

ALGOS="ndk,rust-nostr,ndk-thompson"
COMMON="--verify --verify-window 31536000 --nip66-filter liveness --no-phase2-cache --fast --output table"

NAMES="fiatjaf hodlbod jb55 ODELL Gato Telluride"
PK_fiatjaf="3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d"
PK_hodlbod="97c70a44366a6535c145b333f973ea86dfdc2d7a99da618c40c64705ad98e322"
PK_jb55="32e1827635450ebb3c5a7d12c1f8e7b2b514439ac10a67eef3d9fd9c5c68e245"
PK_ODELL="04c915daefee38317fa734444acee390a8269fe5810b2241e5e6dd343dfbecc9"
PK_Gato="6a0c596c1484eae2e8131a030f269944921e52619c1dd143a029c64ea6cd9731"
PK_Telluride="2c65940725bbf10b452197fba41c6cb14afd41e28e0be22aab49bf246b0c84e3"

SESSIONS=5
LOGDIR="1yr-results-ndk"
mkdir -p "$LOGDIR"

for session in $(seq 1 $SESSIONS); do
  for name in $NAMES; do
    eval "pk=\$PK_${name}"
    logfile="$LOGDIR/${name}_s${session}.log"

    # Skip if already completed
    if [ -f "$logfile" ] && grep -q "Phase 2" "$logfile" 2>/dev/null; then
      echo "SKIP (already done): ${name}_s${session}"
      continue
    fi

    echo "=== Session $session: $name (1yr, ndk/fd/ndk-thompson) ==="
    deno task bench "$pk" --algorithms "$ALGOS" $COMMON > "$logfile" 2>&1 || true
    grep -E '(Priority|Filter Decomp|NDK\+Thompson)' "$logfile" | grep -E 'Recall' | head -3
    echo
    sleep 30
  done
  echo "--- Session $session complete, cooling 60s ---"
  sleep 60
done

echo "=== All 1yr NDK runs complete ==="
