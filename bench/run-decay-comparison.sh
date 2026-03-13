#!/usr/bin/env bash
# Decay Comparison Benchmark (outbox-ojy)
#
# Compares 4 Thompson decay configurations:
#   1. nodecay:  --decay-factor 1.0                (pure accumulation)
#   2. default:  (no flags)                        (0.95/session, current behavior)
#   3. decay90:  --decay-factor 0.90 --decay-unit session  (aggressive session decay)
#   4. hour95:   --decay-factor 0.95 --decay-unit hour     (Welshman PR #53 claimed rate)
#
# Phase 1: 3 representative profiles × 4 configs × 5 sessions = 60 runs
#
# Pitfalls addressed:
#   P2: All configs use fd-thompson → same score file.  Run SEQUENTIALLY with full
#       score clearing between each config.  Cannot parallelize.
#   P3: hour-based decay depends on wall-clock inter-session timing.  We log
#       timestamps so the reader knows the actual elapsed hours.
#   P4: Must not run concurrently with Item 1 (RPU re-run).
#
# AGENTS.md compliance:
#   Rule 1: Same window (31536000), cap (20), NIP-66 (liveness), --no-phase2-cache
#   Rule 2: After completion, trace 3 values per config back to log files
#   Rule 3: Score clearing uses ls before rm for verification
#   Rule 4: No markers — configs run sequentially with full clearing; progress file
#           tracks (config, profile, session) tuples for resume.
#   Rule 5: default config (no flags) must match hardcoded 0.95/session behavior
set -uo pipefail

cd "$(dirname "$0")" || exit 1

SESSIONS=5
WINDOW=31536000
COOLDOWN_PROFILE=60
COOLDOWN_SESSION=120

# Phase 1: 3 representative profiles (small/medium/large follow graphs)
NAMES="jb55 ODELL Telluride"
PK_jb55="32e1827635450ebb3c5a7d12c1f8e7b2b514439ac10a67eef3d9fd9c5c68e245"
PK_ODELL="04c915daefee38317fa734444acee390a8269fe5810b2241e5e6dd343dfbecc9"
PK_Telluride="2c65940725bbf10b452197fba41c6cb14afd41e28e0be22aab49bf246b0c84e3"

# Decay configurations (run SEQUENTIALLY per P2)
# Format: "config_name:flags"
DECAY_CONFIGS=(
  "nodecay:--decay-factor 1.0"
  "default:"
  "decay90:--decay-factor 0.90 --decay-unit session"
  "hour95:--decay-factor 0.95 --decay-unit hour"
)

PROGRESS_FILE=".cache/decay_comparison_progress.log"
TIMESTAMP_FILE=".cache/decay_comparison_timestamps.txt"
LOGDIR=".cache/decay_comparison_logs/${WINDOW}"
mkdir -p "$LOGDIR"
touch "$PROGRESS_FILE"

echo "=== Decay Comparison Benchmark (outbox-ojy) ==="
echo "Profiles: $NAMES"
echo "Configs: ${#DECAY_CONFIGS[@]} (nodecay, default, decay90, hour95)"
echo "Sessions: $SESSIONS"
echo "Total runs: $((${#DECAY_CONFIGS[@]} * 3 * $SESSIONS)) (4 × 3 × 5)"
echo "start=$(date +%s)" > "$TIMESTAMP_FILE"
echo "Start: $(date)"
echo

COMMON="--verify --verify-window $WINDOW --verify-concurrency 10 --nip66-filter liveness --no-phase2-cache --fast --output both"

for config_entry in "${DECAY_CONFIGS[@]}"; do
  config_name="${config_entry%%:*}"
  decay_flags="${config_entry#*:}"

  echo
  echo "╔══════════════════════════════════════════════════╗"
  echo "║  Config: $config_name"
  if [ -n "$decay_flags" ]; then
    echo "║  Flags: $decay_flags"
  else
    echo "║  Flags: (none — default 0.95/session)"
  fi
  echo "╚══════════════════════════════════════════════════╝"
  echo

  # Check if this entire config is already complete
  config_done=$(grep -c "decay_${config_name}_" "$PROGRESS_FILE" 2>/dev/null) || config_done=0
  expected=$((3 * $SESSIONS))
  if [ "$config_done" -ge "$expected" ]; then
    echo "SKIP config $config_name: all $expected runs complete"
    continue
  fi

  # Clear ALL fd-thompson scores before this config (P2: shared score file namespace)
  # Only clear if this config has not started any runs yet (resume-safe)
  if [ "$config_done" -eq 0 ]; then
    echo "Clearing fd-thompson scores for config=$config_name..."
    # Rule 3: Verify glob with ls BEFORE rm
    echo "Score files to clear:"
    ls -la .cache/relay_scores_*_${WINDOW}_liveness_fd-thompson.json 2>&1 || echo "(none found)"
    rm -f .cache/relay_scores_*_${WINDOW}_liveness_fd-thompson.json
    echo "config_clear_${config_name}=$(date +%s)" >> "$TIMESTAMP_FILE"
  else
    echo "Config $config_name partially complete ($config_done/$expected), resuming without clearing."
  fi

  for session in $(seq 1 $SESSIONS); do
    # Log wall-clock time for each session (P3: hour-based timing dependency)
    session_start=$(date +%s)
    echo "session_start_${config_name}_s${session}=${session_start}" >> "$TIMESTAMP_FILE"

    for name in $NAMES; do
      pk_var="PK_${name}"
      pk="${!pk_var}"
      key="decay_${config_name}_${WINDOW}_${name}_s${session}"
      logfile="$LOGDIR/${config_name}_${name}_s${session}.log"

      # Skip completed
      if grep -qF "$key" "$PROGRESS_FILE" 2>/dev/null; then
        echo "SKIP: $key"
        continue
      fi

      echo "[${config_name} S$session] $name — $(date)"
      if [ -n "$decay_flags" ]; then
        deno task bench "$pk" --algorithms fd-thompson $decay_flags $COMMON 2>&1 | tee "${logfile}.tmp"
      else
        deno task bench "$pk" --algorithms fd-thompson $COMMON 2>&1 | tee "${logfile}.tmp"
      fi
      if [ ${PIPESTATUS[0]} -eq 0 ]; then
        mv "${logfile}.tmp" "$logfile"
        touch "${logfile}.done"
        echo "$key" >> "$PROGRESS_FILE"
        grep -iE '(FD\+Thompson|Filter Decomposition)' "$logfile" | grep -iE 'Recall' | head -4
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

    session_end=$(date +%s)
    echo "session_end_${config_name}_s${session}=${session_end}" >> "$TIMESTAMP_FILE"
    elapsed=$((session_end - session_start))
    echo "--- Session $session (${config_name}) complete in ${elapsed}s, cooling ${COOLDOWN_SESSION}s --- $(date)"
    sleep $COOLDOWN_SESSION
  done
done

echo "end=$(date +%s)" >> "$TIMESTAMP_FILE"
echo
echo "=== Decay Comparison complete === $(date)"
echo "Total: $(grep -c 'decay_' "$PROGRESS_FILE") / $((${#DECAY_CONFIGS[@]} * 3 * $SESSIONS)) runs"
echo
echo "Post-hoc analysis:"
echo "  1. S1 scores should be identical across all configs (cold start verification)"
echo "  2. Higher decay → less session-over-session improvement"
echo "  3. Default (no flags) should produce identical S1 to prior FD+Thompson runs"
echo "  4. Check inter-session intervals in $TIMESTAMP_FILE for hour-based decay impact"
