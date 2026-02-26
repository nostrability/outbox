> **DRAFT** — This document is a work in progress. Findings and framing may change.

> **For the practitioner summary, see [README.md](README.md).** This document contains the full methodology, cross-client analysis, and complete benchmark data.

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

1. **Greedy set-cover wins academic coverage.** Four independent implementations (Gossip, Applesauce, Wisp, Amethyst for recommendations) use a formal greedy set-cover algorithm that iteratively picks the relay covering the most uncovered pubkeys. Nostur's `createRequestPlan()` uses a related greedy coverage sort (relays sorted by coverage count, assigned greedily) but without the iterative recalculation loop of classic set-cover. This convergence is notable because these codebases were developed independently in different languages. However, real-world event verification shows greedy degrades sharply for historical access — see findings #7–8.

2. **Scoring complexity varies widely.** Gossip uses a two-layer multiplicative score with exponential temporal decay. Welshman uses ``quality * (1 + log(weight)) * random()`` with stochastic variation. Wisp uses pure coverage count. Most others fall somewhere between.

3. **Connection limits range from 20 to 75** for projects with hard caps. Several (NDK, Welshman, Nosotros) have no global cap.

4. **Per-pubkey relay targets cluster around 2-3** (measuring outbox read-side relays per followed author). noStrudel is the outlier at 5. rust-nostr uses separate limits per relay type (3 write + 3 read + 1 hint + 1 most-used), which is not directly comparable since those serve different routing purposes. The 2-3 consensus reflects the tradeoff: 1 relay is fragile, 2 provides redundancy, 3+ has diminishing returns.

5. **The ecosystem depends on a few bootstrap relays.** `relay.damus.io` appears in 8/13 implementations, `purplepag.es` in 6/13. If purplepag.es went offline, relay discovery for multiple clients would degrade.

6. **No implementation measures per-author event coverage.** This is the most important missing metric -- no client can answer "am I seeing all events from this author?"

7. **Academic coverage ≠ real-world event recall.** Event verification against real relays shows that algorithms optimizing for assignment coverage don't necessarily win at actual event retrieval. At 1 year, MAB-UCB achieves 40.8% event recall vs. Greedy Set-Cover's 16.3%. The relay that *should* have the event often doesn't — due to retention policies, downtime, or access restrictions. Stochastic exploration discovers relays that retain historical events.

8. **Welshman's `random()` is accidentally brilliant for archival.** The stochastic factor in ``quality * (1 + log(weight)) * random()`` spreads queries across relays over time, achieving the best long-window event recall (37.8% at 1 year) among deployed client algorithms. MAB-UCB (not yet in any client) beats it at 40.8%.

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
| **Welshman/Coracle** | Full | Full | `quality * (1 + log(weight)) * random()` | Tiered error thresholds | Lazy connect, 30s auto-close |
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

**Client-derived algorithms:**

| Category | Projects | Description | Benchmark impl |
|----------|----------|-------------|----------------|
| **Greedy set-cover** | Gossip, Applesauce/noStrudel, Wisp, Amethyst (recs) | Iteratively pick relay covering most uncovered pubkeys with recalculation per iteration | [`greedy-set-cover.ts`](bench/src/algorithms/greedy-set-cover.ts) |
| **Greedy coverage sort** | Nostur | Sort relays by coverage count, greedily assign pubkeys (no iterative recalculation) | [`greedy-coverage-sort.ts`](bench/src/algorithms/greedy-coverage-sort.ts) |
| **Priority-based** | NDK | Three-tier: connected > already-selected > popularity-ranked | [`priority-based.ts`](bench/src/algorithms/priority-based.ts) |
| **Weighted stochastic** | Welshman/Coracle | ``quality * (1 + log(weight)) * random()`` with deliberate randomness | [`weighted-stochastic.ts`](bench/src/algorithms/weighted-stochastic.ts) |
| **Progressive multi-tier** | Amethyst (discovery) | Expanding scope: outbox -> hints -> indexers -> search -> connected | — |
| **Observable pipeline** | Nosotros, Applesauce (reactive layer) | Per-author relay resolution as data flow streams | — |
| **Filter decomposition** | rust-nostr | Bitflag-based graph splitting filters by pubkey type | [`filter-decomposition.ts`](bench/src/algorithms/filter-decomposition.ts) |
| **Direct mapping** | Amethyst (feed routing) | Use ALL declared write relays, no optimization | [`direct-mapping.ts`](bench/src/algorithms/direct-mapping.ts) |

**Experimental algorithms** (benchmarked but not yet in any client):

| Algorithm | Strategy | Benchmark impl |
|-----------|----------|----------------|
| **Welshman+Thompson** | Welshman scoring with `sampleBeta(α, β)` instead of `random()`. Learns from Phase 2 event delivery outcomes, persists Beta distribution priors across sessions. Cold start = baseline Welshman; converges in 2–3 sessions | [`welshman-thompson.ts`](bench/src/algorithms/welshman-thompson.ts) |
| **Greedy+ε-Explore** | Greedy set-cover with probability ε (5%) of picking a random relay instead of the max-coverage one. One `if` statement on top of standard greedy | [`greedy-epsilon.ts`](bench/src/algorithms/greedy-epsilon.ts) |

**CS-inspired algorithms** (added for benchmark comparison — no client uses these yet):

| Algorithm | CS Problem | Strategy | Benchmark impl |
|-----------|-----------|----------|----------------|
| **ILP Optimal** | [Maximum coverage](https://en.wikipedia.org/wiki/Maximum_coverage_problem) (exact) | Branch-and-bound with LP relaxation bounds, 3s timeout, greedy fallback | [`ilp-optimal.ts`](bench/src/algorithms/ilp-optimal.ts) |
| **Bipartite Matching** | [Weighted bipartite matching](https://en.wikipedia.org/wiki/Hungarian_algorithm) | Inverse-frequency weighting prioritizes hard-to-reach pubkeys | [`bipartite-matching.ts`](bench/src/algorithms/bipartite-matching.ts) |
| **Spectral Clustering** | [Label propagation](https://en.wikipedia.org/wiki/Label_propagation_algorithm) community detection | Label propagation clusters relays by Jaccard similarity, select per-cluster reps | [`spectral-clustering.ts`](bench/src/algorithms/spectral-clustering.ts) |
| **MAB-UCB** | [Combinatorial multi-armed bandit](https://en.wikipedia.org/wiki/Multi-armed_bandit) (CMAB) | UCB1 exploration-exploitation over 500 rounds, learns marginal coverage | [`mab-relay.ts`](bench/src/algorithms/mab-relay.ts) |
| **Streaming Coverage** | [Streaming submodular max](https://en.wikipedia.org/wiki/Submodular_set_function) | Single-pass with k-buffer, swap weakest member if candidate improves coverage | [`streaming-coverage.ts`](bench/src/algorithms/streaming-coverage.ts) |
| **Stochastic Greedy** | [Lazier-than-lazy greedy](https://en.wikipedia.org/wiki/Submodular_set_function) | Sample random relay subset per step, pick best from sample. (1-1/e-ε) approx | [`stochastic-greedy.ts`](bench/src/algorithms/stochastic-greedy.ts) |

**References:**
- ILP / Maximum Coverage: [Khuller, Moss, Naor (1999)](https://dl.acm.org/doi/10.1016/S0020-0190(99)00031-9) "The Budgeted Maximum Coverage Problem"; [Google OR-Tools](https://github.com/google/or-tools) (industry-standard ILP solver)
- Stochastic Greedy: [Mirzasoleiman et al. (AAAI 2015)](https://arxiv.org/abs/1409.7938) "Lazier Than Lazy Greedy" — first linear-time (1-1/e-ε) submodular maximization; [SubModLib](https://github.com/decile-team/submodlib)
- MAB-UCB: [Chen, Wang, Yuan (ICML 2013)](https://proceedings.mlr.press/v28/chen13a.html) "Combinatorial Multi-Armed Bandit: General Framework"; [extended version (JMLR 2016)](https://arxiv.org/abs/1407.8339)
- Streaming Coverage: [Badanidiyuru et al. (KDD 2014)](https://dl.acm.org/doi/10.1145/2623330.2623637) "Streaming Submodular Maximization: Massive Data Summarization on the Fly"; [apricot](https://github.com/jmschrei/apricot)
- Bipartite Matching: [Kuhn (1955)](https://onlinelibrary.wiley.com/doi/abs/10.1002/nav.3800020109) "The Hungarian Method for the Assignment Problem"; [SciPy `linear_sum_assignment`](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.linear_sum_assignment.html)
- Spectral / Label Propagation: [Raghavan, Albert, Kumara (2007)](https://arxiv.org/abs/0709.2938) "Near Linear Time Algorithm to Detect Community Structures"; [NetworkX implementation](https://github.com/benedekrozemberczki/LabelPropagation)

**Baseline algorithms:**

| Algorithm | Strategy | Benchmark impl |
|-----------|----------|----------------|
| **Primal Aggregator** | Route all authors to a single caching relay (relay.primal.net) | [`primal-baseline.ts`](bench/src/algorithms/primal-baseline.ts) |
| **Popular+Random** | 2 fixed popular relays (damus.io, nos.lol) + 2 random per-author relays | [`popular-plus-random.ts`](bench/src/algorithms/popular-plus-random.ts) |

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

### Client-to-Algorithm Mapping

Which relay selection algorithm does each client/library use in production?

| Client | Algorithm | Benchmark Proxy | Key Code Path |
|--------|-----------|-----------------|---------------|
| **Gossip** | Greedy set-cover | [`greedy-set-cover.ts`](bench/src/algorithms/greedy-set-cover.ts) | `gossip-lib/src/relay_picker.rs` → `RelayPicker::pick()` |
| **Applesauce/noStrudel** | Greedy set-cover | [`greedy-set-cover.ts`](bench/src/algorithms/greedy-set-cover.ts) | `packages/core/src/helpers/relay-selection.ts` → `selectOptimalRelays()` |
| **Wisp** | Greedy set-cover | [`greedy-set-cover.ts`](bench/src/algorithms/greedy-set-cover.ts) | `relay/RelayScoreBoard.kt` → `recompute()` |
| **Amethyst** (recommendations) | Greedy set-cover | [`greedy-set-cover.ts`](bench/src/algorithms/greedy-set-cover.ts) | Relay recommendation code |
| **Amethyst** (feed routing) | Direct mapping | [`direct-mapping.ts`](bench/src/algorithms/direct-mapping.ts) | `OutboxRelayLoader.kt` → `authorsPerRelay()` |
| **NDK** | Priority-based | [`priority-based.ts`](bench/src/algorithms/priority-based.ts) | `core/src/outbox/index.ts` → `chooseRelayCombinationForPubkeys()` |
| **Welshman/Coracle** | Weighted stochastic | [`weighted-stochastic.ts`](bench/src/algorithms/weighted-stochastic.ts) | `packages/router/src/index.ts` → `RouterScenario.getUrls()` |
| **Nostur** | Greedy coverage sort | [`greedy-coverage-sort.ts`](bench/src/algorithms/greedy-coverage-sort.ts) | `NostrEssentials/Outbox/Outbox.swift` → `createRequestPlan()` |
| **rust-nostr** | Filter decomposition | [`filter-decomposition.ts`](bench/src/algorithms/filter-decomposition.ts) | `sdk/src/client/gossip/resolver.rs` → `break_down_filter()` |
| **Voyage** | Multi-phase greedy | — (no direct benchmark proxy) | `data/provider/RelayProvider.kt` → `getObserveRelays()` |
| **Nosotros** | Observable pipeline | — (no direct benchmark proxy) | `hooks/subscriptions/subscribeOutbox.ts` → `subscribeOutbox()` |
| **Yakihonne** | None (static relays) | — | 5 hardcoded relays |
| **Notedeck** | None (planned) | — | NIP-65 infra exists, PR #1288 pending |
| **Shopstr** | None (own relays) | — | localStorage relay list |

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

## 8. Benchmark Results

We built a benchmark tool ([`bench/`](bench/)) that simulates relay selection algorithms against identical real-world data. Each algorithm receives the same input (follow list + NIP-65 relay lists from indexer relays) and produces relay-to-pubkey assignments under the same connection budget. See [`bench/phase-1-findings.md`](bench/phase-1-findings.md) for full methodology.

### 8.1 Academic: Assignment Coverage

**What this measures:** Given NIP-65 relay lists, how many of your follows get assigned to at least one relay? This never connects to any relay — it measures the quality of the mapping on paper, not whether events actually exist there. Not a guarantee of event delivery.

**Test profiles:** 26 Nostr users with follow lists ranging from 105 to 1,779, NIP-65 adoption rates 52–91%.

**Client-derived algorithms at 20 connections:**

| User (follows) | Ceiling | Greedy | NDK | Welshman | Nostur | rust-nostr | Direct |
|----------------|--------:|-------:|----:|---------:|-------:|-----------:|-------:|
| ODELL (1,779) | 76.6% | **75.3%** | 74.9% | 73.7% | 66.4% | 69.8% | 74.1% |
| Derek Ross (1,328) | 80.8% | **79.6%** | 79.3% | 78.2% | 69.8% | 73.9% | 78.5% |
| pablof7z (1,050) | 67.7% | **66.4%** | 66.1% | 65.7% | 60.9% | 62.0% | 65.8% |
| Gigi (1,033) | 67.2% | **66.2%** | 65.7% | 65.2% | 58.4% | 62.1% | 64.9% |
| jb55 (943) | 69.2% | **68.1%** | 67.7% | 67.1% | 63.6% | 64.4% | 66.7% |
| verbiricha (938) | 82.2% | **80.3%** | 78.8% | 79.6% | 71.4% | 75.5% | 79.7% |
| miljan (811) | 76.4% | **75.2%** | 74.8% | 73.9% | 66.2% | 68.1% | 74.0% |
| Calle (718) | 69.8% | **68.2%** | 66.6% | 67.7% | 61.0% | 63.8% | 62.7% |
| jack (694) | 56.1% | **55.3%** | **55.3%** | 54.3% | 50.7% | 51.6% | 54.3% |
| Karnage (581) | 88.5% | **87.6%** | 87.4% | 87.1% | 76.6% | 81.2% | 86.2% |
| NVK (502) | 65.7% | **64.9%** | **64.9%** | 64.1% | 61.4% | 59.2% | 63.7% |
| hodlbod (442) | 87.1% | **84.8%** | 83.0% | 83.9% | 75.1% | 80.1% | 83.0% |
| Alex Gleason (434) | 84.3% | **83.4%** | 82.7% | 82.6% | 74.2% | 78.1% | 82.7% |
| Semisol (421) | 87.2% | **85.0%** | 84.8% | 84.8% | 81.0% | 82.2% | 84.6% |
| Martti Malmi (395) | 72.4% | **71.6%** | 70.9% | 70.4% | 66.1% | 67.6% | 70.6% |
| hzrd149 (388) | 84.0% | **82.7%** | 82.2% | 81.4% | 74.7% | 77.6% | 81.7% |
| Kieran (377) | 80.4% | **79.3%** | 79.0% | 78.5% | 75.1% | 74.3% | 78.5% |
| Preston Pysh (369) | 52.3% | **51.8%** | **51.8%** | 51.4% | 50.7% | 49.9% | 50.9% |
| Tony Giorgio (361) | 72.0% | 70.6% | **71.2%** | 70.1% | 67.3% | 67.3% | 69.8% |
| Snowden (354) | 63.0% | **62.7%** | 62.4% | 61.8% | 59.3% | 59.0% | 61.9% |
| Vitor (240) | 82.5% | **80.8%** | 80.4% | 80.6% | 72.1% | 76.7% | 80.4% |
| Dilger (233) | 80.3% | 76.8% | 76.4% | **77.0%** | 70.8% | 73.0% | 75.5% |
| Lyn Alden (226) | 67.3% | **67.3%** | **67.3%** | 66.2% | 63.7% | 61.1% | 65.0% |
| fiatjaf (194) | 76.3% | **75.3%** | **75.3%** | 73.2% | 61.9% | 71.1% | 71.6% |
| Ben Arc (137) | 70.8% | **69.3%** | **69.3%** | 66.7% | 62.8% | 62.8% | 67.2% |
| Rabble (105) | 90.5% | **90.5%** | **90.5%** | 89.5% | 75.2% | 85.7% | 88.6% |

Greedy Set-Cover wins 23 of 26 profiles. NDK ties on 7. Welshman wins 1 (Dilger). NDK wins 1 outright (Tony Giorgio).

**CS-inspired algorithms vs. Greedy (20 connections):**

| User (follows) | Ceiling | Greedy | ILP | Bipartite | Streaming | Spectral | MAB | StochGrdy |
|----------------|--------:|-------:|----:|----------:|----------:|---------:|----:|----------:|
| ODELL (1,779) | 76.6% | 75.3% | **75.5%** | 75.3% | 75.4% | 75.4% | 75.0% | 73.9% |
| Derek Ross (1,328) | 80.8% | 79.6% | **80.0%** | 79.9% | 79.9% | 79.9% | 79.2% | 78.9% |
| pablof7z (1,050) | 67.7% | 66.4% | **66.9%** | 66.7% | 66.6% | 66.4% | 65.7% | 65.7% |
| Gigi (1,033) | 67.2% | 66.2% | **66.7%** | **66.7%** | 66.5% | 66.6% | 66.2% | 65.9% |
| jb55 (943) | 69.2% | 68.1% | **68.6%** | **68.6%** | **68.6%** | 68.5% | 67.9% | 67.7% |
| verbiricha (938) | 82.2% | 80.3% | **80.6%** | 80.3% | 80.4% | 80.5% | 79.7% | 80.1% |
| miljan (811) | 76.4% | 75.2% | **76.1%** | 75.6% | **76.1%** | 76.0% | 75.3% | 75.1% |
| Calle (718) | 69.8% | 68.2% | **69.1%** | 68.7% | **69.1%** | 69.0% | 67.5% | 68.0% |
| jack (694) | 56.1% | 55.3% | **56.1%** | 55.7% | **56.1%** | 56.0% | 54.9% | 54.8% |
| Karnage (581) | 88.5% | 87.6% | **88.5%** | 88.2% | **88.5%** | **88.5%** | 86.5% | 87.4% |
| NVK (502) | 65.7% | 64.9% | **65.7%** | 65.3% | **65.7%** | **65.7%** | 63.5% | 64.7% |
| hodlbod (442) | 87.1% | 84.8% | **86.0%** | 85.5% | **86.0%** | 85.9% | 84.6% | 84.3% |
| Alex Gleason (434) | 84.3% | 83.4% | **84.3%** | 83.6% | **84.3%** | **84.3%** | 78.1% | 82.6% |
| Semisol (421) | 87.2% | 85.0% | **87.2%** | 86.4% | **87.2%** | 86.9% | 85.0% | 85.0% |
| Martti Malmi (395) | 72.4% | 71.6% | **72.4%** | 72.0% | **72.4%** | **72.4%** | 69.6% | 70.6% |
| hzrd149 (388) | 84.0% | 82.7% | **84.0%** | 83.4% | **84.0%** | **84.0%** | 82.1% | 82.0% |
| Kieran (377) | 80.4% | 79.3% | **80.4%** | 80.1% | **80.4%** | **80.4%** | 78.7% | 79.0% |
| Preston Pysh (369) | 52.3% | 51.8% | **52.3%** | 52.2% | **52.3%** | **52.3%** | 51.0% | 51.5% |
| Tony Giorgio (361) | 72.0% | 70.6% | **72.0%** | 71.6% | **72.0%** | **72.0%** | 70.3% | 70.4% |
| Snowden (354) | 63.0% | 62.7% | **63.0%** | 62.9% | **63.0%** | **63.0%** | 60.1% | 61.9% |
| Vitor (240) | 82.5% | 80.8% | **82.5%** | 81.4% | **82.5%** | **82.5%** | 79.9% | 80.8% |
| Dilger (233) | 80.3% | 76.8% | **80.3%** | 79.4% | **80.3%** | **80.3%** | 77.4% | 77.1% |
| Lyn Alden (226) | 67.3% | **67.3%** | **67.3%** | 67.0% | **67.3%** | **67.3%** | 64.0% | 66.4% |
| fiatjaf (194) | 76.3% | 75.3% | **76.3%** | 75.9% | **76.3%** | **76.3%** | 72.3% | 73.4% |
| Ben Arc (137) | 70.8% | 69.3% | **70.8%** | 70.6% | **70.8%** | **70.8%** | 66.9% | 67.9% |
| Rabble (105) | 90.5% | **90.5%** | **90.5%** | **90.5%** | **90.5%** | **90.5%** | 86.0% | 89.8% |

ILP, Streaming Coverage, and Spectral Clustering frequently hit the theoretical ceiling. Greedy Set-Cover leaves 1-4% on the table. MAB-UCB and Stochastic Greedy trade coverage for exploration.

"Ceiling" = NIP-65 adoption rate (% of follows with any valid write relay). No algorithm can exceed this.

**Key academic coverage findings:**

1. **Greedy Set-Cover wins 23 of 26 profiles** among client-derived algorithms (ties NDK on 7, loses to Welshman on 1, loses to NDK on 1).
2. **ILP and Streaming Coverage hit the theoretical ceiling** on most profiles with ≤500 follows, using fewer than 20 connections. The coverage gap between Greedy and optimal is 1-4%.
3. **Rankings are remarkably stable** regardless of follow count or NIP-65 adoption rate: Greedy > NDK (~0-2% behind) > Welshman (~1-3%) > Direct (~3-5%) > Filter Decomposition (~3-5%) > Coverage Sort (~5-12%).
4. **Nostur's skip-top-relays heuristic costs 5-12%** of coverage. Popular relays are popular because many authors publish there.
5. **20 connections is nearly sufficient.** Greedy at 10 connections already achieves 93-97% of its unlimited coverage.
6. **NIP-65 adoption is the real bottleneck.** 10-48% of follows lack any relay list. Better algorithms cannot fix missing data.
7. **MAB-UCB trades coverage for exploration.** It underperforms Greedy by 0-3% on assignment coverage, but this exploration pays off in real-world event recall.
8. **Concentration is the tradeoff.** Greedy has the highest Gini coefficient (0.77) -- a few relays handle most traffic. Stochastic approaches spread load more evenly (Gini 0.39-0.51) at the cost of lower coverage.

### 8.2 Approximating Real-World Conditions: Event Verification

**What this measures:** Did you actually get the posts? This connects to real relays and queries for kind-1 events within time windows, comparing against a multi-relay baseline. Results depend on relay uptime, retention policies, event propagation, and auth requirements.

**Methodology:**
- Baseline: query ALL declared write relays for each author, plus additional relays needed by baselines (primal.net, damus.io, nos.lol)
- Authors classified as **testable-reliable** (events found + ≥50% declared relays responded), **testable-partial** (<50% responded), **zero-baseline** (no events, relays responded), or **unreliable** (no events, relays unresponsive)
- Events per (relay, author) pair capped at 10,000 to eliminate recency bias
- 14 algorithms tested across 6 time windows (7d to 3 years)

**Relay diagnostics (cross-profile):** Success rates range from 31% (ODELL, 1,199 relays) to 47% (hodlbod, 489 relays) — inversely correlated with relay count because larger follow lists include more obscure relays. Failures are structural (deterministic per relay, not transient): 12 relays fail across all 6 profiles (NIP-42 auth-required, WoT-gated, or queries blocked). `filter.nostr.wine/*` personal relays are the largest single source of CLOSED messages (5–22 per profile). ~50% of authors with relay lists are "testable-reliable" (events retrievable from declared relays) — this ratio is a network constant across all profiles (47–52%).

Event recall across time windows (fiatjaf, testable-reliable authors). Events per (relay, author) pair capped at 10,000 — this prevents a single prolific relay from dominating the baseline count and biasing recall percentages toward whichever algorithm happens to select that relay:

| Algorithm | 3yr | 1yr | 90d | 30d | 14d | 7d |
|-----------|:---:|:---:|:---:|:---:|:---:|:---:|
| **MAB-UCB** | **22.8%** | **40.8%** | **65.9%** | **74.6%** | 82.3% | 93.5% |
| ILP Optimal | 21.3% | 38.1% | 60.3% | 70.9% | 83.2% | 98.0% |
| Bipartite Matching | 21.2% | 38.0% | 60.3% | 71.0% | 83.3% | 98.0% |
| Streaming Coverage | 21.2% | 37.9% | 59.8% | 69.9% | 81.7% | 97.5% |
| Spectral Clustering | 21.2% | 37.9% | 59.8% | 69.9% | 81.7% | 97.5% |
| Welshman Stochastic | 21.1% | 37.8% | 59.7% | 68.6% | 82.8% | 93.2% |
| Stochastic Greedy | 12.6%\* | 11.6% | 23.9% | 43.3% | 56.8% | 67.1% |
| NDK Priority | 11.2% | 18.7% | 36.1% | 61.4% | 76.5% | 92.3% |
| Filter Decomposition | 10.6% | 19.0% | 39.0% | 63.1% | 77.5% | 88.1% |
| Greedy Set-Cover | 9.8% | 16.3% | 35.8% | 61.8% | 77.5% | 93.5% |
| Direct Mapping | 9.4% | 16.8% | 38.5% | 63.9% | 79.9% | 89.9% |
| Coverage Sort (Nostur) | 7.4% | 13.3% | 30.8% | 53.5% | 65.6% | 67.6% |
| Popular+Random | 6.6% | 11.8% | 27.1% | 53.3% | 71.9% | 83.4% |
| Primal Aggregator | 0.9% | 1.6% | 3.7% | 8.3% | 14.5% | 28.3% |

\* Stochastic Greedy's non-monotonic 3yr > 1yr result (12.6% > 11.6%) is a data artifact: the algorithm selects ~12 relays (fewer than budget due to early convergence), and the baseline event count grows faster than the algorithm's miss rate at this window boundary.

**Cross-profile validation (7d window, testable-reliable authors):**

To test whether patterns generalize beyond fiatjaf, event recall was measured across 6 diverse follow lists. Profile sizes range from 377 follows (Kieran) to 1,779 (ODELL):

| Algorithm | fiatjaf | hodlbod | Kieran | jb55 | ODELL | Derek Ross | Mean |
|-----------|:-------:|:-------:|:------:|:----:|:-----:|:----------:|:----:|
| Streaming Coverage | 97.5% | 93.2% | 91.8% | 92.6% | 88.1% | 90.9% | **92.4%** |
| ILP Optimal | 98.0% | 96.8% | 90.5% | 91.6% | 87.2% | 89.8% | 92.3% |
| Spectral Clustering | 97.5% | 94.8% | 89.7% | 93.3% | 87.0% | 89.8% | 92.0% |
| Bipartite Matching | 98.0% | 93.1% | 90.1% | 93.1% | 86.3% | 90.1% | 91.8% |
| MAB-UCB | 93.5% | 92.9% | 92.5% | 92.4% | 83.0% | 90.9% | 90.9% |
| Direct Mapping | 89.9% | 85.9% | 90.9% | 85.9% | 87.6% | 87.3% | 87.9% |
| Greedy Set-Cover | 93.5% | 87.6% | 84.8% | 81.0% | 77.2% | 82.5% | 84.4% |
| NDK Priority | 92.3% | 82.1% | 85.2% | 81.1% | 77.2% | 82.0% | 83.3% |
| Welshman Stochastic | 93.2% | 83.6% | 84.6% | 84.1% | 74.8% | 77.8% | 83.0% |
| Popular+Random | 83.4% | 86.8% | 84.1% | 87.0% | 76.9% | 79.7% | 83.0% |
| Filter Decomposition | 88.1% | 74.7% | 81.7% | 74.0% | 71.4% | 72.1% | 77.0% |
| Stochastic Greedy | 67.1% | 73.0% | 76.8% | 64.7% | 46.3% | 72.5% | 66.7% |
| Greedy Coverage Sort | 67.6% | 63.7% | 79.6% | 62.4% | 54.5% | 61.0% | 64.8% |
| Primal Aggregator | 28.3% | 37.3% | 34.8% | 25.2% | 33.6% | 30.2% | 31.6% |

Profile characteristics:

| Profile | Follows | With Relay List | Unique Relays | Testable Authors | Baseline Events |
|---------|:-------:|:---------------:|:-------------:|:----------------:|:---------------:|
| fiatjaf | 194 | 87.1% | 233 | ~116 | 2,176 |
| hodlbod | 442 | 87.1% | 489 | 191 | 5,357 |
| Kieran | 377 | 80.4% | 404 | 156 | 3,801 |
| jb55 | 943 | 69.2% | 725 | 305 | 8,255 |
| ODELL | 1,779 | 76.6% | 1,199 | 661 | 19,057 |
| Derek Ross | 1,328 | 80.8% | 1,018 | 523 | 15,240 |

Cross-profile patterns:
- **Rankings generalize.** The top 4 algorithms are CS-inspired across all profiles (mean 91.8–92.4%).
- **~8pp gap** between CS algorithms and the best client-derived algorithms (92% vs 84% mean).
- **MAB-UCB is the most consistent** practical algorithm: 83–93% range, always top 5.
- **ODELL is the hardest profile** (largest follow list, lowest relay list coverage) — all algorithms score lowest here.
- **Greedy Set-Cover ranks 7th** by mean event recall despite being #1 at assignment coverage.

### 8.3 Expanded Benchmark: NIP-66 Filter, Thompson Sampling, and Multi-Session Learning

A second round of benchmarks expanded the test matrix: 4 profiles across 3 time windows, 5 learning sessions per configuration, with and without NIP-66 liveness filtering (120 total runs). Two new algorithms were added: Welshman+Thompson Sampling (learning from event delivery) and Greedy+ε-Explore (5% random exploration).

**Test profiles:**

| Profile | Follows | With Relay List | Unique Relays | After NIP-66 Filter |
|---------|:-------:|:---------------:|:-------------:|:-------------------:|
| fiatjaf | 194 | 76.3% | 233 | 140 (60%) |
| Gato | 399 | 74.4% | 685 | 231 (34%) |
| ValderDama | 1,077 | 79.3% | 920 | 389 (42%) |
| Telluride | 2,784 | 78.1% | 1,642 | 585 (36%) |

**NIP-66 liveness filter effect on relay success rates:**

The NIP-66 liveness filter removes relays not confirmed alive by network monitors before algorithm selection. The impact on relay success rates (% of selected relays that actually respond to queries):

| Profile | Without NIP-66 | With NIP-66 | Relays Removed |
|---------|:--------------:|:-----------:|:--------------:|
| fiatjaf | 56% | 87% | 93 (40%) |
| Gato | 26% | 80% | 454 (66%) |
| ValderDama | 35% | 79% | 531 (58%) |
| Telluride | 30% | 74% | 1,057 (64%) |

NIP-66 filtering consistently improves relay success rates substantially (about 1.5× to 3.1× in these profiles). Larger follow lists benefit more — they have more obscure relays in the candidate set. The filter removes 40–66% of declared relays, with the percentage increasing with follow count.

**Event recall impact of NIP-66 filtering (averaged across 5 sessions):**

| Algorithm | Without NIP-66 | With NIP-66 | Delta |
|-----------|:--------------:|:-----------:|:-----:|
| MAB-UCB | 79.2% | 84.5% | +5.3pp |
| Welshman Stochastic | 74.7% | 79.9% | +5.2pp |
| Welshman+Thompson | 81.0% | 80.6% | -0.4pp |
| Greedy Set-Cover | 77.4% | 76.8% | -0.7pp |
| Greedy+ε-Explore | 77.3% | 76.6% | -0.7pp |

*1yr window, averaged across all 4 profiles.*

NIP-66 filtering benefits stochastic algorithms (MAB-UCB, Welshman) most because they sample from the full relay pool — removing dead relays from that pool directly improves sample quality. Thompson Sampling shows a slight negative delta because it has already learned to avoid bad relays through its own scoring mechanism — the NIP-66 filter removes relays Thompson was already deprioritizing. Greedy shows a small negative delta at 1yr because NIP-66 may remove relays that are offline but still serve historical events.

**Thompson Sampling learning curves:**

Thompson Sampling persists per-relay Beta(α,β) parameters across sessions. Session 1 uses uniform priors (equivalent to baseline Welshman). Subsequent sessions use learned priors.

| Profile (follows) | Window | Session 1 | Session 2 | Session 5 | Total gain |
|---|---|---|---|---|---|
| Gato (399) | 1yr | 24.5% | 96.1% | 97.4% | +72.9pp |
| Gato (399) | 3yr | 15.7% | 94.7% | 93.6% | +77.9pp |
| ValderDama (1,077) | 1yr | 28.7% | 91.3% | 92.8% | +64.1pp |
| ValderDama (1,077) | 3yr | 20.4% | 82.6% | 91.0% | +70.7pp |
| Telluride (2,784) | 1yr | 33.1% | 92.0% | 92.6% | +59.4pp |
| Telluride (2,784) | 3yr | 27.1% | 29.1% | 86.1% | +58.9pp |
| fiatjaf (194) | 7d | 88.6% | 96.2% | 95.0% | +6.4pp |
| fiatjaf (194) | 1yr | 83.6% | 83.6% | 83.6% | +0.0pp |

Key patterns:
- **Convergence in 2–3 sessions.** Most improvement happens Session 1→2. Sessions 3–5 show minimal further gains.
- **Gains scale with problem difficulty.** The hardest cases (large follow counts, long windows) show the largest gains because there's more room to learn.
- **Short windows show modest improvement.** At 7d, relay success rates are already high and most relays have the events — less room for learning.
- **Small profiles at long windows show no learning.** fiatjaf at 1yr shows 0pp gain — the profile is small enough that the 20-relay budget can already cover most relay combinations.

**Algorithm comparison across all sessions (5-algorithm runs, NIP-66 liveness filter, averaged):**

| Profile | Window | Greedy | Welshman | Greedy+ε | Thompson | MAB-UCB |
|---------|--------|:------:|:--------:|:--------:|:--------:|:-------:|
| fiatjaf (194) | 7d | 98.2% | 94.9% | **98.5%** | 94.7% | 96.0% |
| Gato (399) | 7d | 86.1% | 86.3% | 86.1% | 86.3% | **86.7%** |
| Gato (399) | 1yr | 79.3% | 82.9% | 79.3% | 82.6% | **83.5%** |
| Gato (399) | 3yr | 76.5% | 79.6% | 76.5% | 78.2% | **80.1%** |
| ValderDama (1,077) | 7d | 93.7% | 92.9% | 93.7% | 94.6% | **96.5%** |
| ValderDama (1,077) | 1yr | 76.8% | 80.0% | 76.5% | 79.7% | **82.9%** |
| ValderDama (1,077) | 3yr | 71.0% | 76.8% | 70.8% | 75.2% | **80.0%** |
| Telluride (2,784) | 7d | 94.2% | 92.8% | 94.2% | 93.9% | **95.6%** |
| Telluride (2,784) | 1yr | 76.0% | 76.9% | 76.0% | 80.6% | **84.5%** |
| Telluride (2,784) | 3yr | 55.7% | 59.6% | 55.7% | 62.8% | **67.0%** |

MAB-UCB wins most comparisons (43% of all profile×window groups). Thompson Sampling wins 23%, primarily in the "without NIP-66" condition where it compensates for dead relays through learning. Greedy+ε matches Greedy almost exactly — the 5% random exploration has negligible impact on coverage but slightly improves relay success rates.

**Event distribution (power-law characteristics):**

Event counts per author show heavy right skew that increases with time window:

| Window | Mean events/author | Median events/author | Mean/Median ratio |
|--------|:------------------:|:--------------------:|:-----------------:|
| 7d | 28–40 | 8–17 | 2.4–3.6× |
| 1yr | 152–334 | 25–72 | 4.3–6.9× |
| 3yr | 191–601 | 27–95 | 6.0–7.6× |

*Ranges across 7 profiles.*

A small fraction of prolific authors produce the majority of events. This power-law distribution explains why algorithms that spread queries across diverse relays outperform coverage-maximizers at longer windows: the coverage-optimal relay set concentrates on popular relays where many authors publish, but those relays may not retain the high-volume output of prolific authors.

**Key findings from expanded benchmarks:**

1. **Thompson Sampling is the first relay selection algorithm that closes the feedback loop** — and it works. After learning, it achieves the highest or second-highest event recall in most configurations, with dramatically better relay success rates (85–100%) than MAB-UCB (55–85%).

2. **NIP-66 liveness filtering is high-value, low-effort.** It requires no algorithmic changes — just remove dead relays before running any algorithm. The impact is largest for stochastic algorithms and larger follow counts.

3. **Greedy+ε-Explore shows negligible benefit.** At 5% exploration rate, it matches Greedy almost exactly across all metrics. Higher ε values may show different results.

4. **MAB-UCB remains the best single-session algorithm.** Without learning history, MAB-UCB's internal exploration-exploitation (500 simulated rounds) outperforms everything. Thompson Sampling needs 2–3 sessions to catch up.

5. **The 20-connection limit is the fundamental bottleneck at scale.** Telluride (2,784 follows) at 3yr shows all algorithms struggling: Greedy at 56%, Thompson at 63%, MAB-UCB at 67%. The relay diversity needed to cover 2,784 authors' 3-year history exceeds what 20 connections can provide.

**Key real-world event verification findings:**

1. **Coverage-optimal ≠ event-recall-optimal.** Greedy Set-Cover wins Phase 1 (assignment coverage) but ranks 7th of 14 in actual event recall (84.4% mean across 6 profiles at 7d, vs 92.4% for Streaming Coverage). At 365 days on fiatjaf: 16.3% event recall vs. MAB-UCB's 40.8%.

2. **MAB-UCB is the best long-window algorithm.** Its exploration component isn't noise -- it discovers relays that happen to retain historical events. This outweighs the static optimizers that prioritize coverage density.

3. **Welshman's `random()` factor is accidentally brilliant.** What looks like an anti-centralization quirk (``quality * (1 + log(weight)) * random()``) turns out to be empirically the best archival strategy among existing client algorithms. At 1 year: 37.8% recall (best non-MAB, non-theoretical algorithm). MAB-UCB (not yet in any client) beats it at 40.8%. The randomness spreads queries across more relays over time, accidentally discovering which ones retain old events.

4. **Greedy Set-Cover degrades sharply.** 93.5% at 7d → 16.3% at 1 year. It minimizes connections by concentrating on popular relays, but those relays don't necessarily retain old events. Algorithms that spread queries fare better long-term.

5. **Aggregator results are surprisingly poor.** Primal achieves only 28.3% recall at 7 days and 0.9% at 3 years — worse than Popular+Random (damus + nos.lol + 2 random relays) at every window. This is unexpected for a relay that proxies many upstream relays, and may indicate a benchmark methodology limitation rather than a definitive conclusion about aggregators.

6. **Author recall is more stable than event recall.** You can *find* most authors even at long windows (74-81% author recall at 1 year), but you miss most of their posts. The disparity means relay retention policies are the binding constraint, not relay selection.

---

## 9. Observations

Based on patterns observed across all implementations and benchmark results:

1. **Algorithm choice depends on use case.** CS-inspired algorithms (Streaming Coverage, Spectral Clustering) achieve 92% mean event recall across 6 profiles vs Greedy's 84% — even for real-time (7d) feeds. Greedy degrades sharply for historical access (16% recall at 1yr). Stochastic approaches (Welshman: 38% at 1yr) and adaptive exploration (MAB-UCB: 41% at 1yr) are 2–2.5x better for older events. Coverage-optimal is not event-recall-optimal.

2. **Most clients default to 2-3 relays per pubkey.** 7 of 9 implementations with per-pubkey limits converge on 2 or 3 (see Section 2.3). This is an observed ecosystem consensus, not an empirically benchmarked finding — no study has measured the optimal number or the marginal value of a 3rd vs 4th relay per author.

3. **Track relay health — and consider NIP-66 pre-filtering.** At minimum, implement binary online/offline tracking with backoff. Ideally, use tiered error thresholds (Welshman) or penalty timers (Gossip) to avoid repeatedly connecting to flaky relays. [NIP-66](https://github.com/nostr-protocol/nips/blob/master/66.md) (kind 30166) and [nostr.watch](https://github.com/sandwichfarm/nostr-watch) publish network-wide relay liveness and performance data (RTT, uptime, supported NIPs) that clients could consume instead of independently probing relays — no analyzed client uses this yet. Our benchmarks show NIP-66 liveness filtering removes 40–64% of dead relays from the candidate set and more than doubles relay success rates (from ~30% to ~75–85%), with the biggest impact on profiles with large follow counts.

4. **Configure multiple indexer relays.** Relying on a single indexer (e.g., only purplepag.es) is a single point of failure. Amethyst's 5-indexer approach is the most resilient.

5. **Handle misconfigured kind 10002.** At minimum, filter out known-bad relay entries. Blocklists for aggregator relays (feeds.nostr.band, filter.nostr.wine) and special-purpose relays prevent wasted connections.

6. **Make outbox debuggable — but go beyond assignment coverage.** noStrudel's coverage debugger is the only client that exposes outbox internals (coverage %, orphaned users, per-relay assignment, color-coded health). But it only shows the academic view — the on-paper relay mapping. No client shows real-world event recall: "did I actually get the posts?" Our central finding is that these two views diverge sharply (85% assignment coverage can mean 16% event recall at 1yr). Opportunities for future work: per-author event delivery tracking ("am I seeing all events from this author?"), relay response/efficiency rates (events delivered per connection), orphan root-cause analysis (missing kind 10002 vs relays offline vs filtered out), and relay list staleness indicators.

7. **Stochastic exploration is the best archival strategy — and learning makes it even better.** Welshman's `random()` factor isn't just anti-centralization — it discovers relays that retain old events and that static optimizers miss. MAB-UCB's exploration-exploitation achieves the same effect. Welshman+Thompson Sampling adds memory to this randomness: after 2–3 sessions, it learns which relays actually deliver and outperforms baseline Welshman by up to 12pp (90% vs 78% at 3yr on Telluride). Pure greedy concentrates on mega-relays that may prune history.

8. **Support NIP-17 DM relays.** Only 4 of 10 mature implementations fully route DMs via kind 10050 relays. Kind 10050 is straightforward to implement and provides meaningful privacy benefits for direct messaging.

9. **Aggregator results are surprisingly poor.** Primal reaches 28% recall at 7d and <1% at 3yr — worse than Popular+Random (damus + nos.lol + 2 random relays) at every window. This is unexpected: an aggregator that proxies tens if not hundreds of relays should in theory outperform 4 random connections. This may indicate a limitation in the benchmark methodology rather than a real-world indictment of aggregators.

---

## Appendix: Source Code References

### Supporting Analysis
- [`analysis/clients/`](analysis/clients/) — Per-client cheat sheets (6 files)
- [`analysis/cross-client-comparison.md`](analysis/cross-client-comparison.md) — Cross-client comparison by decision point
- [`IMPLEMENTATION-GUIDE.md`](IMPLEMENTATION-GUIDE.md) — Opinionated recommendations backed by benchmark data

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

### Benchmark Algorithm Implementations

All 14 algorithms are in [`bench/src/algorithms/`](bench/src/algorithms/):

| Algorithm | Source | Inspired By |
|-----------|--------|-------------|
| Welshman+Thompson | [`welshman-thompson.ts`](bench/src/algorithms/welshman-thompson.ts) | Welshman + Thompson Sampling |
| Greedy+ε-Explore | [`greedy-epsilon.ts`](bench/src/algorithms/greedy-epsilon.ts) | Greedy + ε-exploration |
| Greedy Set-Cover | [`greedy-set-cover.ts`](bench/src/algorithms/greedy-set-cover.ts) | Gossip, Applesauce, Wisp |
| Priority-Based | [`priority-based.ts`](bench/src/algorithms/priority-based.ts) | NDK |
| Weighted Stochastic | [`weighted-stochastic.ts`](bench/src/algorithms/weighted-stochastic.ts) | Welshman/Coracle |
| Greedy Coverage Sort | [`greedy-coverage-sort.ts`](bench/src/algorithms/greedy-coverage-sort.ts) | Nostur |
| Filter Decomposition | [`filter-decomposition.ts`](bench/src/algorithms/filter-decomposition.ts) | rust-nostr |
| Direct Mapping | [`direct-mapping.ts`](bench/src/algorithms/direct-mapping.ts) | Amethyst (feeds) |
| Primal Aggregator | [`primal-baseline.ts`](bench/src/algorithms/primal-baseline.ts) | Baseline |
| Popular+Random | [`popular-plus-random.ts`](bench/src/algorithms/popular-plus-random.ts) | Baseline |
| ILP Optimal | [`ilp-optimal.ts`](bench/src/algorithms/ilp-optimal.ts) | CS: branch-and-bound |
| Stochastic Greedy | [`stochastic-greedy.ts`](bench/src/algorithms/stochastic-greedy.ts) | CS: lazier-than-lazy greedy |
| MAB-UCB | [`mab-relay.ts`](bench/src/algorithms/mab-relay.ts) | CS: combinatorial bandits |
| Streaming Coverage | [`streaming-coverage.ts`](bench/src/algorithms/streaming-coverage.ts) | CS: streaming submodular max |
| Bipartite Matching | [`bipartite-matching.ts`](bench/src/algorithms/bipartite-matching.ts) | CS: weighted matching |
| Spectral Clustering | [`spectral-clustering.ts`](bench/src/algorithms/spectral-clustering.ts) | CS: community detection |

Phase 2 verification: [`bench/src/phase2/`](bench/src/phase2/) (baseline construction, event verification, reporting, disk cache).

NIP-66 relay filtering: [`bench/src/nip66/`](bench/src/nip66/) (monitor data fetching, relay classification).

Relay score persistence: [`bench/src/relay-scores.ts`](bench/src/relay-scores.ts) (Thompson Sampling Beta distribution persistence).
