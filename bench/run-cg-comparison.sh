#!/usr/bin/env bash
# Coverage Guarantee + Sole-Source Exclusion Thompson benchmark:
#   ndk vs ndk-thompson vs ndk-thompson-cg
#
# Stage A: fiatjaf canary (3 sessions, 1yr) — quick check that CG fixes regression
# Stage B: full campaign (6 EN × 2 windows × 5 sessions = 60 runs)
#
# Three-way paired comparison from identical relay snapshots.
set -uo pipefail

cd "$(dirname "$0")"

ALGOS="ndk,ndk-thompson,ndk-thompson-cg"
SESSIONS=5
COOLDOWN_PROFILE=60
COOLDOWN_SESSION=120

NAMES="fiatjaf hodlbod jb55 ODELL Gato Telluride"
PK_fiatjaf="3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d"
PK_hodlbod="97c70a44366a6535c145b333f973ea86dfdc2d7a99da618c40c64705ad98e322"
PK_jb55="32e1827635450ebb3c5a7d12c1f8e7b2b514439ac10a67eef3d9fd9c5c68e245"
PK_ODELL="04c915daefee38317fa734444acee390a8269fe5810b2241e5e6dd343dfbecc9"
PK_Gato="6a0c596c1484eae2e8131a030f269944921e52619c1dd143a029c64ea6cd9731"
PK_Telluride="2c65940725bbf10b452197fba41c6cb14afd41e28e0be22aab49bf246b0c84e3"

WINDOWS="31536000 94608000"
CANARY_WINDOW="31536000"
CANARY_SESSIONS=3
PROGRESS_FILE=".cache/cg_comparison_progress.log"
touch "$PROGRESS_FILE"

COMMON="--verify --verify-concurrency 10 --nip66-filter liveness --no-phase2-cache --fast --output both"

echo "=== Coverage Guarantee Thompson Benchmark ==="
echo "Algorithms: $ALGOS"
echo "start=$(date +%s)" > ".cache/cg_comparison_timestamps.txt"
echo "Start: $(date)"
echo

# ─── Score clearing (resume-safe) ───
for WINDOW in $WINDOWS; do
  # Clear both ndk-thompson and ndk-thompson-cg scores for clean paired comparison
  MARKER=".cache/cg_${WINDOW}_scores_cleared"
  if [ ! -f "$MARKER" ]; then
    echo "Clearing ndk-thompson and ndk-thompson-cg scores for window=$WINDOW..."
    rm -f .cache/relay_scores_*_${WINDOW}_liveness_ndk-thompson.json
    rm -f .cache/relay_scores_*_${WINDOW}_liveness_ndk-thompson-cg.json
    touch "$MARKER"
  fi
done

# ─── Stage A: fiatjaf canary ───
echo "=== Stage A: fiatjaf canary ($CANARY_SESSIONS sessions, 1yr) ==="
LOGDIR=".cache/cg_comparison_logs/${CANARY_WINDOW}"
mkdir -p "$LOGDIR"

for session in $(seq 1 $CANARY_SESSIONS); do
  key="cg_canary_${CANARY_WINDOW}_fiatjaf_s${session}"
  logfile="$LOGDIR/fiatjaf_canary_s${session}.log"

  if grep -qF "$key" "$PROGRESS_FILE" 2>/dev/null; then
    echo "SKIP: $key"
    continue
  fi

  echo "[Canary S$session] fiatjaf — $(date)"
  deno task bench "$PK_fiatjaf" --algorithms "$ALGOS" --verify-window "$CANARY_WINDOW" $COMMON 2>&1 | tee "${logfile}.tmp"
  if [ ${PIPESTATUS[0]} -eq 0 ]; then
    mv "${logfile}.tmp" "$logfile"
    touch "${logfile}.done"
    echo "$key" >> "$PROGRESS_FILE"
    grep -iE '(Priority-Based|NDK\+Thompson)' "$logfile" | grep -iE 'Recall' | head -3
  else
    echo "FAILED: $key (log at ${logfile}.tmp)" >&2
  fi

  if grep -qi "rate.limit\|429\|too many\|throttl" "$logfile" "${logfile}.tmp" 2>/dev/null; then
    echo "WARNING: Rate limiting detected. Doubling cooldown."
    sleep $COOLDOWN_PROFILE
  fi

  echo "--- cooling ${COOLDOWN_PROFILE}s ---"
  sleep $COOLDOWN_PROFILE
done

# Check canary results: inspect relay.damus.io CG score vs regular Thompson
echo
echo "=== Stage A canary check ==="
CG_SCORE_FILE=$(ls -t .cache/relay_scores_*_${CANARY_WINDOW}_liveness_ndk-thompson-cg.json 2>/dev/null | head -1)
REG_SCORE_FILE=$(ls -t .cache/relay_scores_*_${CANARY_WINDOW}_liveness_ndk-thompson.json 2>/dev/null | head -1)
if [ -n "$CG_SCORE_FILE" ] && [ -n "$REG_SCORE_FILE" ]; then
  python3 -c "
import json, sys
for label, path in [('CG', '$CG_SCORE_FILE'), ('Regular', '$REG_SCORE_FILE')]:
    with open(path) as f:
        db = json.load(f)
    r = db.get('relays', {}).get('wss://relay.damus.io/', {})
    a = r.get('alpha', 1)
    b = r.get('beta', 1)
    score = a / (a + b)
    print(f'relay.damus.io {label} score: alpha={a:.1f} beta={b:.1f} E={score:.3f}')
" 2>&1
else
  echo "Score file(s) not found — skipping canary check"
fi

# ─── Stage B: full campaign ───
echo
echo "=== Stage B: full campaign (6 profiles × 2 windows × $SESSIONS sessions = 60 runs) ==="

for WINDOW in $WINDOWS; do
  LOGDIR=".cache/cg_comparison_logs/${WINDOW}"
  mkdir -p "$LOGDIR"

  for session in $(seq 1 $SESSIONS); do
    for name in $NAMES; do
      pk_var="PK_${name}"
      pk="${!pk_var}"
      key="cg_${WINDOW}_${name}_s${session}"
      logfile="$LOGDIR/${name}_s${session}.log"

      # Skip completed
      if grep -qF "$key" "$PROGRESS_FILE" 2>/dev/null; then
        echo "SKIP: $key"
        continue
      fi

      echo "[S$session W$WINDOW] $name — $(date)"
      deno task bench "$pk" --algorithms "$ALGOS" --verify-window "$WINDOW" $COMMON 2>&1 | tee "${logfile}.tmp"
      if [ ${PIPESTATUS[0]} -eq 0 ]; then
        mv "${logfile}.tmp" "$logfile"
        touch "${logfile}.done"
        echo "$key" >> "$PROGRESS_FILE"
        grep -iE '(Priority-Based|NDK\+Thompson)' "$logfile" | grep -iE 'Recall' | head -3
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
    echo "--- Session $session (W$WINDOW) complete, cooling ${COOLDOWN_SESSION}s --- $(date)"
    sleep $COOLDOWN_SESSION
  done
done

echo "end=$(date +%s)" >> ".cache/cg_comparison_timestamps.txt"
echo "=== Coverage Guarantee Thompson benchmark complete === $(date)"
