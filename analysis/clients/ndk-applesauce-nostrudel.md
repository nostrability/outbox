# NDK, Applesauce, noStrudel

---

## NDK (TypeScript, Browser/Node)

### Quick Facts
| Setting | Value |
|---------|-------|
| Algorithm | Priority-based (connected > already-selected > popular) |
| Connection cap | None (prefers reusing existing connections) |
| Per-pubkey target | 2 (`relayGoalPerAuthor`) |
| Fallback relays | purplepag.es, nos.lol (outbox pool); app's permanent relays |
| Health tracking | Flapping detection + exponential backoff; >50% disconnect in 5s = system-wide reset |
| NIP-17 DM inbox | No |
| Configurable | Per-subscription relay goal |

### How It Works
Outbox is enabled by default — any app calling `ndk.subscribe()` with author filters gets outbox routing without code changes. The OutboxTracker fetches kind 10002 (kind 3 as fallback) in batches of 400 via a dedicated outbox pool (purplepag.es, nos.lol), cached in a 100k-entry LRU with 2-minute TTL. Relay selection prioritizes already-connected relays, then relays already selected for other authors (connection reuse), then popularity-ranked relays. When relay lists update, NDK re-routes affected active subscriptions via `refreshRelayConnections()`.

### Notable
- Zero-config outbox: transparent to consuming applications. No setup required beyond calling `ndk.subscribe()`.
- Temporary relay connections auto-disconnect after 30s of non-use. Prevents connection bloat from one-off outbox relays.
- System-wide disconnect detection: >50% of relays disconnecting within 5s triggers coordinated reconnection with reset backoff (handles sleep/wake cycles).
- No hard connection cap. Minimizes *new* connections via priority system rather than limiting total count.
- `relay-ranking.ts` has a TODO: "Here is the place where the relay scoring can be used to modify the weights of the relays" — the integration point for Thompson.
- `score.ts` is a placeholder: `export type NDKRelayScore = number;` with TODO "this will probably get more sophisticated."
- `OutboxItem` has an unused `relayUrlScores: Map<string, number>` field — ready for Thompson scores.

### Benchmark Results: NDK+Thompson Sampling

NDK+Thompson integrates Thompson scoring into NDK's priority cascade, replacing the popularity-based ranking in the third tier. Two variants were tested (1yr, NIP-66 liveness, cap@20, 5 learning sessions):

**Gato (399 follows, 106 testable-reliable authors):**

| Session | NDK Baseline | NDK+Thompson (Priority) | NDK+Thompson (Unified) | Welshman+Thompson |
|---|---|---|---|---|
| S1 (cold) | 16.6% | 20.2% | 19.8% | 25.3% |
| S2 | 16.3% | 22.0% | 24.3% | 26.6% |
| S3 | 15.1% | 17.0% | 18.6% | 30.0% |
| S4 | 16.4% | 22.8% | 26.1% | 28.9% |
| S5 | 16.4% | 22.8% | 21.1% | 30.6% |

**Telluride (2,784 follows, 1241-1296 testable-reliable authors):**

| Session | NDK Baseline | NDK+Thompson (Priority) | NDK+Thompson (Unified) | Welshman+Thompson |
|---|---|---|---|---|
| S1 (cold) | 22.9% | 22.9% | 27.8% | 44.3% |
| S2 | 22.6% | 34.5% | 22.0% | 45.8% |
| S3 | 24.1% | 37.6% | 38.7% | 49.0% |
| S4 | 22.7% | 38.3% | 39.9% | 44.3% |
| S5 | 20.4% | 37.6% | 38.0% | 43.6% |

**Key findings:**

1. **Thompson works in NDK's architecture** — the priority cascade does NOT neutralize it. Mean gain: +10pp (6-profile, 1yr). High variance: -19pp (fiatjaf) to +30pp (hodlbod).
2. **NDK baseline stays flat** — deterministic, no learning. NDK+Thompson improves over sessions while baseline stays at ~14-32%.
3. **Priority variant is more stable** than Unified. The Unified variant (1.5x bonus replacing hard cascade) shows inconsistent results (Telluride S2: 22% vs 34.5% for Priority).
4. **Welshman+Thompson outperforms NDK+Thompson by ~12pp mean** (42% vs 30% at 1yr). This gap is structural — Welshman's per-user relay budgeting gives Thompson full scoring control vs NDK's cascade constraining it to the third tier.
5. **High per-profile variance** — fiatjaf regresses because NDK's cascade concentrates on relay.damus.io, which happens to work well for that follow graph. Thompson's exploration disrupts this alignment.
6. **Concentration improves** — NDK+Thompson distributes load more evenly (Gini: 0.82→0.77, HHI: 0.299→0.234 for Telluride).

### Upgrade Path

**Minimal integration (recommended):** Add Thompson scoring to `getTopRelaysForAuthors()` in `relay-ranking.ts`, replacing the raw popularity count with `(1 + Math.log(popularity)) * sampleBeta(α, β)`. Preserve the priority cascade. This is the "Priority" variant benchmarked above.

**Integration points in NDK codebase:**
- `core/src/relay/score.ts` — extend `NDKRelayScore` with Beta distribution params
- `core/src/outbox/relay-ranking.ts` — replace popularity sort with Thompson-scored sort
- `core/src/outbox/index.ts` — pass scorer to `chooseRelayCombinationForPubkeys()`
- `core/src/outbox/tracker.ts` — persist Thompson priors via cache adapter (addresses existing TODO)

**Estimated effort:** ~80 LOC for Beta sampler + Thompson scorer, ~20 LOC for relay-ranking integration, ~15 LOC for cache adapter interface. See `bench/src/algorithms/ndk-thompson.ts` for the benchmark implementation that models this integration.

---

## Applesauce (TypeScript, Library)

### Quick Facts
| Setting | Value |
|---------|-------|
| Algorithm | Greedy set-cover with pluggable scoring |
| Connection cap | Configurable `maxConnections` |
| Per-pubkey target | Configurable `maxRelaysPerUser` |
| Fallback relays | Configurable fallback list |
| Health tracking | RelayLiveness: online → offline → dead (terminal after 5 failures) |
| NIP-17 DM inbox | No |
| Configurable | Yes (both caps, custom score function) |

### How It Works
Applesauce provides pure functions and RxJS operators for composable outbox pipelines. The core `selectOptimalRelays()` function runs greedy set-cover: iteratively picks the relay covering the most uncovered users, recalculates coverage each step, stops at `maxConnections`. A pluggable `score(relay, coverageScore, popularity)` callback lets clients customize scoring. The OutboxModel chains: contacts → blacklist filter → mailbox enrichment → optimal relay selection, all as reactive observables.

### Notable
- Modular library — clients compose pipelines from pure functions + RxJS operators. Not tied to any specific client.
- RelayLiveness is a three-state machine: online → offline → dead. Dead after 5 consecutive failures is permanent for the session. Exponential backoff: base 30s, max 5min.
- `ignoreUnhealthyRelaysOnPointers` operator reactively re-runs selection when relays go offline, automatically adapting the relay set.

---

## noStrudel (TypeScript, Browser)

### Quick Facts
| Setting | Value |
|---------|-------|
| Algorithm | Applesauce greedy set-cover + health filtering |
| Connection cap | 20 (user-adjustable slider 0–30) |
| Per-pubkey target | 5 (user-adjustable slider 0–30) |
| Fallback relays | relay.primal.net, relay.damus.io |
| Health tracking | Applesauce RelayLiveness persisted to localforage (5s base backoff) |
| NIP-17 DM inbox | No |
| Configurable | Yes (both sliders, fallback relays) |

### How It Works
noStrudel is a full Nostr client using Applesauce as its library layer. Its outbox pipeline chains: includeMailboxes → includeFallbackRelays → ignoreUnhealthyRelays → debounceTime(500ms) → selectOptimalRelays. The 500ms debounce waits for kind 10002 events to arrive from multiple relays before running selection. All settings (max connections, max relays per user) are reactive observables — changing any setting triggers re-selection. An LRU cache of 30 outbox maps avoids recomputation.

### Notable
- Only client with a user-facing outbox debugger: coverage %, per-relay table with user counts, "users by relay count" breakdown, missing relay list users, and "orphaned" users whose relays were all dropped during optimization. Color-coded: green ≥80%, yellow ≥50%, red <50%.
- Uses purplepag.es as its single lookup/indexer relay for kind 10002 fetching.
- RelayLiveness state persisted to localforage across sessions, with a more aggressive 5s base backoff (vs Applesauce default of 30s).
