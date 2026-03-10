# Agent Instructions

## Rules (always follow)

### 1. Every comparison must be apples-to-apples

When comparing benchmark numbers across profiles, algorithms, or sessions, STOP and verify both sides share the same starting state (cold vs warm), cache policy, NIP-66 filter mode, connection cap, verify-window, and benchmark run date. If any condition differs, annotate the difference explicitly or exclude the comparison. A warm-started profile (e.g., after a canary stage) is NOT comparable to a cold-started profile.

### 2. Every number must be verified against source data

Before committing any document, results page, or analysis that contains quantitative claims:

- Trace at least 3 values per table back to log files. Do not rely on memory.
- Verify all deltas use the same baseline. Do not mix "X vs CG3" and "X vs T" in the same sentence without labeling both.
- Verify that qualitative claims match the data (e.g., "SB wins on fiatjaf" requires SB > CG3 on fiatjaf, not SB < CG3).
- Verify counts (sole-source relays, follows, algorithms) against actual log output.
- If two values tie, both get winner highlighting. If a cell says "Tie", all tied algorithms must have the exact same number.

### 3. Score file paths use 16-char pubkey prefixes

Score files are saved as `relay_scores_{pubkey.slice(0,16)}_{window}_{filter}_{algo}.json`. In shell scripts, always use `${pk:0:16}` when constructing paths. No NIP-66 filter means NO suffix (not `_none_`). After writing any `rm` command that targets score files, immediately run `ls` with the same glob to verify it matches real files.

### 4. Multi-session benchmarks need cache isolation

- Always use `--no-phase2-cache` for benchmarks measuring recall across sessions.
- When a script clears scores for a fresh campaign, verify the clearing glob matches the actual filename pattern by testing it.
- If a script has a canary stage, document that the canary profile is warm-started in subsequent stages.

### 5. Code and docs must agree on semantics

When code uses a variable name like `alternatives` or `count`, verify the doc/comment formula matches what the code actually computes. Common bug: code counts "all items including self" but docs say "alternatives" (implying excluding self). Fix whichever is wrong immediately; do not leave the mismatch.

## Known Bugs (reference)

These are resolved bugs that recur in new code. Check for them when writing benchmark scripts:

1. **Pubkey prefix length.** `scorePath()` in `relay-scores.ts` uses `pubkey.slice(0, 16)`. Scripts using full 64-char pubkeys in `rm` commands silently delete nothing. Previously affected: `run-stage2-rerun.sh`, `run-stage4b-jp-nip66.sh`, `run-stage5-connlimit.sh`.

2. **Filter suffix.** `scorePath()` adds `_${filterMode}` only when filterMode is truthy. No filter = no suffix. Scripts targeting `*_none_*` miss all files. Previously affected: `run-stage1-hybrid.sh`, `run-stage4a-jp-fdndk.sh`.

3. **Phase 2 cache inflation.** Schema v1 stored union counts instead of per-relay event IDs, inflating sessions 2+. Fixed in schema v2. Always use `--no-phase2-cache`.

## Session End Checklist

Work is NOT done until pushed to remote.

```bash
git pull --rebase && git push && git status
```

- File issues for remaining work before ending
- Close finished issues, update in-progress items
- Never stop before `git push` succeeds
