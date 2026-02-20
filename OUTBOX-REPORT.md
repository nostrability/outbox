# Outbox Model Implementation Report

**An analysis of NIP-65 outbox/inbox relay routing across 15 Nostr clients and libraries**

*Produced for [nostrability#69](https://github.com/niclas-pfeifer/nostrability/issues/69)*

---

## Executive Summary

The outbox model (NIP-65) enables decentralized event routing on Nostr by having users declare their preferred read (inbox) and write (outbox) relays via kind 10002 events. Clients use these declarations to route subscriptions to authors' write relays and publish events to recipients' read relays, replacing the older approach of broadcasting everything to a static relay set.

We analyzed outbox implementations in 15 codebases spanning 5 languages (Rust, TypeScript, Kotlin, Swift, Dart). Two library-client pairs are tightly coupled (Welshman/Coracle, Applesauce/noStrudel), yielding **13 distinct implementations** when those pairs are merged. Ratios in this report (e.g., "8/13") refer to these 13 implementations unless otherwise noted:

| Maturity | Projects |
|----------|----------|
| **Full outbox** (read + write routing, scoring, health tracking) | Gossip, Welshman/Coracle, Amethyst, NDK, Applesauce/noStrudel, Nostur, rust-nostr, Voyage, Wisp, Nosotros |
| **Partial / planned** | Yakihonne (parser exists, unused for routing), Notedeck (NIP-65 infrastructure, PR #1288 pending) |
| **Minimal / none** | Shopstr (own relay config only) |

### Key Findings

1. **Greedy set-cover dominates.** Four independent implementations (Gossip, Applesauce, Wisp, Amethyst for recommendations) use a formal greedy set-cover algorithm that iteratively picks the relay covering the most uncovered pubkeys. Nostur's `createRequestPlan()` uses a related greedy coverage sort (relays sorted by coverage count, assigned greedily) but without the iterative recalculation loop of classic set-cover. This convergence is notable because these codebases were developed independently in different languages.

2. **Scoring complexity varies widely.** Gossip uses a two-layer multiplicative score with exponential temporal decay. Welshman uses `quality * log(weight) * random()` with stochastic variation. Wisp uses pure coverage count. Most others fall somewhere between.

3. **Connection limits range from 20 to 75** for projects with hard caps. Several (NDK, Welshman, Nosotros) have no global cap.

4. **Per-pubkey relay targets cluster around 2-3** (measuring outbox read-side relays per followed author). noStrudel is the outlier at 5. rust-nostr uses separate limits per relay type (3 write + 3 read + 1 hint + 1 most-used), which is not directly comparable since those serve different routing purposes. The 2-3 consensus reflects the tradeoff: 1 relay is fragile, 2 provides redundancy, 3+ has diminishing returns.

5. **The ecosystem depends on a few bootstrap relays.** `relay.damus.io` appears in 8/13 implementations, `purplepag.es` in 6/13. If purplepag.es went offline, relay discovery for multiple clients would degrade.

6. **No implementation measures per-author event coverage.** This is the most important missing metric -- no client can answer "am I seeing all events from this author?"

---

## 1. How Implementations Work

### 1.1 The Core Pattern

Most mature implementations follow this general workflow, though they differ significantly in step 4:

1. **Fetch kind 10002** for each followed pubkey (usually from indexer relays like purplepag.es)
2. **Parse relay tags** -- `r` tags with optional read/write markers (no marker = both)
3. **Build a relay-to-authors map** -- group pubkeys by their declared write relays
4. **Select relays** -- reduce the relay set using project-specific strategies (greedy set-cover, priority-based selection, weighted scoring, or direct mapping without optimization)
5. **Fan out subscriptions** -- send each relay a filter containing only its assigned authors
6. **Publish to inbox** -- when posting, also send to tagged users' read relays

Not all implementations optimize in step 4. Amethyst's feed routing maps each follow directly to their declared write relays without a formal minimization pass (though it uses set-cover for relay recommendations). NDK uses priority-based selection rather than global minimization. Welshman uses stochastic weighted scoring.

### 1.2 Implementation Maturity Matrix

| Project | Read Outbox | Write Inbox | Relay Scoring | Health Tracking | Connection Mgmt |
|---------|:-----------:|:-----------:|:-------------:|:---------------:|:---------------:|
| **Gossip** | Full | Full | Multi-factor composite | Exclusion timers 15s-10min | Max 50, minion-per-relay |
| **Welshman/Coracle** | Full | Full | quality * log(weight) * random() | Tiered error thresholds | Lazy connect, 30s auto-close |
| **Amethyst** | Full | Full | Binary (online/offline) | RelayOfflineTracker | Dynamic pool, 300ms sample |
| **NDK** | Full | Full | Connected > selected > popular | Flapping detection | Temp relays, 30s auto-disconnect |
| **Applesauce/noStrudel** | Full | Full | Pluggable coverage ratio | online/offline/dead state machine | Dead relay exclusion |
| **Nostur** | Full | Full | Coverage sort + skipTopRelays | Misconfigured kind 10002 detection | 3 pools (persistent/outbox/ephemeral) |
| **rust-nostr** | Full | Full | Received-event tiebreak | Per-pubkey semaphore freshness | Configurable per-flag limits |
| **Voyage** | Full | Full | Lexicographic boolean tuple | Spam relay flagging | Autopilot max 25 |
| **Wisp** | Full | Full | Pure coverage count | None explicit | Max 75 scored relays |
| **Nosotros** | Full | Full | Event-count sort | Relay stats DB | Max relays/user configurable 1-14 |
| **Yakihonne** | None | None | None | None | Static 5 constant relays |
| **Notedeck** | Planned | None | None | None | Flat pool, all-to-all |
| **Shopstr** | None | None | None | None | Static localStorage list |

### 1.3 Architecture Patterns

**Reactive / Observable-driven:**
- **Amethyst** -- Kotlin `StateFlow` + `combine()`. Kind 10002 changes automatically recompute per-relay subscription filters.
- **Applesauce/noStrudel** -- RxJS `combineLatest` + `switchMap`. Full pipeline from contacts through mailbox enrichment through relay selection. `debounceTime(500)` stabilizes async data arrival.
- **Nosotros** -- RxJS `mergeMap` per author. Each author's relay list resolves independently.

**Imperative / Event-driven:**
- **Gossip** -- Rust async with message-passing (Overlord -> Minion channels). RelayPicker as global singleton.
- **NDK** -- EventEmitter pattern. `OutboxTracker` emits events, subscriptions listen and refresh.
- **Nostur** -- Swift imperative with CoreData. Builds plans, passes to ConnectionPool.
- **rust-nostr** -- Trait-based with async semaphores. Pure function filter decomposition.
- **Voyage** -- Kotlin coroutines with Room DAO queries. Multi-phase imperative algorithm.
- **Wisp** -- Kotlin imperative. Full greedy set-cover runs synchronously.

**Library vs. Client:**

Libraries providing outbox as a reusable primitive: **Welshman** (stateless Router, clients compose scenarios), **NDK** (transparent outbox on any subscription), **Applesauce** (pure functions + RxJS operators), **rust-nostr** (trait-based storage abstraction), **NostrEssentials** (Swift pure functions used by Nostur).

Clients with tightly-integrated outbox: **Gossip** (LMDB + Minion architecture), **Amethyst** (LocalCache + Kotlin Flow), **Voyage** (Room DAO), **Wisp** (application-level classes), **Nosotros** (tanstack-query + RxJS).

---

## 2. Relay Selection Algorithms

### 2.1 Algorithm Taxonomy

| Category | Projects | Description |
|----------|----------|-------------|
| **Greedy set-cover** | Gossip, Applesauce/noStrudel, Wisp, Amethyst (recommendations) | Iteratively pick relay covering most uncovered pubkeys with recalculation per iteration |
| **Greedy coverage sort** | Nostur | Sort relays by coverage count, greedily assign pubkeys (no iterative recalculation) |
| **Priority-based** | NDK | Three-tier: connected > already-selected > popularity-ranked |
| **Weighted stochastic** | Welshman/Coracle | `quality * log(weight) * random()` with deliberate randomness |
| **Progressive multi-tier** | Amethyst (discovery) | Expanding scope: outbox -> hints -> indexers -> search -> connected |
| **Observable pipeline** | Nosotros, Applesauce (reactive layer) | Per-author relay resolution as data flow streams |
| **Filter decomposition** | rust-nostr | Bitflag-based graph splitting filters by pubkey type |

### 2.2 Scoring Formulas

**Gossip -- Two-Layer Composite:**
```
composite = association_score(pubkey, relay) * adjusted_relay_score(relay)
```
- Association: 1.0 for declared (kind 10002/kind 3/NIP-05), 0.2 with 14-day decay for fetched, 0.1 with 7-day decay for hinted
- Relay score: `(rank/9) * (0.5 + 0.5 * success_rate) * connected_factor * log10(success_count)`

**Welshman/Coracle -- Log-Dampened Weighted:**
```
score = quality * (1 + log(weight)) * random()
```
- `log(weight)` dampens hub bias: 100 users scores ~5.6x vs 1 user, not 100x
- `random()` distributes load across relays over time
- Quality is a hard gate: 0 = excluded (any error in last minute, >3/hour, >10/day)

**Applesauce -- Coverage Ratio (Pluggable):**
```
score = covered_users / remaining_pool_size
```
Custom `score(relay, coverageScore, popularity)` callback available.

**Nosotros -- Event-Count Ranking:**
```
relays.sort_by(stats[relay].events DESC).slice(0, maxRelaysPerUser)
```

**Voyage -- Lexicographic Boolean Tuple:**
Sort by: (1) not spam, (2) seen in event-relay data, (3) already connected, (4) not disconnected.

### 2.3 Connection Limits

| Project | Max Total | Per Author | Configurable |
|---------|:---------:|:----------:|:------------:|
| Gossip | 50 | 2 | Both |
| noStrudel | 20 | 5 | Both (sliders 0-30) |
| Nostur | 50 (outbox pool) | 2 | No |
| Wisp | 75 | No limit | No |
| Voyage | 25 | 2 (publish) | No |
| Welshman | None (3/scenario) | 3 | Yes |
| NDK | None | 2 | Per-subscription |
| Nosotros | None | 3 | Yes (1-14 slider) |
| rust-nostr | None | 3w + 3r + 1h + 1m* | No (compile-time) |

\* rust-nostr's per-pubkey limits are per relay-type (write, read, hint, most-used), not directly comparable to the single outbox-read metric used by other projects.

### 2.4 Anti-Centralization Measures

Greedy set-cover algorithms inherently favor popular relays. Several projects counteract this:

- **Nostur** -- `skipTopRelays: 3` skips the 3 most-populated relays in the Following feed, forcing distribution to smaller relays
- **Welshman** -- `Math.log(weight)` compresses hub bias logarithmically; `Math.random()` adds stochastic variation
- **Wisp** -- Onboarding relay prober drops the top 5 mega-relays, selects "middle tier" relays
- **Gossip** -- User-assignable relay rank 0-9 (rank 0 = excluded)
- **Amethyst** -- Hardcoded blocklist excludes known aggregator relays (feeds.nostr.band, filter.nostr.wine)

---

## 3. Bootstrapping and Relay Discovery

### 3.1 Bootstrap Relay Dependencies

| Relay | Projects Using It | Role |
|-------|:-----------------:|------|
| `relay.damus.io` | 8/13 | Universal bootstrap |
| `purplepag.es` | 6/13 | Primary indexer for kind 10002 |
| `nos.lol` | 5/13 | Secondary bootstrap |
| `relay.primal.net` | 5/13 | Common fallback |
| `nostr.wine` | 3/13 | Search + fallback |

This concentration represents a centralization risk. If `purplepag.es` went offline, relay discovery for NDK, Coracle, noStrudel, Amethyst, Shopstr, and Notedeck would degrade. Amethyst is the most resilient with 5 configured indexer relays.

### 3.2 Discovery Pipelines

**Gossip:** Dedicated DISCOVER relay role. `subscribe_discover()` fetches kind 10002 + 10050 for all follows with stale data (20-minute staleness threshold). No hardcoded fallback relays at runtime.

**NDK:** Dedicated outbox pool (purplepag.es, nos.lol). Fetches relay lists in batches of 400 pubkeys. Late-arriving data triggers `refreshRelayConnections()` on active subscriptions.

**Amethyst:** Progressive 5-tier cascade with load shedding at >300 follows:
1. Outbox relays already known
2. Relay hints (bloom filter)
3. Indexer relays (5 configured) + home relays
4. Search relays + connected relays
5. Common/shared outbox relays

**Wisp (unique onboarding):**
1. Connect to 2 bootstrap relays
2. Harvest 500 kind 10002 events
3. Filter to "middle tier" relays (drop top 5, require frequency >= 3)
4. Probe 15 candidates with NIP-11 + ephemeral write test
5. Select top 8 by latency

### 3.3 Fallback Chains

| Project | Primary | Secondary | Terminal Fallback |
|---------|---------|-----------|-------------------|
| Gossip | Kind 10002 write relays | Fetched/hinted relays (with decay) | User's own READ relays (15s timeout) |
| Welshman | Kind 10002 write relays | -- | 1 random default relay (addMinimalFallbacks) |
| NDK | Kind 10002 write relays | Kind 3 content | Pool permanent relays |
| Amethyst | Kind 10002 write relays | Bloom filter hints | 7 hardcoded event finder relays |
| Nostur | Kind 10002 write relays | -- | User's own configured relays (always parallel) |
| rust-nostr | WRITE relays | HINT + RECEIVED relays | Client's READ relays |
| Voyage | NIP-65 write relays | Event-relay tracking | READ + selected relays + redundancy pass |
| Wisp | RelayScoreBoard | -- | sendToAll general relays |
| Nosotros | Kind 10002 WRITE relays | -- | FALLBACK_RELAYS env var |

---

## 4. Outbox as One Heuristic Among Many

The outbox model is not the only relay selection heuristic. Real implementations combine many:

### 4.1 Heuristics in Use

| Heuristic | Implementations | Purpose |
|-----------|:--------------:|---------|
| **Outbox (NIP-65 write)** | 10/13 | Find events by querying author's write relays |
| **Inbox (NIP-65 read)** | 10/13 | Deliver events to recipient's read relays |
| **DM inbox (kind 10050)** | 4/13 full, 1 partial | Route encrypted DMs to messaging-specific relays |
| **Relay hints (tags)** | 8/13 | Use relay URLs from e/p/a tags and NIP-19 entities |
| **Search relays (NIP-50)** | 4/13 | Route full-text search to capable relays |
| **Indexer relays** | 6/13 | Fetch metadata from aggregator relays |
| **Event delivery tracking** | 5/13 | Track which relays delivered events per author |
| **Discovery relays** | 2/13 | Dedicated role for relay list fetching |

### 4.2 Heuristic Composition Strategies

**Welshman -- Weighted Scenario Merging:**
Multiple scenarios (outbox, inbox, hints) are merged by summing weights per relay, then scored with `quality * log(merged_weight) * random()`. Different contexts use different scenario compositions (feed loading, thread context, publishing, notifications).

**Gossip -- Bitmask Relay Roles:**
Relays have bitmask flags (OUTBOX, INBOX, DISCOVER, DM, READ, WRITE, GLOBAL, SEARCH, SPAMSAFE). Different operations query different flag combinations.

**rust-nostr -- Per-Pubkey-Relay Bitflags:**
Each (pubkey, relay) pair has bitflags (READ, WRITE, PRIVATE_MESSAGE, HINT, RECEIVED). Filter decomposition selects relay subsets based on filter structure (authors-only -> WRITE, #p-only -> READ, both -> union).

**Amethyst -- 10 Distinct Relay List Types:**
NIP-65, DM (kind 10050), proxy, blocked, broadcast, indexer, search, trusted, private storage, and local relay lists, composed via Kotlin `combine()` and `flatMapLatest()`.

### 4.3 Unsolved Problems

- **Hashtag/geohash routing** -- No pubkey-based routing exists for `#t` or `#g` filtered events. No mechanism for relays to advertise topic specialization.
- **Relay capability signaling** -- Beyond NIP-11's `supported_nips`, relays cannot advertise coverage, specialization, or performance characteristics.
- **Cross-heuristic conflict resolution** -- When declared relays disagree with observed evidence, implementations use ad hoc priority rules. No formal framework exists for weighting conflicting signals.
- **Replaceable vs. regular event routing** -- All implementations treat relay selection identically regardless of event kind replaceability.

---

## 5. Challenges and Tradeoffs

### 5.1 Scalability

Large follow lists (hundreds to thousands) stress the outbox model:

| Project | Scaling Strategy | Threshold |
|---------|-----------------|-----------|
| Amethyst | Reduce indexer queries per user, limit connected relay probing | >300 follows |
| NDK | Batch relay list fetches in groups of 400 | N/A |
| Welshman | Chunk author lists into groups of ~30 for relay selection | N/A |
| Voyage | Cap keys per filter at 750 | N/A |
| Greedy set-cover (Gossip, Applesauce, Wisp) | Minimize connections while maintaining coverage | O(n*m) |

### 5.2 Defunct Relays

Five distinct approaches to handling dead relays:

- **Welshman** -- Tiered error thresholds: 1 error/minute, 3/hour, or 10/day = quality 0 (excluded)
- **Gossip** -- Per-reason exclusion timers: 15 seconds (clean close) to 10 minutes (DNS failure, rejection)
- **Applesauce** -- Three-state machine (online/offline/dead) with exponential backoff. Dead after 5 failures is permanent for the session.
- **Amethyst** -- Binary `RelayOfflineTracker` set + exponential backoff on reconnection
- **NDK** -- System-wide flapping detection: >50% disconnect in 5 seconds triggers coordinated reconnection

### 5.3 Misconfigured Relay Lists

Users often publish kind 10002 with problematic entries (localhost, paid filter relays, NWC relays, write-only blast relays).

**Approaches:**
- **Amethyst** -- Blocklist: skip individual bad entries (feeds.nostr.band, filter.nostr.wine, nwc.primal.net, relay.getalby.com)
- **Nostur** -- Aggressive: discard *entire* kind 10002 if *any* write relay matches 9-entry known-bad list
- **Gossip** -- URL-pattern banning for infinite-subdomain tricks (e.g., user123.relay.nostr.band)
- **Welshman** -- Protocol-level filtering: exclude onion, local, insecure (ws://) by default

The tradeoff: Nostur's "discard entire event" approach loses good relay data when users have just one bad entry. Others filter per-entry but may still connect to misconfigured relays.

### 5.4 Centralization Pressure

Greedy set-cover algorithms create a "winner take all" dynamic where popular relays handle disproportionate traffic. Five projects include explicit countermeasures: Nostur's `skipTopRelays`, Welshman's logarithmic dampening, Wisp's mega-relay filtering during onboarding, Gossip's user-assignable relay ranks (rank 0 = excluded), and Amethyst's hardcoded aggregator blocklist. However, most projects have no anti-centralization mechanism in their core relay selection. NDK's preference for already-connected relays creates a rich-get-richer effect.

### 5.5 Privacy

The outbox model inherently reveals interest graphs: connecting to a followed user's relay tells that relay you are interested in that user.

- **Nostur** -- VPN detection gate: outbox connections silently skipped if no VPN detected
- **Amethyst** -- Per-category Tor routing controls + proxy relay system that bypasses outbox entirely (routes all through a single trusted relay)
- **Welshman** -- Excludes onion and insecure relays by default
- **Relay hints** -- Embedded relay URLs in tags create metadata that can correlate user behavior

### 5.6 Resource Cost

The outbox model consumes more memory, bandwidth, and battery than static relay lists:

- **Memory:** Amethyst's bloom filters (~9.6MB), Gossip's LMDB, NDK's 100k-entry LRU
- **Bandwidth:** More WebSocket connections = more ping/pong overhead. Welshman sends pings every 30s per connection.
- **Battery:** Amethyst samples pool at 300ms, noStrudel debounces at 500ms, Nostur provides "low data mode" that disables outbox entirely
- **CPU:** Set-cover algorithms are O(n*m) per recomputation; Gossip's exponential decay requires floating-point math per person-relay pair

User-modifiable controls: Nostur (Autopilot opt-in, off by default), noStrudel (max connections slider 0-30), Gossip (max_relays + relays_per_person configurable), Amethyst (proxy relay bypass), Welshman (relay_limit configurable).

---

## 6. Measuring Effectiveness

### 6.1 What Could Be Measured

| Metric | Definition | Status |
|--------|-----------|--------|
| **Event coverage** | Events received / events published by follows | Not tracked by any implementation |
| **User coverage** | Followed pubkeys with >= 1 selected relay / total follows | noStrudel shows this in debugger UI |
| **Relay efficiency** | Pubkeys covered / relay connections | Not tracked |
| **Relay list staleness** | Age of kind 10002 data used for routing | Gossip (20-min check), NDK (2-min TTL) |
| **Connection overhead** | Connections delivering 0 events / total connections | Not tracked |

### 6.2 What Is Currently Observable

**Best instrumented:**
- **Welshman** -- 18-field `RelayStats` (open/close counts, event counts, error timestamps, publish success/failure, EOSE counts)
- **Gossip** -- Per-relay success/failure counts feeding into scoring. Per-person-relay temporal data (`last_fetched` with 14-day decay, `last_suggested` with 7-day decay)
- **Amethyst** -- `UserRelaysCache` per-user relay frequency map. Per-relay stats (ping, bytes, errors)

**Per-author event delivery tracking:**
- Gossip (last_fetched with decay), rust-nostr (RECEIVED flag + event count), Voyage (EventRelayAuthorView), Amethyst (UserRelaysCache counter), Nosotros (seen table)

### 6.3 Coverage Visualization

**noStrudel** is the only project with a user-facing outbox debugger:
- Coverage percentage (color-coded: green >= 80%, yellow >= 50%, red < 50%)
- Per-relay table showing user count and connection status
- "Users by relay count" breakdown
- "Missing relay list" and "orphaned" user lists
- Configurable max connections and max relays per user sliders

Nostur provides a more limited "outbox preview" UI that shows which additional relays will be used when composing an event, but it does not expose the full selection process (coverage %, orphaned users, per-relay assignment) the way noStrudel does.

### 6.4 Research Opportunities

1. **Per-author event coverage measurement** -- Compare outbox-routed events vs "ground truth" from indexer relays. Answer: "For which follows is the outbox model failing?"
2. **Coverage vs. connection count frontier** -- Plot diminishing returns curve; empirically determine how many connections are needed for 95% coverage
3. **Relay list completeness in the wild** -- What fraction of active users have published kind 10002? Are their listed relays operational?
4. **Cross-client consistency** -- Do different implementations reach the same events for the same follow list?
5. **Relay list propagation latency** -- How long after publishing a kind 10002 update do indexers and clients see it?
6. **Relay hint accuracy** -- How often do relay hints in event tags actually point to relays that have the referenced event?
7. **Long-tail analysis** -- What fraction of users are on relays used by <10 pubkeys? How does coverage differ for long-tail vs. mainstream users?

---

## 7. Comparative Summary

### Algorithm Comparison

| | Gossip | NDK | Welshman | Applesauce | Amethyst | rust-nostr | Voyage | Wisp | Nosotros | Nostur |
|---|---|---|---|---|---|---|---|---|---|---|
| **Algorithm** | Greedy set-cover | Priority + popularity | Weighted stochastic | Greedy set-cover | Reactive flow | Filter decomposition | Multi-phase greedy | Greedy set-cover | Observable pipeline | Greedy coverage sort |
| **Connection cap** | 50 | None | None | 20 | Dynamic | None | 25 | 75 | None | 50 |
| **Per-pubkey target** | 2 | 2 | 3 | 5 | All declared | 3w+3r+1h+1m | 2 | No limit | 3 | 2 |
| **Stochastic** | No | No | Yes | No | No | No | No | No | No | No |
| **Temporal decay** | Yes | No | No | No | No | No | No | No | No | No |
| **Health in scoring** | Yes | Yes | Yes | Yes | Yes | No | Yes | No | Yes | Yes |
| **NIP-17 DM relays** | Yes | No | Yes | No | Yes | Yes | No | No | No | Partial |
| **User-configurable** | Yes | Per-sub | Yes | Yes | No | No | No | No | Yes | No |
| **Blocklist support** | Yes | Yes | Yes | Yes | Yes | No | Yes | No | Yes | Yes |

### Storage Models

| Model | Projects |
|-------|----------|
| **Persistent database** | Gossip (LMDB), Voyage (Room/SQLite), rust-nostr (SQLite), Nostur (CoreData), Nosotros (SQLite/OPFS) |
| **In-memory with optional persistence** | NDK (LRU 100k/2min), Welshman (Repository + IndexedDB tracker), Applesauce (EventStore + localforage), Wisp (LRU 500 + SharedPreferences) |
| **In-memory only** | Amethyst (LocalCache + bloom filters ~9.6MB) |
| **No relay state** | Yakihonne, Shopstr, Notedeck (own account only) |

### NIP-17 (DM Relay) Support

"Support" here means routing outgoing DMs to recipients' kind 10050 relays, not merely publishing one's own kind 10050 event.

Full DM relay routing: **Gossip**, **rust-nostr**, **Welshman**, **Amethyst** (4 of 10 mature implementations). **Nostur** publishes kind 10050 via its configuration wizard but does not route outgoing DMs to recipients' kind 10050 relays. The remaining 5 (NDK, Applesauce/noStrudel, Voyage, Wisp, Nosotros) do not implement kind 10050 routing.

---

## 8. Recommendations for Implementers

Based on patterns observed across all implementations:

1. **Start with greedy set-cover.** It is the most common algorithm for good reason -- it directly solves the connection minimization problem and has strong theoretical foundations (O(log n) approximation).

2. **Default to 2-3 relays per pubkey.** The ecosystem consensus is clear. Going lower risks missed events; going higher wastes connections.

3. **Track relay health.** At minimum, implement binary online/offline tracking with backoff. Ideally, use tiered error thresholds (Welshman) or penalty timers (Gossip) to avoid repeatedly connecting to flaky relays.

4. **Configure multiple indexer relays.** Relying on a single indexer (e.g., only purplepag.es) is a single point of failure. Amethyst's 5-indexer approach is the most resilient.

5. **Handle misconfigured kind 10002.** At minimum, filter out known-bad relay entries. Blocklists for aggregator relays (feeds.nostr.band, filter.nostr.wine) and special-purpose relays prevent wasted connections.

6. **Make outbox debuggable.** noStrudel's coverage debugger is the gold standard. Users and developers should be able to see coverage percentage, orphaned users, and per-relay assignment.

7. **Consider anti-centralization.** Pure greedy set-cover naturally favors mega-relays. Welshman's logarithmic dampening or Nostur's skipTopRelays provide countermeasures.

8. **Support NIP-17 DM relays.** Only 4 of 10 mature implementations fully route DMs via kind 10050 relays. Kind 10050 is straightforward to implement and provides meaningful privacy benefits for direct messaging.

---

## Appendix: Source Code References

### Per-Client Analysis Files
- `analysis/clients/gossip.md` (645 lines)
- `analysis/clients/welshman-coracle.md` (713 lines)
- `analysis/clients/amethyst.md` (670 lines)
- `analysis/clients/ndk-applesauce-nostrudel.md` (852 lines)
- `analysis/clients/nostur-yakihonne-notedeck.md` (615 lines)
- `analysis/clients/rust-nostr-voyage-nosotros-wisp-shopstr.md` (509 lines)

### Cross-Cutting Topic Analyses
- `analysis/topics/implementation-approaches.md`
- `analysis/topics/relay-selection-algorithms.md`
- `analysis/topics/challenges-and-tradeoffs.md`
- `analysis/topics/outbox-as-heuristic.md`
- `analysis/topics/bootstrapping-and-fallbacks.md`
- `analysis/topics/effectiveness-measurement.md`

### Key Code Paths (Most Significant Per Project)

| Project | Key File | Function |
|---------|----------|----------|
| Gossip | `gossip-lib/src/relay_picker.rs` | `RelayPicker::pick()` (greedy set-cover) |
| Welshman | `packages/router/src/index.ts` | `RouterScenario.getUrls()` (scoring + selection) |
| Amethyst | `OutboxRelayLoader.kt` | `authorsPerRelay()` (reactive flow) |
| NDK | `core/src/outbox/index.ts` | `chooseRelayCombinationForPubkeys()` |
| Applesauce | `packages/core/src/helpers/relay-selection.ts` | `selectOptimalRelays()` (set-cover) |
| Nostur | `NostrEssentials/Outbox/Outbox.swift` | `createRequestPlan()` / `createWritePlan()` |
| rust-nostr | `sdk/src/client/gossip/resolver.rs` | `break_down_filter()` (filter decomposition) |
| Voyage | `data/provider/RelayProvider.kt` | `getObserveRelays()` (multi-phase) |
| Wisp | `relay/RelayScoreBoard.kt` | `recompute()` (greedy set-cover) |
| Nosotros | `hooks/subscriptions/subscribeOutbox.ts` | `subscribeOutbox()` (RxJS pipeline) |
