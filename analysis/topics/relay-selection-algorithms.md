# Relay Selection and Scoring Algorithms: Cross-Client Synthesis

## Key Findings

1. **Set-cover dominates.** Four of ten projects (Gossip, Applesauce, Wisp, Nostur) use greedy set-cover. Minimizing relay connections while covering all followed users is the weighted set cover problem.
2. **Scoring complexity varies widely.** Gossip has two-layer multiplicative scoring with temporal decay; Wisp has pure coverage count. More complexity = better stale data handling at the cost of more state.
3. **Only Welshman uses randomness.** Stochastic variation distributes load and discovers better paths, but makes debugging harder.
4. **Connection caps range 20-75.** Tightest: noStrudel at 20. Loosest: Wisp at 75. NDK, Welshman, Nosotros, and Amethyst have no global cap.
5. **Per-pubkey targets cluster around 2-3.** noStrudel is the outlier at 5. Consensus reflects the tradeoff: 1 is fragile, 2 provides redundancy, 3+ has diminishing returns.
6. **Fallback strategies reflect philosophy.** Gossip: no hardcoded fallbacks (data-driven only). Amethyst: 7 hardcoded large relays. Most others: configurable fallback lists.
7. **Reactive architectures gaining ground.** Applesauce, Nosotros, and Amethyst use reactive/observable patterns where relay list updates auto-trigger re-selection.

---

## Comparative Analysis

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
| **Kind 10050 (NIP-17 DM)** | Yes | No | Yes (messaging mode) | No | Yes | Yes | No | No | No | Yes |
| **User-configurable limits** | Yes (both caps) | Per-subscription | Yes (relay_limit) | Yes (both sliders 0-30) | No | No (compile-time) | No | No | Yes (1-14 slider) | No |
| **Connection reuse preference** | Yes (halves score for unconnected) | Yes (priority 1 + 2) | Yes (quality 1.0 for connected) | Yes (via health filtering) | Yes (pool diffing) | No explicit preference | Yes (boolean sort factor) | No | No | No |
| **Blocklist support** | Yes (rank 0 + URL ban) | Yes (relayConnectionFilter) | Yes (kind 10006 blocked list, quality 0) | Yes (blacklist parameter) | Yes (NIP-51 encrypted blocked list) | No | Yes (spam flag) | No | Yes (pool.blacklisted) | Yes (SPECIAL_PURPOSE_RELAYS) |

---

## Algorithm Taxonomy

### Greedy Set-Cover
**Projects:** Gossip, Applesauce/noStrudel, Wisp, Amethyst (relay recommendation only)

- Iteratively selects the relay covering the most uncovered pubkeys, removes them, repeats until coverage or cap reached
- **Gossip:** Scores relays by sum of (association x relay quality) per pubkey. Picks highest. Assigns pubkeys scoring > 5.0 or in top 3. Default 2 relays per person.
- **Applesauce:** Coverage ratio scoring (covered_users / remaining_pool). Custom `score()` callback can incorporate popularity/health. Hard cap at `maxConnections`.
- **Wisp:** Pure coverage maximization, no scoring. Hard cap at 75 relays.
- **Amethyst:** Two-pass for relay recommendations only (not runtime). Pass 1: greedy coverage. Pass 2: ensure each user has >= 2 relays.

### Priority-Based (Connection Reuse)
**Projects:** NDK

- Priority 1: author's relays already connected
- Priority 2: relays already selected for other authors
- Priority 3: popularity-ranked relays (`getTopRelaysForAuthors()`)
- No hard cap on total connections. `relayGoalPerAuthor` (default 2) controls per-author redundancy.

### Weighted Scoring with Stochastic Selection
**Projects:** Welshman/Coracle

- Merges weighted relay selections from multiple scenarios, applies: `score = -(quality * (1 + log(weight)) * random())`
- Top N selected (default 3). Random factor means repeated queries may hit different relays.

### Progressive Multi-Tier Search
**Projects:** Amethyst (relay discovery only)

- Tiers: outbox relays -> relay hints -> indexer + home relays -> search + connected relays -> shared outbox relays
- Load-shedding at 300 follows (limits indexer queries to 2/user, connected relays to 20)

### Observable/Reactive Pipeline
**Projects:** Nosotros, Applesauce (observable layer)

- Relay lists modeled as observables; updates auto-trigger re-selection
- **Nosotros:** Per-author relay list fetch via tanstack-query, sorted by event count, top N selected, merged with hints (cap 4)
- **Applesauce/noStrudel pipeline:** `includeMailboxes` -> `includeFallbackRelays` -> `ignoreUnhealthyRelays` -> `debounceTime(500)` -> `selectOptimalRelays()`

### Filter Decomposition (Bitflag Graph)
**Projects:** rust-nostr

- Decomposes filters based on per-pubkey-per-relay bitflags (READ, WRITE, HINT, RECEIVED, PRIVATE_MESSAGE)
- `authors`-only: WRITE + HINT + RECEIVED relays per author
- `#p`-only: READ + HINT + RECEIVED per tagged pubkey
- Both: union of all relay types
- Orphans fall back to client's READ relays

---

## Scoring Formulas

| Project | Formula | Key Details |
|---------|---------|-------------|
| **Gossip** | `association_score(pubkey, relay) * adjusted_relay_score(relay)` | Association: kind 10002 = 1.0 (binary); fetched = 0.2 (14-day decay); hint = 0.1 (7-day decay). Relay score: `(rank/9) * (0.5 + 0.5*success_rate)`. Halved if not connected. Zeroed if never connected. Files: `person_relay2.rs`, `relay3.rs` |
| **Welshman** | `quality * (1 + log(weight)) * random()` | Weight = sum of scenario weights. Quality tiers: blocked=0, recent errors=0, connected=1.0, seen=0.9, standard unknown=0.8, weird URL=0.7. File: `router/src/index.ts` |
| **Applesauce** | `covered_users / remaining_pool_size` | Pluggable `score(relay, coverageScore, popularity)` callback. Default is pure coverage ratio. File: `relay-selection.ts` |
| **Nosotros** | `sort by relay stats event count DESC, take top N` | No composite formula. Filter blacklist/permissions/wss-only before sorting. File: `selectRelays.ts` |
| **Voyage** | Lexicographic sort: not-spam, has-event-data, connected, not-disconnected | Four boolean criteria, no numeric score. File: `RelayProvider.kt` |
| **rust-nostr** | `sort by received_events DESC, last_received_event DESC` | Tiebreaker only -- primary selection is flag-based filtering. File: `nostr-gossip-memory/src/store.rs` |

---

## Connection Minimization

| Project | Cap | Default | Configurable |
|---------|-----|---------|--------------|
| Gossip | `max_relays` | 50 | Yes |
| Applesauce/noStrudel | `maxConnections` | 20 | Yes (slider 0-30) |
| Wisp | `MAX_SCORED_RELAYS` | 75 | No |
| Nostur | `maxPreferredRelays` | 50 | No |
| NDK | None | N/A | No hard cap |
| Welshman/Coracle | None (per-scenario limit) | 3 per scenario | Yes (`relay_limit`) |
| Voyage | `MAX_AUTOPILOT_RELAYS` | 25 | No |

Key strategies:
- **Gossip:** At `max_relays`, only considers already-connected relays. Halves score for unconnected relays.
- **Applesauce/noStrudel:** `selectOptimalRelays` iterates only up to `maxConnections`. `maxRelaysPerUser` (default 5) prevents one user wasting slots.
- **NDK:** Minimizes *new* connections via priority system. Temporary connections auto-disconnect after 30s.
- **Welshman:** Per-scenario limit (default 3). Pool auto-closes after 30s inactivity.
- **Voyage:** 25-relay cap. Phase 1 (NIP-65 write) does greedy coverage; Phase 2 (event-relay tracking) fills gaps.
- **Nostur:** `skipTopRelays: 3` avoids mega-hubs. 50-relay cap with 10-min idle cleanup.

---

## Per-Pubkey Relay Limits

| Project | Default Per-Pubkey | Configurable | Notes |
|---------|-------------------|--------------|-------|
| Gossip | 2 (`num_relays_per_person`) | Yes | "Remaining needed" counter in greedy picker |
| NDK | 2 (`relayGoalPerAuthor`) | Yes (per-subscription) | Soft goal; may exceed if relays overlap |
| Welshman/Coracle | 3 (`relay_limit`) | Yes | Top-N cutoff per scenario |
| Applesauce/noStrudel | 5 (`maxRelaysPerUser`) | Yes (slider 0-30) | Users removed from pool after hitting limit |
| Nosotros | 3 (`maxRelaysPerUser`) | Yes (slider 1-14) | `.slice(0, N)` after sorting |
| Voyage | 2 (`MAX_RELAYS_PER_PUBKEY`) | No | For publishing only |
| Wisp | No per-pubkey limit | N/A | Author may appear on many relays |
| rust-nostr | 3 write, 3 read, 1 hint, 1 most-used | No (compile-time) | Separate limits per relay type |
| Nostur | 2 | No | `createRequestPlan` finds up to 2 per pubkey |
| Amethyst | No explicit limit | N/A | All declared write relays used |

---

## Fallback Strategies

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

Fallback policy details:
- **Gossip:** No hardcoded fallbacks. Checks weak associations (fetched: 0.2/14-day decay, hints: 0.1/7-day decay), then user's READ relays. Actively discovers via `subscribe_discover()` with 20-min staleness.
- **Welshman:** Three policies -- `addNoFallbacks` (default), `addMinimalFallbacks` (1 random default relay), `addMaximalFallbacks` (fill to limit). Indexed kinds always go to indexer relays.
- **Amethyst:** Cascade: bloom filter hints -> 7 hardcoded `eventFinderRelays` (nostr.wine, relay.damus.io, relay.primal.net, nostr.mom, nos.lol, nostr.bitcoiner.social, nostr.oxtr.dev). `rawOutboxRelays = true` skips all fallbacks.
- **Voyage:** Four-phase: NIP-65 write -> event-relay tracking -> user's READ + selected relays -> redundancy pass.

---

## Long-Tail Handling

| Project | Approach |
|---------|----------|
| **Gossip** | Temporal decay naturally includes obscure relays. Declared relay = 1.0 score. Fetched = 0.2 with 14-day half-life. Zero-success relays score 0 (must be tried first). |
| **Welshman** | `random()` factor gives low-weight relays occasional selection. Personal relay (weight 1) has ~1/5.6 chance of beating a 100-user relay. Dead relays gated out (quality = 0). |
| **Applesauce/noStrudel** | Set-cover inherently handles long tail: after popular relays selected, remaining uncovered users drive personal relay selection. ~15 slots available after top 5 cover the bulk. Orphaned users visible in settings UI. |
| **NDK** | On-demand temporary connections (30s auto-disconnect) for unique personal relays. Not pooled unless shared by another author. |
| **Amethyst** | Bloom filter `HintIndexer` surfaces obscure relays from third-party mentions. 7 large relay fallback for completely unknown users. |
| **Wisp** | 75-relay cap leaves ample room. Discovery targets "middle tier" relays (frequency >= 3, not top 5). |
| **rust-nostr** | Five independent flag sources (READ, WRITE, HINT, RECEIVED, PRIVATE_MESSAGE) accumulate associations. `most_used_relays_per_user: 1` ensures at least one empirically-verified relay per pubkey. |
| **Nostur** | `skipTopRelays: 3` forces use of less popular relays, indirectly improving long-tail coverage. |
