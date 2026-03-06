#!/usr/bin/env bash
# 3yr baseline re-benchmark: all non-Thompson algorithms, 6 profiles, single run
# Deterministic algorithms need 1 run; welshman is stochastic but stateless
set -uo pipefail

ALGOS="greedy,welshman,ndk,rust-nostr"
COMMON="--verify --verify-window 94608000 --nip66-filter liveness --no-phase2-cache --fast --output table"

NAMES="fiatjaf hodlbod jb55 ODELL Gato Telluride"
PK_fiatjaf="3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d"
PK_hodlbod="97c70a44366a6535c145b333f973ea86dfdc2d7a99da618c40c64705ad98e322"
PK_jb55="32e1827635450ebb3c5a7d12c1f8e7b2b514439ac10a67eef3d9fd9c5c68e245"
PK_ODELL="04c915daefee38317fa734444acee390a8269fe5810b2241e5e6dd343dfbecc9"
PK_Gato="6a0c596c1484eae2e8131a030f269944921e52619c1dd143a029c64ea6cd9731"
PK_Telluride="2c65940725bbf10b452197fba41c6cb14afd41e28e0be22aab49bf246b0c84e3"

LOGDIR="3yr-base-results"
mkdir -p "$LOGDIR"

echo "=== 3yr Base Algorithm Benchmark ==="
echo "Algorithms: $ALGOS"
echo "Start: $(date)"

for name in $NAMES; do
  eval "pk=\$PK_${name}"
  logfile="$LOGDIR/${name}.log"

  if [ -f "${logfile}.done" ]; then
    echo "SKIP (already done): $name"
    continue
  fi

  echo "=== $name (3yr, base algorithms) === $(date)"
  deno task bench "$pk" --algorithms "$ALGOS" $COMMON > "${logfile}.tmp" 2>&1
  if [ $? -eq 0 ]; then
    mv "${logfile}.tmp" "$logfile"
    touch "${logfile}.done"
    grep -E '(Greedy|Stochastic|Priority|Filter Decomposition)' "$logfile" | grep -E 'Recall' | head -4
  else
    echo "FAILED: $name (3yr base) — see ${logfile}.tmp"
  fi
  echo
  echo "--- Cooling 60s ---"
  sleep 60
done

echo "=== 3yr base benchmark complete === $(date)"
