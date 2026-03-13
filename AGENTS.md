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
- **Marker files must be scoped to everything they guard.** If a score-clearing step should run once per (RPU value × profile group), the marker filename must include both the RPU value AND the profile group (or phase label). A marker scoped only to RPU will silently skip clearing when a second profile group reuses the same RPU value. Before committing any marker-gated `rm`, trace through all phases/loops that share the marker namespace and verify each group gets its own clearing pass.

### 5. Code and docs must agree on semantics

When code uses a variable name like `alternatives` or `count`, verify the doc/comment formula matches what the code actually computes. Common bug: code counts "all items including self" but docs say "alternatives" (implying excluding self). Fix whichever is wrong immediately; do not leave the mismatch.

### 6. Indexer cache poisoning must be detected and prevented

The benchmark caches contact list fetches (kind-3 + kind-10002) with a default 1-hour TTL. If an indexer relay (e.g., purplepag.es) intermittently returns 0 events, the empty result was historically cached and poisoned all subsequent runs. This is now mitigated: the tool retries once on 0 follows, never caches 0-follows results, and exits with code 1 on failure. But defense-in-depth is still required for large profiles.

**Prevention:**
- **Use `--cache-ttl` for campaigns.** Set `--cache-ttl 86400000` (24h) so the input data cache survives the entire campaign. This ensures all sessions use identical follow/relay-list data (also improves Rule 1 apples-to-apples consistency). Pre-warm the cache with a standalone fetch before starting.
- Before any campaign, delete the target profile's cache file and do a standalone test fetch to verify the indexer returns the expected follow count. Do not start benchmark runs until verified.
- After each run, check for "0 follows found" in the log. If detected, halt, delete the bad cache, wait for rate-limit cooldown, re-fetch, and only resume once the cache is verified good.
- The benchmark tool now exits with code 1 on "0 follows" and retries once before giving up. Campaign scripts using `PIPESTATUS[0]` will correctly detect failure. Legacy scripts that don't check exit codes should also grep for "0 follows" as a safety net.
- Use longer cooldowns for large profiles (90s+/profile, 180s+/session) to avoid triggering indexer rate limits.

**Detection after the fact:**
- Cache files under 10KB for profiles with 100+ follows are almost certainly bad (a good cache for a 2000-follow profile is ~2MB).
- A "0 follows" run that is marked complete in the progress file will be silently skipped on resume — the gap becomes invisible unless you cross-check progress entries against actual log content.

## Known Bugs (reference)

These are resolved bugs that recur in new code. Check for them when writing benchmark scripts:

1. **Pubkey prefix length.** `scorePath()` in `relay-scores.ts` uses `pubkey.slice(0, 16)`. Scripts using full 64-char pubkeys in `rm` commands silently delete nothing. Previously affected: `run-stage2-rerun.sh`, `run-stage4b-jp-nip66.sh`, `run-stage5-connlimit.sh`.

2. **Filter suffix.** `scorePath()` adds `_${filterMode}` only when filterMode is truthy. No filter = no suffix. Scripts targeting `*_none_*` miss all files. Previously affected: `run-stage1-hybrid.sh`, `run-stage4a-jp-fdndk.sh`.

3. **Phase 2 cache inflation.** Schema v1 stored union counts instead of per-relay event IDs, inflating sessions 2+. Fixed in schema v2. Always use `--no-phase2-cache`.

4. **Marker scope too narrow.** `run-per-pubkey-sweep.sh` used markers scoped to RPU value only (`rpu_sweep_${WINDOW}_rpu${rpu}_scores_cleared`). Phase 1 created markers for rpu=1,3,5. Phase 2a created markers for rpu=2,4. When Phase 2b ran different profiles at the same RPU values, the existing markers prevented score clearing — Thompson priors leaked across RPU values for Phase 2b profiles. Fix: scope markers to (RPU × phase) or (RPU × profile-set), or clear per-profile scores explicitly with `${pk:0:16}` in the glob instead of wildcards.

5. **0-follows cache poisoning.** `main.ts` cached fetch results before checking `follows.length === 0`. When a fresh fetch returned 0 follows (indexer timeout on large contact lists like Telluride's ~2,750 follows at the time), the empty result was cached for 1 hour. All subsequent sessions within the TTL silently used the bad cache. Affected: Telluride (23 failures), Gato (19), ODELL (11). Additionally, `fetchBenchmarkInput` returned successfully with 0 follows (exit code 0), so campaign scripts marked the run as complete. Fix: only cache results with >0 follows, retry once with 5s backoff on 0 follows, exit with code 1 on 0 follows so scripts detect failure.

6. **Recurring Telluride data loss.** Telluride (2,784 follows) has lost data in every major campaign: Stage 1 Hybrid (rerun needed), CG comparison 1yr (S4-S5 lost), CG comparison 3yr (S1-S5 all lost), CG2 comparison (S4 lost), RPU sweep rpu=1 (S1-S3), rpu=2 (S1-S5 all lost), use-case comparison (S3-S5 lost). Root cause is Bug #5 (0-follows cache poisoning from indexer fetch failure on large kind-3 events) combined with the benchmark tool previously exiting 0 on failure, so campaign scripts marked empty runs as complete. The code fix (retry + no-cache-on-empty + exit 1) prevents future poisoning, but **campaigns must still validate Telluride data completeness post-hoc**: check that all expected `.done` markers exist, that no log file contains "0 follows", and that Telluride's testable-reliable author count is ≥1200 (not 0 or single-digits). Any campaign publishing Telluride numbers should note the session count actually obtained.

## Session End Checklist

Work is NOT done until pushed to remote.

```bash
git pull --rebase && git push && git status
```

- File issues for remaining work before ending
- Close finished issues, update in-progress items
- Never stop before `git push` succeeds
