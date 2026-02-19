# Relay Selection and Scoring Algorithms: Cross-Client Synthesis

## Overview

Relay selection is the central optimization problem of the outbox model: given a set of followed pubkeys and their declared relay preferences, choose the smallest set of relay connections that provides adequate coverage. Every client that implements outbox faces this problem, and the solutions span from formal set-cover algorithms to priority queues to reactive observable pipelines.

This document catalogs the relay selection approaches used across the analyzed projects, documents their scoring formulas, compares connection minimization strategies, and examines fallback behavior for edge cases.

---

## 1. Algorithm Taxonomy

The relay selection algorithms fall into five broad categories.

### 1a. Greedy Set-Cover

**Projects:** Gossip, Applesauce/noStrudel, Wisp, Amethyst (relay recommendation only)

The greedy set-cover approach iteratively selects the relay that covers the most still-uncovered pubkeys, then removes those pubkeys from the "needing" pool, and repeats until coverage is achieved or a connection cap is reached. This is a well-studied approximation algorithm (O(log n) approximation ratio for minimum set cover).

**Gossip** (`gossip-lib/src/relay_picker.rs`):
- Builds a scoreboard where each relay's aggregate score is the sum of composite scores (association x relay quality) for all pubkeys needing assignment.
- Picks the relay with the highest aggregate score.
- Assigns all pubkeys that scored above a threshold (> 5.0 or in the person's top 3 relays).
- Decrements each assigned pubkey's "remaining needed" counter (default: 2).
- Repeats until no progress.

**Applesauce** (`packages/core/src/helpers/relay-selection.ts`, `selectOptimalRelays()`):
- Builds a popularity map (count of users per relay).
- In each iteration, calculates the coverage ratio (covered_users / remaining_pool_size) for each unselected relay.
- Selects the relay with the highest score (default: coverage ratio; custom `score()` function can incorporate popularity).
- Removes users from the pool once they reach `maxRelaysPerUser`.
- Hard cap at `maxConnections`.

**Wisp** (`app/src/main/kotlin/com/wisp/app/relay/RelayScoreBoard.kt`):
- Builds a relay-to-authors map from followed users' write relays.
- Greedily picks the relay covering the most uncovered authors.
- Removes covered authors and repeats.
- Hard cap at `MAX_SCORED_RELAYS = 75`.
- No scoring function -- pure coverage maximization.

**Amethyst** (`quartz/.../RelayListRecommendationProcessor.kt`):
- Two-pass greedy set cover used for relay list recommendations (UI suggestion, not runtime routing).
- Pass 1: Pick most popular relay, remove served users, repeat until all covered.
- Pass 2: Ensure each user has at least 2 serving relays.

### 1b. Priority-Based (Connection Reuse)

**Projects:** NDK

NDK uses a three-tier priority system that favors connection reuse over global optimization.

**NDK** (`core/src/outbox/index.ts`, `chooseRelayCombinationForPubkeys()`):
1. **Priority 1 -- Already connected relays:** For each author, check if any of their relays are already connected. Assign if so.
2. **Priority 2 -- Already selected relays:** Check if any of the author's relays were already selected for other authors (connection reuse).
3. **Priority 3 -- Popularity-ranked relays:** Fall back to relays sorted by how many authors in the current set write to them (`getTopRelaysForAuthors()`).

There is no hard cap on total connections. The `relayGoalPerAuthor` (default 2) controls per-author redundancy, but total relay count grows with the diversity of the author set.

### 1c. Weighted Scoring with Stochastic Selection

**Projects:** Welshman/Coracle

Welshman assigns numeric weights to relays from multiple "scenarios" (author write relays, user read relays, tag hints), merges them, then applies a scoring formula with deliberate randomness.

**Welshman** (`packages/router/src/index.ts`, `scoreRelay()`):
```
score = -(quality * (1 + log(weight)) * random())
```
Relays are sorted by this score and the top N (default 3) are selected. The negative sign is for descending sort. The `random()` factor introduces stochastic variation so repeated queries may hit different relay sets.

### 1d. Progressive Multi-Tier Search

**Projects:** Amethyst (for relay discovery, not feed routing)

Amethyst uses a tiered search strategy that expands the search scope progressively when earlier tiers fail.

**Amethyst** (`FilterFindFollowMetadataForKey.kt`):
1. If outbox relays known: query those (stop).
2. If relay hints exist: query those.
3. If hints < 3: also query indexer relays + home relays.
4. If indexer relays < 2: also query search relays + connected relays.
5. If search relays < 2: query common/shared outbox relays.

With a load-shedding threshold at 300 follows (limits indexer queries to 2 per user, connected relays to 20).

For actual feed routing, Amethyst uses a reactive flow that maps each followed pubkey to their kind 10002 write relays and groups by relay, without a formal optimization pass.

### 1e. Observable/Reactive Pipeline

**Projects:** Nosotros, Applesauce (observable layer)

These projects model relay selection as a data flow pipeline where relay lists are observables that trigger re-selection when updated.

**Nosotros** (`src/hooks/subscriptions/subscribeOutbox.ts`):
- For each author in a filter, fetches their relay list (via tanstack-query with batching).
- Selects relays using `selectRelays()`: filters blacklisted/ignored/non-wss, then sorts by relay stats event count (most events first), then takes top N.
- Emits `[relay, filter]` tuples as an observable stream.
- Merges outbox-resolved pairs with static relays and relay hints (capped at 4).

**Applesauce** (`packages/core/src/observable/relay-selection.ts`):
- `includeMailboxes()` operator subscribes to kind 10002 events from the EventStore.
- When a kind 10002 event updates, the pipeline re-emits with updated relay URLs.
- noStrudel chains: `includeMailboxes` -> `includeFallbackRelays` -> `ignoreUnhealthyRelaysOnPointers` -> `debounceTime(500)` -> `selectOptimalRelays()`.

### 1f. Filter Decomposition (Bitflag Graph)

**Projects:** rust-nostr

rust-nostr decomposes nostr filters based on a per-pubkey-per-relay bitflag graph, choosing relay subsets by flag type.

**rust-nostr** (`sdk/src/client/gossip/resolver.rs`, `break_down_filter()`):
- For `authors`-only filters (outbox): maps each author to WRITE + HINT + RECEIVED relays. Produces per-relay filters with author subsets.
- For `#p`-only filters (inbox): maps each tagged pubkey to READ + HINT + RECEIVED relays.
- For both: union of all pubkeys, fetches ALL relay types, sends full filter to each.
- Orphan pubkeys (no known relays) fall back to client's READ relays.

---

## 2. Scoring Formulas

### 2a. Gossip: Two-Layer Composite Score

The composite score for a (pubkey, relay) pair is:

```
composite = association_score(pubkey, relay) * adjusted_relay_score(relay)
```

**Association score** (how strongly a pubkey is tied to a relay):

| Source | Base Weight | Decay |
|--------|------------|-------|
| Kind 10002 relay list (read or write flag) | 1.0 | None (binary) |
| Kind 3 contact list content | 1.0 (via read/write flags) | None (binary) |
| NIP-05 relay discovery | 1.0 (sets both read + write) | None (binary) |
| Successful event fetch (`last_fetched`) | 0.2 | Exponential, 14-day half-life |
| Relay hint from p-tag (`last_suggested`) | 0.1 | Exponential, 7-day half-life |

Declared relays (score >= 1.0) are classified as "strong" and preferred over "weak" relays (score < 1.0, from hints/fetches only). Weak relays are used only if no strong relays exist.

**Relay score** (general quality of the relay):

```
base_score = (rank / 9) * (0.5 + 0.5 * success_rate)
```

Where `rank` is user-assignable 0-9 (default 3) and `success_rate = success_count / (success_count + failure_count)`.

**Adjusted score** (used by the relay picker):

```
adjusted = base_score
if relay is not connected:  adjusted /= 2
if success_count > 0:       adjusted *= log10(success_count)
if success_count == 0:       adjusted = 0
```

**Typical value for a declared relay at default rank with good health:**

```
association = 1.0
relay = (3/9) * (0.5 + 0.5 * 1.0) * log10(100) = 0.333 * 2 = 0.666
composite = 1.0 * 0.666 = 0.666
```

**Source files:**
- `gossip-lib/src/storage/types/person_relay2.rs` (association_score)
- `gossip-lib/src/storage/types/relay3.rs` (score, adjusted_score)
- `gossip-lib/src/relay.rs` (get_best_relays_with_score)

### 2b. Welshman/Coracle: Log-Dampened Weighted Score

```
score = quality * (1 + log(weight)) * random()
```

Where:
- `weight` = sum of all scenario weights for the relay (e.g., author write relay = 1.0, tagged pubkey read relay = 0.5, reply author = 10.0)
- `quality` = 0.0 to 1.0 (see quality tiers below)
- `random()` = uniform [0, 1)

**Quality tiers** (`@welshman/app/src/relayStats.ts`):

| Condition | Quality |
|-----------|---------|
| Blocked by user | 0.0 |
| Any error in last minute | 0.0 |
| > 3 errors in last hour | 0.0 |
| > 10 errors in last day | 0.0 |
| Currently connected | 1.0 |
| Previously seen (has stats) | 0.9 |
| Standard unknown relay (not IP, not local, not onion, not ws://) | 0.8 |
| Weird URL (IP, local, onion, or plain ws://) | 0.7 |

The `log(weight)` dampens hub bias: a relay appearing in 100 author lists scores only ~5.6x a relay appearing once, not 100x.

**Source file:** `welshman/packages/router/src/index.ts`

### 2c. Applesauce: Coverage Ratio (Pluggable)

Default scoring:

```
score = covered_users / remaining_pool_size
```

The `score` parameter in `selectOptimalRelays()` is a pluggable callback:

```typescript
score?: (relay: string, coverageScore: number, popularity: number) => number
```

This allows noStrudel or other consumers to weight by relay health, latency, or other factors. With no custom function, pure coverage ratio drives selection.

**Source file:** `applesauce/packages/core/src/helpers/relay-selection.ts`

### 2d. Nosotros: Event-Count Ranking

```
relays.toSorted((a, b) => stats[b.relay].events - stats[a.relay].events)
     .slice(0, maxRelaysPerUser)
```

No composite formula -- just sort by how many events the relay has delivered (from the `relayStats` table), then take top N. Filtering (blacklist, permission check, wss-only) happens before sorting.

**Source file:** `nosotros/src/hooks/parsers/selectRelays.ts`

### 2e. Voyage: Multi-Factor Sort

Voyage sorts relay candidates by a tuple of factors (in priority order):

1. Not marked as spam (boolean)
2. Appears in event-relay tracking data (boolean: has the relay delivered events from authors?)
3. Already connected (boolean)
4. Not disconnected (boolean)

No numeric scoring formula. This is a lexicographic sort on four boolean criteria.

**Source file:** `voyage/app/src/main/java/com/dluvian/voyage/data/provider/RelayProvider.kt`

### 2f. rust-nostr: Received-Event Ranking

When multiple relays have the same bitflags for a pubkey, rust-nostr breaks ties by:

```
sort_by(received_events DESC, last_received_event DESC)
```

Then takes the top N per flag type. No composite numeric score -- just flag-based filtering followed by usage-frequency tiebreaking.

**Source file:** `gossip/nostr-gossip-memory/src/store.rs`

---

## 3. Connection Minimization

### Explicit Hard Caps

| Project | Cap | Default | Configurable |
|---------|-----|---------|--------------|
| Gossip | `max_relays` | 50 | Yes (user setting) |
| Applesauce/noStrudel | `maxConnections` | 20 | Yes (slider 0-30) |
| Wisp | `MAX_SCORED_RELAYS` | 75 | No (constant) |
| Nostur | `maxPreferredRelays` | 50 | No (constant) |
| NDK | None | N/A | No hard cap |
| Welshman/Coracle | None (per-scenario limit only) | 3 per scenario | Yes (`relay_limit` setting) |
| Voyage | `MAX_AUTOPILOT_RELAYS` | 25 | No (constant) |

### Minimization Strategies

**Gossip:** The greedy set-cover relay picker explicitly minimizes connections. When at `max_relays`, the picker only considers already-connected relays for new pubkey assignments. The picker halves the relay quality score for not-yet-connected relays (`adjusted_score` with `factors.connected`), creating a strong preference for consolidating onto existing connections.

**Applesauce/noStrudel:** The `selectOptimalRelays` function is designed specifically to minimize relay count. Its main loop iterates only up to `maxConnections`, and the coverage-ratio scoring ensures each selected relay adds maximal value. The `maxRelaysPerUser` parameter (default 5 in noStrudel) prevents diminishing returns where one well-connected user wastes selection slots.

**Wisp:** Pure set-cover with no scoring bias -- always picks the relay that covers the most uncovered authors. The `MAX_SCORED_RELAYS = 75` cap is generous enough that coverage typically completes well before the cap.

**NDK:** Does not directly minimize total connections. Instead, it minimizes *new* connections via the priority system: first reuse connected relays, then reuse already-selected relays, then add new ones. Temporary relay connections auto-disconnect after 30 seconds of non-use, providing indirect cleanup.

**Welshman/Coracle:** Minimizes connections per scenario (default limit 3), not globally. The `relay_limit` setting applies per routing call. Since the pool auto-closes sockets after 30 seconds of inactivity, total connections are bounded by concurrent activity rather than a hard cap.

**Voyage:** Multi-phase algorithm with a 25-relay cap for autopilot. Phase 1 (NIP-65 write relays) does greedy coverage; phase 2 (event-relay tracking) adds coverage for gaps; phases 3-4 handle fallbacks and redundancy.

**Nostur:** Uses a request-plan approach that sorts relays by coverage then greedily assigns pubkeys. The `skipTopRelays: 3` parameter intentionally avoids over-centralizing on the top 3 most popular relays, distributing load. Hard cap of 50 outbox connections with 10-minute idle cleanup.

---

## 4. Per-Pubkey Relay Limits

How many relays does each project try to use per followed pubkey?

| Project | Default Per-Pubkey | Configurable | Notes |
|---------|-------------------|--------------|-------|
| Gossip | 2 (`num_relays_per_person`) | Yes (user setting) | Applied as "remaining needed" counter in greedy picker |
| NDK | 2 (`relayGoalPerAuthor`) | Yes (per-subscription parameter) | Soft goal; may exceed if relays overlap |
| Welshman/Coracle | 3 (`relay_limit`) | Yes (`relay_limit` user setting) | Applied as top-N cutoff per scenario |
| Applesauce/noStrudel | 5 (`maxRelaysPerUser`) | Yes (slider 0-30) | Users removed from pool after hitting limit |
| Nosotros | 3 (`maxRelaysPerUser`) | Yes (settings slider 1-14) | Applied as `.slice(0, N)` after sorting |
| Voyage | 2 (`MAX_RELAYS_PER_PUBKEY`) for publishing | No (constant) | Autopilot does not enforce per-pubkey limit directly |
| Wisp | No per-pubkey limit | N/A | Scoreboard covers all; author may appear on many relays |
| rust-nostr | 3 write, 3 read, 1 hint, 1 most-used | No (compile-time defaults in `GossipRelayLimits`) | Separate limits per relay type |
| Nostur | 2 (for single-pubkey lookups) | No | `createRequestPlan` finds up to 2 relays per pubkey |
| Amethyst | No explicit limit | N/A | All declared write relays used; no per-pubkey cap |

Notable range: from Gossip's conservative 2 to noStrudel's generous 5. The choice reflects a trade-off between redundancy (higher values = more likely to find events) and connection efficiency (lower values = fewer total relays needed).

---

## 5. Fallback Strategies

When no kind 10002 relay list exists for a pubkey, each project must decide what to do with that "orphan" pubkey.

### Gossip: Weak Relay Fallback + Discovery Pipeline

1. Check for "weak" relay associations: relays where the person's events were previously fetched (`last_fetched`, base 0.2, 14-day decay) or suggested by hints (`last_suggested`, base 0.1, 7-day decay).
2. If any weak associations exist, use those.
3. If seeking a specific event and no relay list arrives within 15 seconds, fall back to the user's own READ relays.
4. Actively discovers relay lists: `subscribe_discover()` fetches kind 10002 from DISCOVER relays for all followed pubkeys with stale relay data (default: 20-minute staleness).

No hardcoded fallback relays at runtime. Discovery-driven only.

### Welshman/Coracle: Three Fallback Policies

- `addNoFallbacks`: Never add fallback relays (default for most scenarios).
- `addMinimalFallbacks`: Add 1 random default relay if zero relays found. Used by `getFilterSelections()`.
- `addMaximalFallbacks`: Fill up to the limit with default relays. Used for notifications, user metadata publishing.

Default relays come from `env.DEFAULT_RELAYS` (Coracle: `relay.damus.io`, `nos.lol`).

For indexed kinds (0, 3, 10002, 10050), queries are always sent to indexer relays (`relay.damus.io`, `purplepag.es`, `indexer.coracle.social`), providing a safety net.

### Amethyst: Tiered Hardcoded Fallbacks

1. Relay hints from bloom-filter-based `HintIndexer`.
2. `Constants.eventFinderRelays`: `nostr.wine`, `relay.damus.io`, `relay.primal.net`, `nostr.mom`, `nos.lol`, `nostr.bitcoiner.social`, `nostr.oxtr.dev`.
3. For own relays missing: `Constants.bootstrapInbox` adds `directory.yabu.me`.

The `rawOutboxRelays = true` mode skips all fallbacks and returns empty (used for pure relay analysis).

### NDK: Pool's Permanent Relays

Authors with no known relay data are assigned to the pool's permanent and connected relays:

```typescript
pool.permanentAndConnectedRelays().forEach((relay) => {
    relayToAuthorsMap.get(relay.url)?.push(author);
});
```

This means orphan pubkeys get broadcast to whatever relays the app has configured as permanent (typically 2-5 general-purpose relays).

### Applesauce/noStrudel: Configurable Fallback Relays

`setFallbackRelays()` replaces empty relay lists with a configurable fallback set. noStrudel defaults to `relay.primal.net` and `relay.damus.io`.

Applied as a pipeline stage before optimal relay selection:

```typescript
includeFallbackRelays(localSettings.fallbackRelays)
```

### rust-nostr: READ Relay Fallback

Orphan pubkeys (those in `BrokenDownFilters::Other`) fall back to the client's configured READ relays. The updater actively fetches relay lists for missing pubkeys via negentropy sync from DISCOVERY or READ relays.

### Voyage: Four-Phase Fallback

1. Phase 1 (NIP-65 write relays): covers pubkeys with kind 10002.
2. Phase 2 (event-relay tracking): covers pubkeys seen on specific relays but lacking kind 10002.
3. Phase 3: uncovered pubkeys assigned to user's READ relays + already-selected relays.
4. Phase 4: pubkeys with only 1 relay get redundancy via READ relays.

### Wisp: Broadcast Fallback

`OutboxRouter.subscribeByAuthors()` sends authors without relay lists to `sendToAll` -- all configured general relays.

### Nosotros: Environment Variable Fallback

If a pubkey has no relay list, `FALLBACK_RELAYS` (from environment config) are used.

### Nostur: Same as Amethyst Pattern

Falls back to the user's own read relays for any pubkey without known outbox relays. The `createRequestPlan()` sends the original (un-routed) filters to the user's configured relays as a baseline.

### Summary Table

| Project | Fallback Source | Active Discovery | Hardcoded Relays |
|---------|----------------|-----------------|------------------|
| Gossip | Weak associations -> user's READ relays | Yes (20-min staleness) | None at runtime |
| Welshman/Coracle | Default relays (env-configured) | Via indexer relays | relay.damus.io, nos.lol |
| NDK | Pool permanent relays | Yes (outbox pool) | purplepag.es, nos.lol |
| Applesauce/noStrudel | Configurable fallback list | Via lookup relays | relay.primal.net, relay.damus.io |
| Amethyst | Hint bloom filter -> eventFinderRelays | Yes (tiered progressive) | 7 hardcoded relays |
| rust-nostr | Client's READ relays | Yes (negentropy sync) | None |
| Voyage | READ relays + selected relays | Yes (lazySubNip65s) | None |
| Wisp | All general relays (sendToAll) | Yes (requestMissingRelayLists) | relay.damus.io, relay.primal.net |
| Nosotros | FALLBACK_RELAYS env var | Via tanstack-query fetch | Configurable |
| Nostur | User's own read relays | Yes (OutboxLoader since: optimization) | None at runtime |

---

## 6. Long-Tail Handling

Users on obscure, personal, or low-population relays present a challenge: their relays may be unknown, slow, unreliable, or behind authentication. Here is how each project handles them.

### Gossip: Decay-Based Inclusion

Gossip's temporal decay system naturally handles obscure relays. If a user's events have ever been fetched from a personal relay, that relay gets an association score of 0.2 with 14-day half-life. If the user declares it in kind 10002, it gets a full 1.0 and the greedy picker will include it as long as the relay has nonzero health.

The risk: a single obscure relay serving one user still consumes a connection slot. Gossip mitigates this by the `adjusted_score` -- relays with zero `success_count` get score 0, so never-connected obscure relays cannot be selected until they have been tried at least once.

The 0.125 threshold for "all outboxes" computation ensures that even a declared relay at default rank with marginal health (50% success, not connected) still qualifies: `1.0 * (3/9) * (0.5 + 0.5*0.5) * log10(10) / 2 = 0.125`.

### Welshman/Coracle: Stochastic Exploration

The `Math.random()` factor in the scoring formula means low-weight relays occasionally get selected. A personal relay that only one author uses gets `weight = 1`, so `log(1) + 1 = 1`, while a popular relay with 100 users gets `log(100) + 1 = 5.6`. With the random multiplier, the personal relay has roughly a 1/5.6 chance of beating the popular one in any given selection round. Over many queries, it will occasionally be chosen, providing gradual coverage.

Quality gating means dead obscure relays (recent errors) are excluded entirely (quality = 0).

### Applesauce/noStrudel: Coverage-Driven Inclusion

The set-cover algorithm inherently handles the long tail: after popular relays are selected and cover most users, remaining uncovered users can only be reached via their personal relays. The algorithm will select those personal relays in later iterations as long as `maxConnections` has not been exhausted. With noStrudel's default of 20 max connections, there is room for ~15 long-tail relays after the top 5 popular ones cover the bulk.

noStrudel's settings UI shows "orphaned" users (users with relays that were not selected), making the long-tail problem visible to users.

### NDK: Organic Connection Reuse

NDK's priority system does not specifically optimize for long-tail relays. A user on a unique personal relay will trigger a new temporary connection (30-second auto-disconnect) when their events are needed. The connection is not pooled or reused unless another author also writes to that relay. This means personal relays are connected on-demand and cleaned up quickly.

### Amethyst: Bloom Filter Hint Aggregation

Amethyst's `HintIndexer` bloom filters accumulate relay hints from all sources (p-tags, event receipts, nprofile references). Even if a user has no kind 10002, the bloom filter may contain hints for their relay from third-party mentions. The `hintsForKey()` query iterates all known relays and checks bloom filter membership, which can surface obscure relays that have been mentioned in the gossip network.

The eventFinderRelays fallback (7 large relays) provides a baseline for users whose personal relays are completely unknown.

### Wisp: Generous Relay Cap

Wisp's `MAX_SCORED_RELAYS = 75` is the most generous hard cap among the greedy set-cover implementations. This leaves ample room for long-tail relays. Additionally, Wisp's relay discovery process (RelayProber) specifically targets "middle tier" relays by dropping the top 5 mega-relays and requiring frequency >= 3, which promotes diversity.

### rust-nostr: Multi-Source Graph

The bitflag model accumulates relay associations from five independent sources (READ, WRITE, HINT, RECEIVED, PRIVATE_MESSAGE). Even if kind 10002 is missing, a personal relay can be discovered via HINT flags (from p-tag relay hints) or RECEIVED flags (the relay delivered an event from that author). The `most_used_relays_per_user: 1` default ensures at least one empirically-verified relay is included per pubkey.

### Nostur: Top-Relay Skipping

Nostur's `skipTopRelays: 3` parameter in `createRequestPlan()` deliberately avoids the three most populated relays for the Following feed. This forces the algorithm to use less popular relays, indirectly improving coverage for users on smaller relays at the cost of potentially missing events from users who only write to popular relays.

---

## 7. Comparative Analysis Table

| Characteristic | Gossip | NDK | Welshman/Coracle | Applesauce/noStrudel | Amethyst | rust-nostr | Voyage | Wisp | Nosotros | Nostur |
|---|---|---|---|---|---|---|---|---|---|---|
| **Algorithm class** | Greedy set-cover | Priority + popularity | Weighted stochastic | Greedy set-cover | Reactive flow (+ set-cover for recommendations) | Filter decomposition by bitflags | Multi-phase greedy | Greedy set-cover | Observable pipeline | Greedy coverage sort |
| **Scoring formula** | association x relay_quality | Popularity count | quality x log(weight) x random() | coverage_ratio (pluggable) | None (direct mapping) | received_events tiebreak | Lexicographic boolean tuple | None (pure coverage) | Event-count sort | Coverage sort |
| **Hard connection cap** | 50 | None | None (per-scenario limit) | 20 | None (dynamic pool) | None | 25 | 75 | None | 50 |
| **Per-pubkey relay target** | 2 | 2 | 3 | 5 | All declared | 3 write + 3 read + 1 hint + 1 received | 2 (publish) | No limit | 3 | 2 |
| **Stochastic selection** | No | No | Yes (Math.random) | No | No | No | No | No | No | No |
| **Temporal decay** | Yes (14-day, 7-day) | No (2-min LRU TTL) | No | No | No | No | No | No | No | No |
| **Relay health in selection** | Yes (success_rate, avoid_until) | Yes (flapping detection, backoff) | Yes (error-count tiers, quality gate) | Yes (RelayLiveness: online/offline/dead) | Yes (RelayOfflineTracker) | No (freshness check only) | Yes (spam flag, connected status) | No | Yes (events count) | Yes (penalty box, stale cleanup) |
| **Reactivity model** | Imperative (singleton) | Imperative (LRU + event emitter) | Callback injection | RxJS observables | Kotlin StateFlow | Trait-based + semaphores | Room LiveData | SharedPreferences + recompute | RxJS observables | Swift imperative |
| **Fallback for missing relay list** | Weak associations -> READ relays | Pool permanent relays | Default relays (configurable policy) | Configurable fallback list | Bloom hints -> hardcoded 7 relays | Client READ relays | READ relays + selected | sendToAll general relays | ENV fallback relays | User's read relays |
| **Active relay list discovery** | Yes (20-min staleness) | Yes (outbox pool sub) | Yes (indexer relays) | Yes (lookup relays) | Yes (progressive tiered) | Yes (negentropy sync) | Yes (lazy sub) | Yes (requestMissing) | Yes (tanstack-query) | Yes (since: optimization) |
| **Handles kind 10050 (NIP-17 DM relays)** | Yes | No | Yes (messaging mode) | No | Yes | Yes | No | No | No | Yes |
| **User-configurable limits** | Yes (both caps) | Per-subscription | Yes (relay_limit) | Yes (both sliders 0-30) | No | No (compile-time) | No | No | Yes (1-14 slider) | No |
| **Connection reuse preference** | Yes (halves score for unconnected) | Yes (priority 1 + 2) | Yes (quality 1.0 for connected) | Yes (via health filtering) | Yes (pool diffing) | No explicit preference | Yes (boolean sort factor) | No | No | No |
| **Blocklist support** | Yes (rank 0 + URL ban) | Yes (relayConnectionFilter) | Yes (kind 10006 blocked list, quality 0) | Yes (blacklist parameter) | Yes (NIP-51 encrypted blocked list) | No | Yes (spam flag) | No | Yes (pool.blacklisted) | Yes (SPECIAL_PURPOSE_RELAYS) |

---

## Key Findings

**1. Set-cover dominates.** Four of the ten projects (Gossip, Applesauce, Wisp, and Nostur in a simplified form) use greedy set-cover as their core relay selection algorithm. This is unsurprising -- minimizing relay connections while covering all followed users is literally the weighted set cover problem.

**2. Scoring complexity varies widely.** Gossip has the most sophisticated scoring (two-layer multiplicative with temporal decay), while Wisp has the simplest (pure coverage count). The added complexity in Gossip's scoring provides better handling of stale data and relay health at the cost of more state to maintain.

**3. Only Welshman uses randomness.** Coracle/Welshman is the only project that introduces stochastic variation into relay selection. This has the benefit of distributing load across relays over time and occasionally discovering better paths, but makes debugging harder since the same query may produce different relay sets.

**4. Connection caps range from 20 to 75.** The tightest cap is noStrudel at 20 (configurable), and the loosest is Wisp at 75 (hardcoded). Several projects (NDK, Welshman, Nosotros, Amethyst) have no global cap at all, relying on per-scenario limits and connection cleanup instead.

**5. Per-pubkey targets cluster around 2-3.** Most projects aim for 2-3 relays per followed pubkey, with noStrudel as the outlier at 5. The consensus around 2-3 reflects the practical trade-off: 1 is fragile (relay goes down = missed events), 2 provides basic redundancy, 3+ adds diminishing returns.

**6. Fallback strategies reflect philosophical differences.** Gossip is the most principled (no hardcoded fallbacks at runtime; data-driven only). Amethyst is the most pragmatic (7 hardcoded large relays). Most others split the difference with configurable fallback lists.

**7. Reactive architectures are gaining ground.** Applesauce, Nosotros, and Amethyst all use reactive/observable patterns where relay list updates automatically trigger re-selection. This is architecturally cleaner than NDK's manual `refreshRelayConnections()` approach but requires more sophisticated data flow management.
