> **DRAFT** — This document is a work in progress. Findings and framing may change.

> **For the practitioner summary, see [README.md](README.md).** This document contains the full methodology, cross-client analysis, and complete benchmark data.

# Outbox Model Implementation Report

**An analysis of NIP-65 outbox/inbox relay routing across 15 Nostr clients and libraries**

*Produced for [nostrability#69](https://github.com/nostrability/nostrability/issues/69)*

*Benchmark data collected February 2026. Relay state changes continuously — results are a snapshot of network conditions at benchmark time. Relay availability, retention policies, and event counts will differ on re-run. Relative algorithm rankings should be stable; absolute recall percentages will vary.*

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

6. **No implementation cross-checks per-author delivery.** NIP-66 monitors check relay liveness, but no client verifies "did this relay return events for author X?" True completeness isn't measurable (no relay has everything), but cross-checking against a second source catches relays that consistently return nothing for a specific author.

7. **Academic coverage ≠ real-world event recall.** Event verification against real relays shows that algorithms optimizing for assignment coverage don't necessarily win at actual event retrieval. At 1 year, MAB-UCB achieves 40.8% event recall vs. Greedy Set-Cover's 16.3%. The relay that *should* have the event often doesn't — due to retention policies, downtime, or access restrictions. Stochastic exploration discovers relays that retain historical events. [Building Nostr](https://building-nostr.coracle.social) frames this as the routing problem: "the relay that 'should' have the event" is determined by the outbox heuristic, but "there are many notes that should not be posted to user outboxes" and "any event may be retrieved based on criteria other than event author." The outbox heuristic is only one of several routing heuristics needed — others include inbox (mentions), group, DM, and topic-based routing.

8. **Per-author relay diversity beats popularity concentration.** Filter Decomposition (25% 1yr, deterministic) edges out Welshman Stochastic (24% 1yr) — both 1.5× better than Greedy's 16%. The winning factor isn't randomness vs determinism; it's whether the algorithm discovers niche relays that retain events. FD gives each author their own top-N write relays, so niche relays enter the query set. Welshman's ``(1 + log(weight))`` popularity factor concentrates on high-volume relays that prune aggressively. FD's per-author median recall (87.5% on ODELL) vs Welshman's (50.0%) shows the effect: FD provides equitable per-author coverage while popularity weighting leaves authors on niche relays with zero recall.

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
| **FD+Thompson** | Filter Decomposition scoring with `sampleBeta(α, β)` instead of lexicographic order. Same per-author structure as rust-nostr but with learned delivery scores. No popularity weight — scores purely from delivery history | [`fd-thompson.ts`](bench/src/algorithms/fd-thompson.ts) |
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

#### NIP-11 Relay Classification (February 2026 snapshot)

To quantify the relay list pollution problem, we probed NIP-11 info documents for all candidate relays across 36 benchmark profiles (13,867 relay-user pairs, 2,359 unique relay URLs). Each relay was classified by its NIP-11 `limitation` fields:

| Category | Relay-user pairs | % of probes | Unique relays | % of unique |
|---|---:|---:|---:|---:|
| content | 5,130 | 37.0% | 548 | 23.2% |
| paid | 954 | 6.9% | 85 | 3.6% |
| auth-gated | 73 | 0.5% | 6 | 0.3% |
| restricted | 579 | 4.2% | 83 | 3.5% |
| no-nip11 | 2,378 | 17.1% | 491 | 20.8% |
| offline | 4,753 | 34.3% | 1,146 | 48.6% |

**46% of relay-user pairs point to relays that won't serve content** — offline (34%), paid (7%), restricted writes (4%), or auth-gated (0.5%). Another 17% lack NIP-11 info documents but are likely functional (NIP-11 is voluntary — ~500 functional relays don't serve it, per nostr.watch). Only 37% are confirmed open content relays via NIP-11. Nearly half (48.6%) of all unique relay URLs encountered were offline at probe time.

NIP-11 cannot determine relay liveness on its own — it's an HTTP info document, not a connectivity test. Use NIP-66 liveness data (WebSocket connectivity) to filter dead relays.

The most common offline relays appear in 32-34 of 36 profiles — widely listed but long dead: `relay.nostr.band`, `relay.nostr.bg`, `nostr.orangepill.dev`, `nostr.zbd.gg`, `relay.current.fyi`, `relayable.org`. These waste connection budget on every feed load.

Paid relays like `nostr.wine`, `nostr.land`, `atlas.nostr.land` appear in 34/36 profiles. While some paid relays serve content to readers without payment, others require authentication or payment for any access. The `filter.nostr.wine/*` pattern alone accounts for 104 unique URLs (per-user broadcast proxies).

Restricted-write relays like `pyramid.fiatjaf.com` (34/36 users), `nostr.einundzwanzig.space` (32/36), and `nostr.thank.eu` (28/36) are community or personal relays that won't serve general content queries.

*Classification: `content` = no restriction flags; `paid` = `limitation.payment_required: true`; `auth-gated` = `limitation.auth_required: true`; `restricted` = `limitation.restricted_writes: true` without paid/auth; `no-nip11` = no NIP-11 response (relay may still be functional — NIP-11 is voluntary); `offline` = connection failed. Probed with 5s HTTP timeout, `Accept: application/nostr+json`. Data: [`bench/.cache/nip11_probe_*.json`](bench/.cache/).*

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
8. **Greedy+ε-exploration at higher ε values** -- showed negligible benefit at ε=0.05 in our benchmarks; higher values may be needed.
9. **Sliding window for learning** -- only use the last N observations per relay, or exponentially decay old ones. Relay quality changes over time.
10. **Per-author event recall as reward** -- current reward is binary (is this author covered?). Better: how many of this author's events did this relay actually deliver?
11. **Contextual features** -- use NIP-11 capabilities, NIP-66 health data, paid vs free as features for estimating new relay quality without exploring.

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

| User (follows) | Primal | BigRelays | Ceiling | Greedy | NDK | Welshman | Nostur | rust-nostr | Direct |
|----------------|-------:|----------:|--------:|-------:|----:|---------:|-------:|-----------:|-------:|
| ODELL (1,779) | 100%* | 64.1% | 76.6% | **75.3%** | 74.9% | 73.7% | 66.4% | 69.8% | 74.1% |
| Derek Ross (1,328) | 100%* | 69.3% | 80.8% | **79.6%** | 79.3% | 78.2% | 69.8% | 73.9% | 78.5% |
| pablof7z (1,050) | 100%* | 57.6% | 67.7% | **66.4%** | 66.1% | 65.7% | 60.9% | 62.0% | 65.8% |
| Gigi (1,033) | 100%* | 57.9% | 67.2% | **66.2%** | 65.7% | 65.2% | 58.4% | 62.1% | 64.9% |
| jb55 (943) | 100%* | 59.8% | 69.2% | **68.1%** | 67.7% | 67.1% | 63.6% | 64.4% | 66.7% |
| verbiricha (938) | 100%* | 70.5% | 82.2% | **80.3%** | 78.8% | 79.6% | 71.4% | 75.5% | 79.7% |
| miljan (811) | 100%* | 62.0% | 76.4% | **75.2%** | 74.8% | 73.9% | 66.2% | 68.1% | 74.0% |
| Calle (718) | 100%* | 54.9% | 69.8% | **68.2%** | 66.6% | 67.7% | 61.0% | 63.8% | 62.7% |
| jack (694) | 100%* | 46.5% | 56.1% | **55.3%** | **55.3%** | 54.3% | 50.7% | 51.6% | 54.3% |
| Karnage (581) | 100%* | 75.1% | 88.5% | **87.6%** | 87.4% | 87.1% | 76.6% | 81.2% | 86.2% |
| NVK (502) | 100%* | 54.0% | 65.7% | **64.9%** | **64.9%** | 64.1% | 61.4% | 59.2% | 63.7% |
| hodlbod (442) | 100%* | 74.7% | 87.1% | **84.8%** | 83.0% | 83.9% | 75.1% | 80.1% | 83.0% |
| Alex Gleason (434) | 100%* | 59.3% | 84.3% | **83.4%** | 82.7% | 82.6% | 74.2% | 78.1% | 82.7% |
| Semisol (421) | 100%* | 72.6% | 87.2% | **85.0%** | 84.8% | 84.8% | 81.0% | 82.2% | 84.6% |
| Martti Malmi (395) | 100%* | 62.9% | 72.4% | **71.6%** | 70.9% | 70.4% | 66.1% | 67.6% | 70.6% |
| hzrd149 (388) | 100%* | 74.0% | 84.0% | **82.7%** | 82.2% | 81.4% | 74.7% | 77.6% | 81.7% |
| Kieran (377) | 100%* | 71.4% | 80.4% | **79.3%** | 79.0% | 78.5% | 75.1% | 74.3% | 78.5% |
| Preston Pysh (369) | 100%* | 45.8% | 52.3% | **51.8%** | **51.8%** | 51.4% | 50.7% | 49.9% | 50.9% |
| Tony Giorgio (361) | 100%* | 63.7% | 72.0% | 70.6% | **71.2%** | 70.1% | 67.3% | 67.3% | 69.8% |
| Snowden (354) | 100%* | 58.2% | 63.0% | **62.7%** | 62.4% | 61.8% | 59.3% | 59.0% | 61.9% |
| Vitor (240) | 100%* | 68.3% | 82.5% | **80.8%** | 80.4% | 80.6% | 72.1% | 76.7% | 80.4% |
| Dilger (233) | 100%* | 63.1% | 80.3% | 76.8% | 76.4% | **77.0%** | 70.8% | 73.0% | 75.5% |
| Lyn Alden (226) | 100%* | 53.7% | 67.3% | **67.3%** | **67.3%** | 66.2% | 63.7% | 61.1% | 65.0% |
| fiatjaf (194) | 100%* | 63.4% | 76.3% | **75.3%** | **75.3%** | 73.2% | 61.9% | 71.1% | 71.6% |
| Ben Arc (137) | 100%* | 59.9% | 70.8% | **69.3%** | **69.3%** | 66.7% | 62.8% | 62.8% | 67.2% |
| Rabble (105) | 100%* | 76.9% | 90.5% | **90.5%** | **90.5%** | 89.5% | 75.2% | 85.7% | 88.6% |

Greedy Set-Cover wins 23 of 26 profiles. NDK ties on 7. Welshman wins 1 (Dilger). NDK wins 1 outright (Tony Giorgio).

\*"Primal" = Primal Aggregator, routes all queries to `wss://relay.primal.net`. 100% assignment coverage by definition (centralized, not outbox model). "BigRelays" = coverage from just `wss://relay.damus.io` + `wss://nos.lol` (% of follows who declare either as a write relay).

**Academic algorithms vs. Greedy baseline (20 connections) — benchmark ceilings only:**

| User (follows) | Primal | BigRelays | Ceiling | Greedy | ILP | Bipartite | Streaming | Spectral | MAB | StochGrdy |
|----------------|-------:|----------:|--------:|-------:|----:|----------:|----------:|---------:|----:|----------:|
| ODELL (1,779) | 100%* | 64.1% | 76.6% | 75.3% | **75.5%** | 75.3% | 75.4% | 75.4% | 75.0% | 73.9% |
| Derek Ross (1,328) | 100%* | 69.3% | 80.8% | 79.6% | **80.0%** | 79.9% | 79.9% | 79.9% | 79.2% | 78.9% |
| pablof7z (1,050) | 100%* | 57.6% | 67.7% | 66.4% | **66.9%** | 66.7% | 66.6% | 66.4% | 65.7% | 65.7% |
| Gigi (1,033) | 100%* | 57.9% | 67.2% | 66.2% | **66.7%** | **66.7%** | 66.5% | 66.6% | 66.2% | 65.9% |
| jb55 (943) | 100%* | 59.8% | 69.2% | 68.1% | **68.6%** | **68.6%** | **68.6%** | 68.5% | 67.9% | 67.7% |
| verbiricha (938) | 100%* | 70.5% | 82.2% | 80.3% | **80.6%** | 80.3% | 80.4% | 80.5% | 79.7% | 80.1% |
| miljan (811) | 100%* | 62.0% | 76.4% | 75.2% | **76.1%** | 75.6% | **76.1%** | 76.0% | 75.3% | 75.1% |
| Calle (718) | 100%* | 54.9% | 69.8% | 68.2% | **69.1%** | 68.7% | **69.1%** | 69.0% | 67.5% | 68.0% |
| jack (694) | 100%* | 46.5% | 56.1% | 55.3% | **56.1%** | 55.7% | **56.1%** | 56.0% | 54.9% | 54.8% |
| Karnage (581) | 100%* | 75.1% | 88.5% | 87.6% | **88.5%** | 88.2% | **88.5%** | **88.5%** | 86.5% | 87.4% |
| NVK (502) | 100%* | 54.0% | 65.7% | 64.9% | **65.7%** | 65.3% | **65.7%** | **65.7%** | 63.5% | 64.7% |
| hodlbod (442) | 100%* | 74.7% | 87.1% | 84.8% | **86.0%** | 85.5% | **86.0%** | 85.9% | 84.6% | 84.3% |
| Alex Gleason (434) | 100%* | 59.3% | 84.3% | 83.4% | **84.3%** | 83.6% | **84.3%** | **84.3%** | 78.1% | 82.6% |
| Semisol (421) | 100%* | 72.6% | 87.2% | 85.0% | **87.2%** | 86.4% | **87.2%** | 86.9% | 85.0% | 85.0% |
| Martti Malmi (395) | 100%* | 62.9% | 72.4% | 71.6% | **72.4%** | 72.0% | **72.4%** | **72.4%** | 69.6% | 70.6% |
| hzrd149 (388) | 100%* | 74.0% | 84.0% | 82.7% | **84.0%** | 83.4% | **84.0%** | **84.0%** | 82.1% | 82.0% |
| Kieran (377) | 100%* | 71.4% | 80.4% | 79.3% | **80.4%** | 80.1% | **80.4%** | **80.4%** | 78.7% | 79.0% |
| Preston Pysh (369) | 100%* | 45.8% | 52.3% | 51.8% | **52.3%** | 52.2% | **52.3%** | **52.3%** | 51.0% | 51.5% |
| Tony Giorgio (361) | 100%* | 63.7% | 72.0% | 70.6% | **72.0%** | 71.6% | **72.0%** | **72.0%** | 70.3% | 70.4% |
| Snowden (354) | 100%* | 58.2% | 63.0% | 62.7% | **63.0%** | 62.9% | **63.0%** | **63.0%** | 60.1% | 61.9% |
| Vitor (240) | 100%* | 68.3% | 82.5% | 80.8% | **82.5%** | 81.4% | **82.5%** | **82.5%** | 79.9% | 80.8% |
| Dilger (233) | 100%* | 63.1% | 80.3% | 76.8% | **80.3%** | 79.4% | **80.3%** | **80.3%** | 77.4% | 77.1% |
| Lyn Alden (226) | 100%* | 53.7% | 67.3% | **67.3%** | **67.3%** | 67.0% | **67.3%** | **67.3%** | 64.0% | 66.4% |
| fiatjaf (194) | 100%* | 63.4% | 76.3% | 75.3% | **76.3%** | 75.9% | **76.3%** | **76.3%** | 72.3% | 73.4% |
| Ben Arc (137) | 100%* | 59.9% | 70.8% | 69.3% | **70.8%** | 70.6% | **70.8%** | **70.8%** | 66.9% | 67.9% |
| Rabble (105) | 100%* | 76.9% | 90.5% | **90.5%** | **90.5%** | **90.5%** | **90.5%** | **90.5%** | 86.0% | 89.8% |

ILP, Streaming Coverage, and Spectral Clustering frequently hit the theoretical ceiling — confirming that Greedy Set-Cover leaves only 1-4% on the table. These academic algorithms validate the practitioner results but are not themselves deployable (see "Why not practical" in the appendix).

"Ceiling" = NIP-65 adoption rate (% of follows with any valid write relay). No algorithm can exceed this.

\*"Primal" = Primal Aggregator, routes all queries to `wss://relay.primal.net`. 100% assignment coverage by definition (centralized, not outbox model). "BigRelays" = coverage from just `wss://relay.damus.io` + `wss://nos.lol` (% of follows who declare either as a write relay).

**Key coverage findings:**

*Practitioner takeaways:*
1. **Greedy Set-Cover wins 23 of 26 profiles** among client-derived algorithms (ties NDK on 7, loses to Welshman on 1, loses to NDK on 1).
2. **Rankings are remarkably stable** regardless of follow count or NIP-65 adoption rate: Greedy > NDK (~0-2% behind) > Welshman (~1-3%) > Direct (~3-5%) > Filter Decomposition (~3-5%) > Coverage Sort (~5-12%).
3. **Nostur's skip-top-relays heuristic costs 5-12%** of coverage. Popular relays are popular because many authors publish there.
4. **20 connections is nearly sufficient.** Greedy at 10 connections already achieves 93-97% of its unlimited coverage.
5. **NIP-65 adoption is the real bottleneck.** 10-48% of follows lack any relay list. Better algorithms cannot fix missing data.
6. **Concentration is the tradeoff.** Greedy has the highest Gini coefficient (0.77) -- a few relays handle most traffic. Stochastic approaches spread load more evenly (Gini 0.39-0.51) at the cost of lower coverage.

*Academic observations (benchmark context only):*
7. **ILP and Streaming Coverage hit the theoretical ceiling** on most profiles with ≤500 follows, using fewer than 20 connections. The coverage gap between Greedy and optimal is 1-4%.
8. **MAB-UCB trades coverage for exploration.** It underperforms Greedy by 0-3% on assignment coverage, but this exploration pays off in real-world event recall (Section 8.2).

### 8.2 Approximating Real-World Conditions: Event Verification

**What this measures:** Did you actually get the posts? This connects to real relays and queries for kind-1 events within time windows, comparing against a multi-relay baseline. Results depend on relay uptime, retention policies, event propagation, and auth requirements.

**Methodology:**
- Baseline: query ALL declared write relays for each author, plus additional relays needed by baselines (primal.net, damus.io, nos.lol)
- Authors classified as **testable-reliable** (events found + ≥50% declared relays responded), **testable-partial** (<50% responded), **zero-baseline** (no events, relays responded), or **unreliable** (no events, relays unresponsive)
- Events per (relay, author) pair capped at 10,000 to eliminate recency bias
- 22 algorithms (+ 2 latency-aware variants) tested across 6 time windows (7d to 3 years)

**Baseline limitations:** The baseline is a lower bound, not ground truth. If a relay is down or slow during the baseline query, events stored there are missed — making the baseline incomplete and all recall percentages conservative. Relay success rates during baseline construction range from 31% (ODELL, 1,199 relays) to 55% (fiatjaf, 234 relays), meaning 45-69% of declared relays did not respond. The "testable-reliable" author filter (≥50% declared relays responded) mitigates this by excluding authors whose baseline is likely incomplete, but some undercount is inherent. All recall percentages in this report should be read as "at least X%" rather than exact values.

**Relay diagnostics (cross-profile):** Success rates range from 31% (ODELL, 1,199 relays) to 47% (hodlbod, 489 relays) — inversely correlated with relay count because larger follow lists include more obscure relays. Failures are structural (deterministic per relay, not transient): 12 relays fail across all 6 profiles (NIP-42 auth-required, WoT-gated, or queries blocked). `filter.nostr.wine/*` personal relays are the largest single source of CLOSED messages (5–22 per profile). ~50% of authors with relay lists are "testable-reliable" (events retrievable from declared relays) — this ratio is a network constant across all profiles (47–52%).

**Why recall degrades with time window:** Relay retention policies are the binding constraint. Most relays prune old events to manage storage — popular high-volume relays prune more aggressively because they receive more data. A greedy algorithm that concentrates on these popular relays sees 93% recall at 7 days but 16% at 1 year: the relays it selected had the events last week, but deleted them months ago. Stochastic algorithms discover smaller relays that retain history longer because they receive less volume. This is why randomness in relay selection isn't noise — it's an archival strategy.

Event recall across time windows (fiatjaf single-profile, testable-reliable authors). For 6-profile mean validation, see cross-profile section. Events per (relay, author) pair capped at 10,000 — this prevents a single prolific relay from dominating the baseline count and biasing recall percentages toward whichever algorithm happens to select that relay.

**Practitioner algorithms** (deployed or deployable in real clients):

| Algorithm | 3yr | 1yr | 90d | 30d | 14d | 7d |
|-----------|:---:|:---:|:---:|:---:|:---:|:---:|
| **Welshman Stochastic** | **21.1%** | **37.8%** | **59.7%** | 68.6% | 82.8% | 93.2% |
| NDK Priority | 11.2% | 18.7% | 36.1% | 61.4% | 76.5% | 92.3% |
| Filter Decomposition | 10.6% | 19.0% | 39.0% | 63.1% | 77.5% | 88.1% |
| Greedy Set-Cover | 9.8% | 16.3% | 35.8% | 61.8% | 77.5% | 93.5% |
| Direct Mapping† | 9.4% | 16.8% | 38.5% | 63.9% | 79.9% | 89.9% |
| Coverage Sort (Nostur) | 7.4% | 13.3% | 30.8% | 53.5% | 65.6% | 67.6% |
| Popular+Random‡ | 6.6% | 11.8% | 27.1% | 53.3% | 71.9% | 83.4% |
| Big Relays§ | 3.0% | 4.9% | 10.9% | 21.4% | 34.6% | 56.5% |
| Primal Aggregator | 0.9% | 1.6% | 3.7% | 8.3% | 14.5% | 28.3% |

†Direct Mapping uses unlimited connections (all declared write relays). Other algorithms capped at 20.
‡Popular+Random = relay.damus.io + nos.lol + 2 random relays from the candidate set.
§Big Relays = just relay.damus.io + nos.lol with no outbox logic — the "do nothing" baseline.

**Academic algorithms** (benchmark ceilings — not practical for real clients):

| Algorithm | 3yr | 1yr | 90d | 30d | 14d | 7d | Why not practical |
|-----------|:---:|:---:|:---:|:---:|:---:|:---:|-------------------|
| MAB-UCB | 22.8% | 40.8% | 65.9% | 74.6% | 82.3% | 93.5% | 500 simulated rounds per selection |
| ILP Optimal | 21.3% | 38.1% | 60.3% | 70.9% | 83.2% | 98.0% | NP-hard solver, exponential worst-case |
| Bipartite Matching | 21.2% | 38.0% | 60.3% | 71.0% | 83.3% | 98.0% | O(V²E) matching, complex implementation |
| Streaming Coverage | 21.2% | 37.9% | 59.8% | 69.9% | 81.7% | 97.5% | Marginal gains over simpler approaches |
| Spectral Clustering | 21.2% | 37.9% | 59.8% | 69.9% | 81.7% | 97.5% | Eigendecomposition, requires linear algebra library |
| Stochastic Greedy | 12.6%† | 11.6% | 23.9% | 43.3% | 56.8% | 67.1% | Worse than standard greedy at this problem scale |

†Stochastic Greedy's non-monotonic 3yr > 1yr result (12.6% > 11.6%) is a data artifact: the algorithm selects ~12 relays (fewer than budget due to early convergence), and the baseline event count grows faster than the algorithm's miss rate at this window boundary.

The academic algorithms define performance ceilings but are not deployable: ILP requires an optimization solver and has exponential worst-case runtime. MAB-UCB runs 500 internal rounds to approximate a single relay selection. Bipartite matching, spectral clustering, and streaming coverage add implementation complexity for marginal gains over simpler practitioner algorithms. At 7d (fiatjaf), Welshman Stochastic achieves 99% of the best academic algorithm's recall. At 1yr cross-profile, the gap widens: Welshman 24% vs MAB-UCB 33% — but this gap is closable through learning (Thompson Sampling), not through more complex static algorithms.

**Cross-profile validation (testable-reliable authors):**

To test whether patterns generalize beyond fiatjaf, event recall was measured across 6 diverse follow lists. Profile sizes range from 377 follows (Kieran) to 1,779 (ODELL).

**1yr window:**

**Practitioner algorithms** (deployed or deployable in real clients):

| Algorithm | fiatjaf | hodlbod | Kieran | jb55 | ODELL | Derek Ross | Mean [range] |
|-----------|:-------:|:-------:|:------:|:----:|:-----:|:----------:|:----:|
| **Direct Mapping**† | 16.8% | 28.9% | 21.6% | 40.1% | 38.5% | 35.6% | **30.3%** [17–40] |
| **Filter Decomposition** | 19.0% | 20.2% | 21.0% | 31.9% | 28.4% | 28.5% | **24.8%** [19–32] |
| **Welshman Stochastic** | 37.8% | 24.3% | 11.8% | 27.0% | 21.0% | 20.8% | **23.8%** [12–38] |
| **Popular+Random**‡ | 11.8% | 29.5% | 14.2% | 22.1% | 20.2% | 19.6% | **19.6%** [12–30] |
| **Coverage Sort (Nostur)** | 13.3% | 22.0% | 8.9% | 16.7% | 17.8% | 19.8% | **16.4%** [9–22] |
| **Greedy Set-Cover** | 16.3% | 14.3% | 12.4% | 20.1% | 16.0% | 18.4% | **16.3%** [12–20] |
| **NDK Priority** | 18.7% | 12.6% | 12.3% | 19.0% | 16.3% | 18.7% | **16.3%** [12–19] |
| **Big Relays**§ | 4.9% | 7.3% | 5.8% | 12.3% | 10.2% | 10.0% | **8.4%** [5–12] |
| **Primal Aggregator** | 1.6% | 0.4% | 0.2% | 0.4% | 0.7% | 0.4% | **0.6%** [0.2–1.6] |

†Direct Mapping uses all declared write relays with no connection cap (typically 50-200+ connections). All other algorithms are capped at 20 connections.
‡Popular+Random = relay.damus.io + nos.lol + 2 random relays from the candidate set.
§Big Relays = just relay.damus.io + nos.lol with no outbox logic — the "do nothing" baseline.

**Academic algorithms** (benchmark ceilings — not practical for real clients):

| Algorithm | fiatjaf | hodlbod | Kieran | jb55 | ODELL | Derek Ross | Mean [range] |
|-----------|:-------:|:-------:|:------:|:----:|:-----:|:----------:|:----:|
| MAB-UCB | 40.8% | 41.5% | 21.4% | 39.3% | 24.7% | 32.3% | **33.3%** [21–42] |
| Streaming Coverage | 37.9% | 35.0% | 16.2% | 28.8% | 28.1% | 32.6% | **29.8%** [16–38] |
| Spectral Clustering | 37.9% | 34.0% | 15.2% | 28.6% | 21.2% | 40.5% | **29.6%** [15–41] |
| ILP Optimal | 38.1% | 31.8% | 15.1% | 23.1% | 21.2% | 29.6% | **26.5%** [15–38] |
| Bipartite Matching | 38.0% | 32.1% | 15.3% | 22.7% | 21.9% | 30.4% | **26.7%** [15–38] |
| Stochastic Greedy | 11.6% | 14.1% | 9.6% | 16.1% | 6.2% | 12.9% | **11.8%** [6–16] |

**7d window:**

**Practitioner algorithms** (deployed or deployable in real clients):

| Algorithm | fiatjaf | hodlbod | Kieran | jb55 | ODELL | Derek Ross | Mean [range] |
|-----------|:-------:|:-------:|:------:|:----:|:-----:|:----------:|:----:|
| **Direct Mapping**† | 89.9% | 85.9% | 90.9% | 85.9% | 87.6% | 87.3% | **87.9%** [86–91] |
| **Greedy Set-Cover** | 93.5% | 87.6% | 84.8% | 81.0% | 77.2% | 82.5% | 84.4% [77–94] |
| **NDK Priority** | 92.3% | 82.1% | 85.2% | 81.1% | 77.2% | 82.0% | 83.3% [77–92] |
| **Welshman Stochastic** | 93.2% | 83.6% | 84.6% | 84.1% | 74.8% | 77.8% | 83.0% [75–93] |
| **Popular+Random**‡ | 83.4% | 86.8% | 84.1% | 87.0% | 76.9% | 79.7% | 83.0% [77–87] |
| **Filter Decomposition** | 88.1% | 74.7% | 81.7% | 74.0% | 71.4% | 72.1% | 77.0% [71–88] |
| **Greedy Coverage Sort** | 67.6% | 63.7% | 79.6% | 62.4% | 54.5% | 61.0% | 64.8% [55–80] |
| **Big Relays** | 56.5% | 64.4% | 69.9% | 67.4% | 45.0% | 62.3% | 60.9% [45–70] |
| **Primal Aggregator** | 28.3% | 37.3% | 34.8% | 25.2% | 33.6% | 30.2% | 31.6% [25–37] |

†Direct Mapping uses all declared write relays with no connection cap (typically 50-200+ connections). All other algorithms are capped at 20 connections. Its high recall reflects unlimited connections, not algorithmic superiority.

‡Popular+Random = relay.damus.io + nos.lol + 2 random relays from the candidate set. A "minimum viable outbox" baseline.

**Academic algorithms** (benchmark ceilings — not practical for real clients):

| Algorithm | fiatjaf | hodlbod | Kieran | jb55 | ODELL | Derek Ross | Mean [range] |
|-----------|:-------:|:-------:|:------:|:----:|:-----:|:----------:|:----:|
| Streaming Coverage | 97.5% | 93.2% | 91.8% | 92.6% | 88.1% | 90.9% | 92.4% [88–98] |
| ILP Optimal | 98.0% | 96.8% | 90.5% | 91.6% | 87.2% | 89.8% | 92.3% [87–98] |
| Spectral Clustering | 97.5% | 94.8% | 89.7% | 93.3% | 87.0% | 89.8% | 92.0% [87–98] |
| Bipartite Matching | 98.0% | 93.1% | 90.1% | 93.1% | 86.3% | 90.1% | 91.8% [86–98] |
| MAB-UCB | 93.5% | 92.9% | 92.5% | 92.4% | 83.0% | 90.9% | 90.9% [83–94] |
| Stochastic Greedy | 67.1% | 73.0% | 76.8% | 64.7% | 46.3% | 72.5% | 66.7% [46–77] |

*[range] = min–max across 6 profiles (194–1,779 follows). The spread reflects real cross-profile heterogeneity — profiles with different follow counts and relay diversity get different recall. For stochastic algorithms, single-seed results add run-to-run variance on top (see variance analysis below).*

The ~8pp gap between the best academic algorithm (92.4%) and the best 20-connection practitioner algorithm (Greedy, 84.4%) represents the theoretical ceiling that no simple, deployable algorithm has reached. Direct Mapping (87.9%) narrows this to ~4.5pp but requires unlimited connections. However, Welshman+Thompson Sampling (Section 8.3) closes most of this gap through learning at 7d — achieving 84-92% after 2-3 sessions (HJO data) without the implementation complexity of the academic algorithms. At 1yr, Thompson reaches 39% (10-run validated) — relay retention, not algorithmic quality, is the binding constraint at longer windows.

Profile characteristics:

| Profile | Follows | With Relay List | Unique Relays | Testable Authors (7d) | Baseline Events (7d) | Testable Authors (1yr) | Baseline Events (1yr) |
|---------|:-------:|:---------------:|:-------------:|:---------------------:|:--------------------:|:----------------------:|:---------------------:|
| fiatjaf | 194 | 87.1% | 233 | ~116 | 2,176 | ~116 | ~17,000 |
| hodlbod | 442 | 87.1% | 489 | 191 | 5,357 | 254 | 59,812 |
| Kieran | 377 | 80.4% | 404 | 156 | 3,801 | 196 | 54,942 |
| jb55 | 943 | 69.2% | 725 | 305 | 8,255 | 387 | 58,713 |
| ODELL | 1,779 | 76.6% | 1,199 | 661 | 19,057 | 794 | 127,357 |
| Derek Ross | 1,328 | 80.8% | 1,018 | 523 | 15,240 | 645 | 107,426 |

Cross-profile patterns:

*At 7d:*
- **Direct Mapping leads at 87.9% mean** but uses unlimited connections (50-200+). Among 20-connection algorithms, Greedy/NDK/Welshman cluster at 83-84% — effectively tied.
- **~8pp gap to academic ceiling** (92% vs 88% mean). Closable through learning: Welshman+Thompson Sampling (Section 8.3) reaches 84-92% at 7d after 2-3 sessions (HJO data); 39% at 1yr (10-run validated).
- **Greedy Set-Cover ranks 2nd among 20-connection algorithms** but the margin is narrow — assignment coverage optimization provides modest benefit at 7d because most relays still have recent events.

*At 1yr:*
- **Filter Decomposition (rust-nostr) emerges as #2** at 24.8% mean — its per-author top-N relay strategy preserves relay diversity better than greedy approaches at longer windows.
- **Welshman Stochastic is #3 at 23.8% mean** — still 1.5× better than Greedy (16.3%), confirming that stochastic selection helps for historical access, though less dramatically than the fiatjaf-only data suggested (2.3×).
- **Welshman's fiatjaf result (37.8%) was an outlier.** Cross-profile mean of 23.8% is more representative. The stochastic advantage is real but profile-dependent.
- **Greedy Set-Cover and NDK tie at 16.3%** — both deterministic algorithms degrade similarly as relay retention becomes the binding constraint.
- **ODELL remains hardest** (largest follow list) but the pattern is consistent across all profiles.
- **Academic algorithms define the ceiling at ~33% mean** (MAB-UCB), but even the ceiling is modest — relay retention, not algorithm choice, is the fundamental constraint at 1yr.

**Variance analysis (stochastic algorithms, 1yr window):**

Single-seed results can be misleading. To quantify run-to-run variability, we ran Welshman Stochastic and Popular+Random with 5 PRNG seeds (0–4) on 3 profiles at the 1yr window. Each run also encounters different baseline conditions (relay availability, response times), so the variance captures both algorithmic randomness and network noise.

| Profile | Follows | Welshman seeds 0–4 | Mean ± std | P+R seeds 0–4 | Mean ± std |
|---------|:-------:|---------------------|:----------:|----------------|:----------:|
| fiatjaf | 194 | 37.8, 20.2, 23.3, 16.9, 25.2 | 24.7% ± 8.0pp | 11.8, 18.9, 20.1, 14.9, 23.0 | 17.7% ± 4.4pp |
| jb55 | 655\* | 27.0, 26.8, 30.5, 36.5, 27.8 | 29.7% ± 4.1pp | 22.1, 23.0, 23.7, 23.4, 22.6 | 23.0% ± 0.6pp |
| ODELL | 1,779 | 21.0, 18.5, 17.6, 19.4, 17.0 | 18.7% ± 1.6pp | 20.2, 18.9, 18.9, 19.2, 18.3 | 19.1% ± 0.7pp |

*\*jb55's follow count was 655 when this variance analysis was run (earlier data snapshot); later benchmarks show 943-945. Follow counts change as users follow/unfollow.*

Key observations:
- **Variance decreases with follow count.** fiatjaf (194 follows) has ±8pp Welshman std; ODELL (1,779 follows) has ±1.6pp. Larger follow lists average out per-relay randomness.
- **fiatjaf seed 0 (37.8%) was a genuine outlier** — 1.6 standard deviations above the mean. The cross-profile table's single-seed values should be interpreted with this variance in mind.
- **Popular+Random is remarkably stable** for larger profiles (±0.6–0.7pp for jb55/ODELL). Its randomness is limited to 2 relay slots, so most of the signal comes from the fixed Popular relays.
- **At large follow counts, Welshman ≈ Popular+Random.** ODELL shows 18.7% vs 19.1% — within noise. The stochastic advantage is strongest for smaller, more concentrated follow lists.
- **Baseline variability matters.** The number of testable-reliable authors varies 5-10% between runs of the same profile (e.g., jb55: 368–390), reflecting relay availability differences. This contributes to variance beyond PRNG.

### 8.3 Expanded Benchmark: NIP-66 Filter, Thompson Sampling, and Multi-Session Learning

**Key learning: how much does Thompson actually help?** Thompson's gain is real but depends on time window. The binding constraint shifts from relay selection to relay retention as the window grows:

| Window | Stochastic baseline | Thompson (5 sessions) | Absolute | Relative | What limits further gains |
|:---:|:---:|:---:|:---:|:---:|---|
| **7d** | 63-90% | 78-92% | +4-15pp | +5-19% | EN baseline already high; JP lower due to fragmented relays |
| **1yr** | 18-30% | 29-39% | +9-11pp | **+30-62%** | Relay retention: events pruned after 6-12 months |
| **3yr** | 13-19% | 21-26% | +7-9pp | **+37-68%** | Severe retention: most relays empty beyond 2 years |

*EN data: 6 profiles, 10-run variance study (7d from HJO). JP data: 6 profiles, 5 sessions, `--no-phase2-cache`. JP profiles show larger absolute gains (+15pp 7d, +11pp 1yr) but wider per-profile variance (-5pp to +59pp at 1yr) due to more fragmented relay topology.*

*Thompson gains are highly profile-dependent — driven by relay graph complexity, not follow count. The original EN-only data suggested an inverted-U (small graphs = budget saturation, large graphs = connection cap). JP data breaks this: tanakei (84 follows) shows the largest gains across all 12 profiles (+34pp 7d, +59pp 1yr) because the JP relay ecosystem is fragmented enough that even small follow graphs have meaningful relay diversity for Thompson to exploit.*

*Methodology note: The phase2 baseline cache had a serialization bug (fixed in schema v2) that inflated multi-session results. All Thompson numbers below are from genuine `--no-phase2-cache` methodology or single-session (S1) data. See README for the 10-run variance study.*

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

NIP-66 filtering benefits stochastic algorithms (MAB-UCB, Welshman) most because they sample from the full relay pool — removing dead relays from that pool directly improves sample quality. Thompson Sampling shows negligible NIP-66 deltas because it learns to avoid dead relays through delivery feedback. Greedy also shows negligible deltas, but for a different reason — its deterministic coverage-maximization selects relays by declared write lists regardless of liveness. See [NIP-66 Comparison Report](bench/NIP66-COMPARISON-REPORT.md) for per-profile single-session data.

**Thompson Sampling learning:**

Thompson Sampling persists per-relay Beta(α,β) parameters across sessions. Session 1 uses uniform priors (equivalent to baseline Welshman). Subsequent sessions use learned priors. Genuine multi-session results from the 10-run variance study (6 profiles × 10 independent 5-session sequences, `--no-phase2-cache`):

- **1yr:** Welshman+Thompson = 39.0% ± 2.7 SE (+9pp over stochastic baseline, +30% relative). FD+Thompson = 37.2% ± 2.8 SE. NDK+Thompson = 30.8% ± 3.8 SE.
- **3yr:** Paired deltas: WT +7.2pp, FD +8.6pp, NDK +8.8pp (all delta/SE > 4, statistically significant). +37% relative gain.
- **7d (HJO data):** +4pp (WT) / +7pp (FD) mean S1→S5 gain. Baseline already 79-90%, so gains are smaller in absolute terms (+5-8% relative).

MAB-UCB remains the best single-session algorithm — its internal exploration-exploitation (500 simulated rounds) defines the benchmark ceiling. Thompson needs 2-3 sessions to approach it but is actually deployable.

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

1. **Thompson Sampling is the first relay selection algorithm that closes the feedback loop** — and it works. At 7d: HJO data shows +4pp (WT) / +7pp (FD) mean S1→S5 gain (per-profile range: -1pp to +11pp — the baseline is already 79-90%). At 1yr: 10-run variance study confirms Welshman+Thompson = 39.0% ± 2.7 SE (+9pp over stochastic baseline), FD+Thompson = 37.2% ± 2.8 SE, NDK+Thompson = 30.8% ± 3.8 SE. At 3yr: paired deltas of +7-9pp are statistically significant (delta/SE > 4 for all three algorithm pairs). Per-profile std is typically 1-5pp, with outliers on fiatjaf (8-11pp) and Gato NDK+T (11pp). FD controlled comparison (same-run S1→S5) shows +14pp mean gain at 1yr.

2. **NIP-66 liveness filtering is high-value, low-effort.** It requires no algorithmic changes — just remove dead relays before running any algorithm. The impact is largest for stochastic algorithms and larger follow counts.

3. **Greedy+ε-Explore shows negligible benefit.** At 5% exploration rate, it matches Greedy almost exactly across all metrics. Higher ε values may show different results.

4. **MAB-UCB remains the best single-session algorithm — but isn't shippable.** Without learning history, MAB-UCB's internal exploration-exploitation (500 simulated rounds) outperforms everything. It defines the benchmark ceiling. Thompson Sampling needs 2–3 sessions to match it but is actually deployable.

5. **The 20-connection limit is the fundamental bottleneck at scale.** Telluride (2,784 follows) at 3yr shows all algorithms struggling: Greedy at 56%, Thompson at 63%, MAB-UCB at 67%. The relay diversity needed to cover 2,784 authors' 3-year history exceeds what 20 connections can provide.

6. **3yr recall drops ~35-40% relative to 1yr for all algorithms.** Clean 3yr baselines (no-cache, 5 profiles): Welshman 19.2%, FD 16.6%, Greedy 13.6%, NDK 13.3%. Thompson at 3yr: WT 26.6%, FD+T 25.8%, NDK+T 23.4%. The binding constraint is relay retention — relays prune events older than 1-2 years — not algorithmic quality. Thompson's +7-9pp 3yr paired deltas confirm it still learns effectively at longer windows, but can't recover events that no longer exist on any relay.

**Key real-world event verification findings:**

*Practitioner takeaways:*
1. **Coverage-optimal ≠ event-recall-optimal.** Greedy Set-Cover wins Phase 1 (assignment coverage) but at 1yr drops to 16% event recall (6-profile mean) while Filter Decomposition (25%) and Welshman Stochastic (24%) retain more history through relay diversity.

2. **Welshman's `random()` factor helps for archival.** The stochastic factor in ``quality * (1 + log(weight)) * random()`` spreads queries across more relays over time. At 1 year: 24% mean recall across 6 profiles (1.5× Greedy's 16%). Filter Decomposition (25%) edges it out through per-author relay diversity. Welshman's fiatjaf-specific result (37.8%) was an outlier — cross-profile means are more representative. Variance analysis (5 seeds × 3 profiles) shows ±2–8pp run-to-run std, with variance decreasing as follow count increases.

3. **Greedy Set-Cover degrades sharply.** 84% at 7d → 16% at 1 year (6-profile means). It minimizes connections by concentrating on popular relays, but those relays don't necessarily retain old events. Algorithms that spread queries fare better long-term.

4. **Aggregator results are surprisingly poor.** Primal achieves only 31.6% recall at 7 days (6-profile mean) and 0.9% at 3 years (fiatjaf single-profile) — worse than Popular+Random (damus + nos.lol + 2 random relays) at every window. This is unexpected for a relay that proxies many upstream relays, and may indicate a benchmark methodology limitation rather than a definitive conclusion about aggregators.

5. **Author recall is more stable than event recall.** You can *find* most authors even at long windows (74-81% author recall at 1 year), but you miss most of their posts. The disparity means relay retention policies are the binding constraint, not relay selection.

*Academic context:*
7. **The academic ceiling is ~92% at 7d** (Streaming Coverage, ILP, Spectral Clustering). The ~5-8pp gap vs the best practitioner algorithm (88%) is closable through learning (Thompson Sampling reaches 84-92% at 7d after 2-3 sessions per HJO data) rather than through more complex static algorithms.

### 8.4 FD+Thompson: Filter Decomposition with Thompson Sampling

FD+Thompson applies Thompson Sampling to Filter Decomposition's per-author relay selection. Where Welshman+Thompson scores relays as `(1 + log(weight)) * sampleBeta(α, β)`, FD+Thompson scores purely by `sampleBeta(α, β)` — no popularity weight. This avoids biasing toward high-volume relays that many authors declare but that prune old events aggressively.

The algorithm is a direct upgrade path for rust-nostr: same per-author structure (select top N write relays per followed author), but ranking by learned delivery scores instead of lexicographic order.

**1yr cross-profile comparison (cap@20, single run, seed=0):**

| Profile (follows) | FD+Thompson | Welshman+Thompson | Filter Decomp | Weighted Stochastic |
|---|:---:|:---:|:---:|:---:|
| fiatjaf (194) | **39.0%** evt / **80.4%** auth | 37.0% / 78.6% | 25.5% / 72.5% | 24.7% / 72.5% |
| Gato (399) | 20.6% / **89.5%** | **22.5%** / 87.4% | 13.1% / 78.4% | 14.5% / 75.5% |
| ODELL (1,779) | 29.1% / 79.7% | **30.5%** / **82.7%** | 21.6% / 72.7% | 18.2% / 74.1% |
| Telluride (2,784) | **38.6%** / 81.4% | **38.6%** / **84.2%** | 32.3% / 75.5% | 30.3% / 74.7% |

**Per-author median recall (1yr, cap@20):**

| Profile (follows) | FD+Thompson | Welshman+Thompson | Filter Decomp | Weighted Stochastic |
|---|:---:|:---:|:---:|:---:|
| fiatjaf (194) | **39.4%** | 18.7% | 0.0% | 0.0% |
| Gato (399) | 97.9% | **98.5%** | 87.5% | 83.3% |
| ODELL (1,779) | 55.0% | **64.0%** | 35.0% | 17.0% |
| Telluride (2,784) | 77.6% | **82.4%** | 60.6% | 52.0% |

**Per-profile improvement over baseline Filter Decomposition (1yr event recall):**

| Profile (follows) | FD+Thompson | Baseline FD | Gain (absolute) | Gain (relative) |
|---|:---:|:---:|:---:|:---:|
| fiatjaf (194) | 39.0% | 25.5% | +13.5pp | +53% |
| Gato (399) | 20.6% | 13.1% | +7.5pp | +57% |
| ODELL (1,779) | 29.1% | 21.6% | +7.5pp | +35% |
| Telluride (2,784) | 38.6% | 32.3% | +6.3pp | +20% |
| **4-profile mean** | **31.8%** [21–39] | **23.1%** [13–32] | **+8.7pp** | **+38%** |

**FD+Thompson vs Welshman+Thompson (10-run variance study, 1yr):** Welshman+Thompson = 39.0% ± 2.7 SE, FD+Thompson = 37.2% ± 2.8 SE. The gap (~2pp) is smaller than the per-profile variance. FD controlled comparison (same-run FD S1 → FD+T S5) shows +14pp mean gain across 5 profiles.

**Key findings:**

1. **Both Thompson variants exceed their stateless baselines.** FD+Thompson averages 31.8% event recall in a single session vs Filter Decomposition's 23.1% at 1yr — a +38% relative improvement. After learning (10-run variance study): Welshman+Thompson = 39.0% ± 2.7 SE, FD+Thompson = 37.2% ± 2.8 SE at 1yr.

2. **Welshman+Thompson leads by ~2pp after convergence (10-run validated).** The `(1 + log(weight))` popularity factor provides a modest advantage. At 3yr, the gap narrows further (WT 26.6% vs FD+T 25.8%, <1pp).

3. **Median recall tells a different story.** FD+Thompson's 39.4% median on fiatjaf (vs 18.7% for Welshman+Thompson) shows more equitable per-author coverage — fewer authors with zero recall. At larger scales, Welshman+Thompson's median advantage (64% vs 55% on ODELL) reflects better overall delivery.

4. **Both hit the same ceiling.** The relay-discovery problem ([issue #21](https://github.com/nostrability/outbox/issues/21)) limits all algorithms equally — current NIP-65 lists don't reflect where authors wrote a year ago. Staab's [Building Nostr](https://building-nostr.coracle.social) identifies this as the content migration problem: "the onus is on users (and by extension their clients) to choose good outbox relays and publish their events to them… it is the responsibility of anyone that changes the result of relay selection heuristics to synchronize events to the new relay." His [replicatr](https://github.com/coracle-social/replicatr) tool automates this via negentropy-based sync, but notes "synchronization is currently absent from most (or all) implementations."

---

### 8.5 Hybrid Outbox: App Relay Broadcast + Per-Author Thompson

Sections 8.3 and 8.4 benchmark full outbox routing — every filter is decomposed by author and routed to their write relays. This section benchmarks a **hybrid approach**: keep a fixed set of app relays for the main feed (broadcast, no per-author routing), and add per-author outbox queries only for long-tail paths (profile views, event lookups, thread traversal).

The algorithm models [Ditto-Mew](https://gitlab.com/soapbox-pub/ditto-mew)'s architecture: 4 hardcoded app relays (relay.ditto.pub, relay.primal.net, relay.damus.io, nos.lol) broadcast all feed queries. For profile/event lookups, the viewed author's NIP-65 write relays are fetched, scored by Thompson Sampling, and the top 3 are queried in parallel with the app relays.

**Why this matters:** Full outbox routing requires rewriting the relay routing layer — a significant engineering investment. Hybrid outbox is ~80 LOC of hook-level changes with no routing layer modifications. The question is how much recall this sacrifices.

**1yr cold-start comparison (cap@20, NIP-66 liveness filtered, S1 only — genuine):**

| Profile (follows) | Ditto-Mew baseline | Big Relays | Hybrid S1 | Welshman+Thompson S1 |
|---|:---:|:---:|:---:|:---:|
| fiatjaf (194) | 5.3% | 4.1% | 40.8% | 14.9% |
| Gato (399) | 7.4% | 6.5% | 24.3% | 31.2% |
| ODELL (1,779) | 7.1% | 6.2% | 32.7% | 29.1% |
| Telluride (2,784) | 5.0% | 3.6% | 23.7% | 17.5% |
| **4-profile mean** | **6.2%** [5–7] | **5.1%** [4–7] | **30.4%** [24–41] | **23.2%** [15–31] |

**Key findings:**

1. **Hybrid outbox beats full outbox on cold start.** Hybrid (30.4% mean) outperforms Welshman+Thompson (23.2% mean) at session 1 because the 4 app relays provide a guaranteed floor.

2. **The Ditto-Mew baseline (4 app relays, no outbox) averages 6.2% at 1yr.** This is comparable to Big Relays (5.1%) — 4 major relays capture roughly the same fraction of 1yr-old events as 2 major relays. The value of app relays is latency and reliability, not historical recall.

3. **Multi-session hybrid results (6 EN profiles × 5 sessions, no NIP-66 filter):**

| Window | Ditto-Mew (app relays only) | Ditto+Outbox Thompson (S5 mean) | Gain |
|:---:|:---:|:---:|:---:|
| **1yr** | 10.1% [7–12] | 22.8% [14–30] | **+12.6pp (+125%)** |
| **3yr** | 6.9% [4–10] | 15.4% [7–23] | **+8.5pp (+123%)** |

Hybrid outbox roughly doubles event recall vs app-relay-only across both time windows. ODELL shows the largest 1yr gain (+19pp) due to many follows publishing on niche relays. Full outbox Welshman+Thompson still leads (39% at 1yr) because it has no app-relay floor diluting the relay budget.

See [bench/src/algorithms/ditto-outbox.ts](bench/src/algorithms/ditto-outbox.ts) for the benchmark implementation and [bench/src/algorithms/ditto-mew.ts](bench/src/algorithms/ditto-mew.ts) for the baseline.

### 8.6 Greedy+Thompson

**Question:** Does Thompson Sampling help global-optimization algorithms (greedy set-cover) as much as per-author algorithms (Welshman, FD)?

**Result: No — gains are modest (+3pp mean at S5 1yr, 6 EN profiles).** Greedy set-cover's deterministic coverage-maximization leaves little room for Thompson to improve. The greedy loop picks relays by uncovered-pubkey count; multiplying by a Beta sample occasionally reranks candidates but rarely changes which relay gets selected because coverage count dominates.

**1yr EN (6 profiles × 5 sessions with learning, NIP-66 liveness, cap@20, S5 shown):**

| Profile (follows) | Greedy | Greedy+Thompson S5 | Gain |
|---|:---:|:---:|:---:|
| fiatjaf (194) | 27.7% | 33.4% | +5.7pp |
| Gato (399) | 14.6% | 20.1% | +5.5pp |
| hodlbod (442) | 16.3% | 19.9% | +3.6pp |
| jb55 (943) | 20.3% | 24.0% | +3.7pp |
| ODELL (1,779) | 16.7% | 16.8% | +0.1pp |
| Telluride (2,784) | 22.7% | 24.0% | +1.3pp |
| **6-profile mean** | **19.7%** | **23.0%** | **+3.3pp** |

*Mean across all 30 sessions (S1-S5): +2.4pp. Learning adds ~1pp over cold-start. ODELL is a near-zero responder — greedy already captures his relay graph optimally.*

At 3yr, Greedy+Thompson shows near-zero or negative gains (fiatjaf -4.4pp, mean +0.7pp across 6 profiles). The greedy algorithm's strength — deterministic optimal coverage — is also its weakness for Thompson: there isn't enough stochasticity for learning to exploit.

**Recommendation:** For greedy set-cover users (Gossip, Applesauce), Thompson Sampling is not the right upgrade path. Consider switching to a stochastic algorithm (Welshman) first, then adding Thompson, or adding NDK+Thompson integration which preserves deterministic priorities while allowing Thompson to influence the exploration tier.

### 8.7 NDK+Thompson 3yr

**3yr NDK+Thompson (6 EN profiles × 5 sessions, NIP-66 liveness, cap@20):**

| Profile (follows) | NDK baseline | NDK+Thompson | Gain |
|---|:---:|:---:|:---:|
| fiatjaf (194) | 17.9% | 9.0% ± 0.6 | -8.9pp |
| hodlbod (442) | 9.8% | 14.3% ± 1.5 | +4.5pp |
| jb55 (943) | 14.2% | 23.3% ± 1.6 | +9.1pp |
| ODELL (1,779) | 93.1% | 96.7% ± 1.2 | +3.6pp |
| Gato (399) | 10.6% | 16.4% ± 4.1 | +5.8pp |
| Telluride (2,784) | 17.4% ± 0.7 | 26.1% ± 2.4 | +8.8pp |

ODELL's unusually high 3yr baseline (93%) is due to relay.damus.io retaining a large fraction of events — NDK's priority cascade concentrates on this relay. fiatjaf shows regression (-8.9pp) at 3yr, consistent with the 1yr pattern where Thompson exploration disrupts NDK's fortuitous concentration on relay.damus.io.

### 8.8 NDK+Thompson Neutral Cold Start

**Question:** Does the fiatjaf regression come from Thompson's random cold start (Beta(1,1) = uniform noise), or from the learning itself? A neutral variant replaces cold-start randomness with a deterministic prior of 1.0 — unobserved relays get the same score as popularity alone.

**Result: Neutral does NOT fix the fiatjaf regression.** The neutral prior only helps at S1 (exactly matches base NDK by design). Once learning begins, Neutral converges to the same destructive relay weights within 2-3 sessions.

**1yr EN (6 profiles × 5 sessions, NIP-66 liveness, cap@20, S5 shown):**

| Profile (follows) | NDK base | NDK+T | NDK+T Neutral | T delta | Neutral delta |
|---|:---:|:---:|:---:|:---:|:---:|
| fiatjaf (194) | 39.1% | 16.1% | 19.0% | -23.0pp | -20.1pp |
| hodlbod (442) | 14.6% | 42.9% | 35.6% | +28.3pp | +21.0pp |
| jb55 (943) | 20.1% | 35.3% | 34.4% | +15.2pp | +14.3pp |
| ODELL (1,779) | 18.1% | 34.7% | 33.4% | +16.6pp | +15.3pp |
| Gato (399) | 16.5% | 51.4% | 46.2% | +34.9pp | +29.7pp |
| Telluride (2,784) | 22.6% | 41.2% | 34.1% | +18.6pp | +11.5pp |
| **6-profile mean** | **21.8%** | **36.9%** | **33.8%** | **+15.1pp** | **+12.0pp** |

**3yr EN (6 profiles × 5 sessions, S5 shown):**

| Profile (follows) | NDK base | NDK+T | NDK+T Neutral | T delta | Neutral delta |
|---|:---:|:---:|:---:|:---:|:---:|
| fiatjaf (194) | 17.8% | 8.7% | 8.6% | -9.1pp | -9.2pp |
| hodlbod (442) | 8.8% | 23.7% | 35.4% | +14.9pp | +26.6pp |
| jb55 (943) | 12.5% | 23.0% | 23.2% | +10.5pp | +10.7pp |
| ODELL (1,779) | 14.0% | 26.4% | 26.0% | +12.4pp | +12.0pp |
| Gato (399) | 11.0% | 35.5% | 37.2% | +24.5pp | +26.2pp |
| Telluride (2,784) | 17.7% | 35.0% | 34.5% | +17.3pp | +16.8pp |
| **6-profile mean** | **13.6%** | **25.4%** | **27.5%** | **+11.8pp** | **+13.9pp** |

At 1yr, regular Thompson leads by +3pp in the mean (driven by Gato and Telluride). At 3yr, Neutral leads by +2pp (driven by hodlbod +26.6pp vs +14.9pp). Both variants regress fiatjaf by ~20pp at 1yr and ~9pp at 3yr — confirming the regression is caused by Thompson's learned relay scores, not cold-start noise.

**Root cause:** Thompson scores are per-relay aggregates across all followed authors. When relay.damus.io delivers only 20-30% of 1yr-old events (a retention issue, not quality), Thompson down-weights it. But for fiatjaf's small concentrated graph, relay.damus.io IS the coverage — no alternative relay covers those pubkeys. Thompson conflates relay retention with relay quality, and for small concentrated graphs there are no alternative relays to recover coverage. See Section 8.16 for discussion and Section 8.9 for the Coverage Guarantee mitigation.

**This regression is NDK-specific.** Other Thompson variants do not regress fiatjaf:

| Algorithm | fiatjaf baseline | fiatjaf +Thompson | Delta |
|---|:---:|:---:|:---:|
| **NDK** | 31.2% | 13.6% | **-17.6pp** |
| **Welshman** | 39.2% | 40.7% | +1.5pp |
| **FD** | 19.3% | 40.7% | +21.4pp |
| **Greedy** | 27.4% | 28.8% | +1.4pp |
| **Ditto→Outbox** | 7.7% | 14.1% | +6.4pp |

*Session means, 1yr, 5 sessions each. NDK's priority cascade fortuitously concentrates on relay.damus.io for fiatjaf's small graph. Thompson disrupts that specific concentration. FD's per-author decomposition keeps relay.damus.io selected for the pubkeys that need it. Welshman's stochasticity means Thompson's perturbation is additive noise. Greedy optimizes globally and doesn't depend on a single relay.*

### 8.9 NDK+Thompson Coverage Guarantee (CG)

**Question:** Can we fix the fiatjaf regression without giving up Thompson's gains on other profiles?

**Approach:** Two complementary mechanisms (`ndk-thompson-cg`):
1. **Coverage Guarantee** — pre-pass before relay selection: force-include relays that are the sole source for any pubkey. Prevents the death spiral where a low-scored relay never gets selected, so sole-source pubkeys get zero coverage.
2. **Sole-Source Exclusion (SE)** — scoring change: skip alpha/beta updates for pubkeys where the relay is the only option. Scores reflect contested-pubkey performance only, so relays aren't penalized for retention limits on pubkeys with no alternative.

**1yr EN (6 profiles × 5 sessions, NIP-66 liveness, cap@20):**

| Profile (follows) | NDK | NDK+Thompson | NDK+Thompson CG | CG vs NDK | CG vs NDK+T |
|---|:---:|:---:|:---:|:---:|:---:|
| fiatjaf (194) | 31.2% | 13.6% | 40.4% | **+9.2pp** | **+26.8pp** |
| hodlbod (442) | 14.9% | 32.4% | 30.3% | +15.4pp | -2.1pp |
| jb55 (943) | 20.4% | 34.8% | 31.5% | +11.1pp | -3.3pp |
| ODELL (1,779) | 16.7% | 32.2% | 23.3% | +6.6pp | -8.9pp |
| Gato (399) | 15.4% | 27.5% | 20.6% | +5.2pp | -6.9pp |
| Telluride (2,784) | 23.1% | 31.6% | 26.4% | +3.3pp | -5.2pp |
| **6-profile mean** | **20.3%** | **28.7%** | **28.8%** | **+8.5pp** | **+0.1pp** |

*62 runs (6 EN × 2 windows × 5 sessions), 55 with data. Gato 1yr S4 returned network failure. Telluride S4-S5 returned 0 follows.*

**CG is always positive vs raw NDK** (+3 to +15pp). But it gives back Thompson gains on larger graphs — the net across 6 profiles is a wash (28.8% vs 28.7%). The fiatjaf regression swings from -17.6pp to +9.2pp, a 27pp improvement.

**The cause: budget saturation.** CG force-includes every sole-source relay without a budget cap. The number of sole-source relays scales with follow count:

| Profile (follows) | Forced relays | Budget remaining | CG trajectory |
|---|:---:|:---:|---|
| fiatjaf (194) | 9 | 11 of 20 | Stable 39-42% across S1-S5 |
| Gato (399) | ~10 | ~10 of 20 | Volatile 18-24% |
| hodlbod (442) | ~12 | ~8 of 20 | Learning: 17% → 36% |
| jb55 (943) | ~14 | ~6 of 20 | Learning: 22% → 36% |
| ODELL (1,779) | 18→20 | 2→0 of 20 | Rises S1-S2 (32%), collapses S4-S5 (18%) |
| Telluride (2,784) | 29 | **exceeds budget** | Declining: 29% → 23% |

For ODELL, the entire 20-relay budget is consumed by forced sole-source relays at S4-S5 (NIP-66 monitor data expansion surfaces more sole-source relays between sessions). Thompson's scoring loop has zero remaining slots to pick high-performing relays. For Telluride, 29 forced relays exceed the 20-relay budget entirely.

**Quality displacement:** Forced relays are selected for coverage (sole-source), not delivery quality. They displace high-performing relays that regular Thompson discovers:
- Displaced: nostr-pub.wellorder.net (59% delivery), theforest.nostr1.com (75% delivery)
- Forced instead: relay.coinos.io (0-15% delivery), sendit.nosflare.com (0% delivery)

**A secondary factor: score signal degradation.** Sole-Source Exclusion removes observations from the scoring loop. CG's Thompson scores are based on fewer relays (24 observed vs 41 for regular Thompson) with lower signal quality. This explains why Gato (~10 forced, 10 remaining) still regresses -6.9pp — the SE scoring is noisier even when budget isn't saturated.

**Known limitation and future work:** The current CG implementation needs a budget cap — force at most `floor(maxConnections × 0.5)` sole-source relays, prioritized by coverage value (how many pubkeys each sole-source relay uniquely covers). This preserves the fiatjaf fix while leaving budget room for Thompson on large graphs. The SE scoring may also need tuning — consider making sole-source exclusion conditional on having sufficient contested observations.

### 8.10 NDK+Thompson CG3: Conditional CG + Partial-Weight SE

**Question:** Can we fix both the budget saturation problem (large graphs) and the SE scoring degradation (Gato) simultaneously?

**Approach:** Two complementary mechanisms combined in `ndk-thompson-cg3`:

1. **Conditional CG (Q1)** — skip CG entirely when sole-source count ≥ `floor(maxConnections × 0.5)` = 10. When skipped, CG3 degrades cleanly to plain Thompson. When enabled (sole-source < 10), all sole-source relays are force-included as in CG.

2. **Partial-Weight Sole-Source scoring (Q2)** — replace full exclusion (0× weight) with 0.3× weight for sole-source observations. The learning signal is dampened but not eliminated, preventing the compounding score degradation observed in CG's SE scoring across sessions.

**1yr EN (6 profiles × 5 sessions, NIP-66 liveness, cap@20):**

| Profile (follows) | NDK+Thompson | CG | CG3 | CG3 vs T | CG3 vs CG | CG behavior |
|---|:---:|:---:|:---:|:---:|:---:|---|
| fiatjaf (194) | 13.1% | 38.8% | 38.7% | **+25.6pp** | -0.1pp | ENABLED (8 ss < 10 cap) |
| hodlbod (855) | 18.1% | 16.8% | 18.5% | +0.4pp | +1.7pp | SKIPPED (13 ss ≥ 10) |
| jb55 (1,218) | 28.8% | 28.4% | 29.4% | +0.6pp | +1.0pp | SKIPPED (13 ss ≥ 10) |
| ODELL (1,562) | 25.4% | 18.9% | 25.6% | +0.2pp | **+6.7pp** | SKIPPED (18 ss ≥ 10) |
| Gato (399) | 19.4% | 26.5% | 21.8% | +2.4pp | -4.7pp | ENABLED (8 ss < 10) |
| Telluride (2,784) | 27.2% | 28.0% | 27.5% | +0.3pp | -0.5pp | SKIPPED (30 ss ≥ 10) |
| **6-profile mean** | **22.0%** | **26.2%** | **26.9%** | **+4.9pp** | **+0.7pp** | |

*30 runs (6 EN × 5 sessions), all with data. Algorithms ran together in each invocation: ndk-thompson, ndk-thompson-cg, ndk-thompson-cg3.*

**Per-session trajectories:**

| Profile | S1 | S2 | S3 | S4 | S5 |
|---|:---:|:---:|:---:|:---:|:---:|
| fiatjaf T / CG / CG3 | 12.2 / 33.7 / 33.7 | 10.6 / 39.5 / 38.8 | 12.0 / 39.7 / 39.7 | 15.3 / 39.6 / 39.8 | 15.5 / 41.8 / 41.8 |
| hodlbod T / CG / CG3 | 15.8 / 16.8 / 15.8 | 18.8 / 18.3 / 19.0 | 16.1 / 16.2 / 16.4 | 15.6 / 16.3 / 17.0 | 24.5 / 16.6 / 24.5 |
| jb55 T / CG / CG3 | 27.6 / 22.9 / 27.6 | 21.5 / 20.1 / 22.5 | 37.6 / 39.7 / 39.3 | 28.5 / 29.5 / 29.3 | 28.9 / 30.1 / 28.6 |
| ODELL T / CG / CG3 | 27.2 / 21.1 / 27.2 | 19.4 / 17.6 / 19.3 | 29.4 / 19.1 / 30.0 | 26.1 / 18.4 / 26.3 | 25.1 / 18.7 / 25.4 |
| Gato T / CG / CG3 | 19.3 / 19.8 / 19.8 | 19.7 / 23.9 / 23.9 | 21.9 / 26.9 / 21.9 | 13.5 / 40.1 / 19.5 | 22.6 / 22.0 / 24.3 |
| Telluride T / CG / CG3 | 30.0 / 28.6 / 30.0 | 17.5 / 29.4 / 17.9 | 31.1 / 25.3 / 31.7 | 28.9 / 28.0 / 29.2 | 28.8 / 28.9 / 29.1 |

**Key findings:**

1. **CG3 is Pareto-superior on grand mean.** 26.9% beats both T (22.0%, +4.9pp) and CG (26.2%, +0.7pp). No profile is worse than T by more than noise. The best of both worlds.

2. **Conditional CG skip works as designed.** The 4 large-graph profiles (hodlbod 13ss, jb55 13ss, ODELL 18ss, Telluride 30ss) correctly skip CG, reverting to plain Thompson behavior. The 2 small-graph profiles (fiatjaf 8ss, Gato 8ss) correctly enable CG. The 50% budget threshold cleanly separates the two regimes.

3. **fiatjaf fix preserved.** CG3 at 38.7% matches CG (38.8%), both +25.6pp vs T (13.1%). The per-session trajectories are nearly identical — S1 cold start parity (33.7%), stable improvement to S5 (41.8%).

4. **ODELL regression eliminated.** CG regressed to 18.9% (-6.5pp vs T's 25.4%). CG3 at 25.6% matches T. The per-session data confirms: CG3 tracks T exactly when CG is skipped (S1: 27.2/27.2, S3: 29.4/30.0, S5: 25.1/25.4).

5. **hodlbod regression eliminated.** CG was 16.8% (below T's 18.1%, -1.3pp regression). CG3 at 18.5% slightly exceeds T. The S5 session is telling: T and CG3 both hit 24.5% while CG stalls at 16.6% — CG's SE scoring degradation compounding across sessions.

6. **Gato is a partial success.** CG3 at 21.8% beats T (19.4%, +2.4pp) but trails CG (26.5%, -4.7pp). Partial-weight scoring helps vs T but doesn't recover CG's full gains. The S4 session reveals the mechanism: CG hit 40.1% while CG3 only got 19.5% — CG's forced relays happened to align with high-value relays that session, but CG3's partial-weight priors led to different (worse) selections in the non-forced slots.

**Mechanism analysis:**

- **When CG is SKIPPED:** CG3 ≈ T (as designed). PW scoring is effectively a no-op because Thompson doesn't select low-scoring sole-source relays, so there are no sole-source observations to weight differently. Small divergence (0-1.7pp) emerges by S3-S5 as PW scoring accumulates slightly different priors than default scoring.

- **When CG is ENABLED + PW scoring (fiatjaf):** Nearly identical to CG. The 8 forced relays are well within budget (10 remaining for Thompson), and fiatjaf's sole-source relays deliver well — PW vs SE scoring makes negligible difference when the underlying signal is strong.

- **When CG is ENABLED + PW scoring (Gato):** PW scoring reduces SE degradation (+2.4pp vs T) but CG3 still trails CG by 4.7pp. The divergence comes from the non-forced relay selections: PW and SE scoring learn different priors across sessions, and for Gato's relay topology, SE's more aggressive exclusion (0×) happens to produce better non-forced relay picks than PW's dampened signal (0.3×).

**The Gato puzzle — contingency assessment:**

CG3's Gato result (+2.4pp vs T, -4.7pp vs CG) suggests the problem is partly **relay-set anchoring** (forcing 8 sole-source relays locks the algorithm into a suboptimal set regardless of scoring quality) and partly **scoring signal quality** (PW and SE produce different priors that lead to different non-forced selections). Three contingency paths:

- **Path A:** Narrow CG to only very small sole-source counts (< 5). This limits CG to fiatjaf-type profiles only.
- **Path B:** Accept CG3 as the best available tradeoff. The +2.4pp vs T on Gato is still positive, and the overall Pareto improvement makes CG3 the recommended NDK variant.
- **Path C:** Replace forced inclusion with a softer mechanism — boost sole-source relays' Thompson scores instead of forcing them. Avoids anchoring while still biasing toward coverage.

**Path C tested: Score Boost (SB) — result: rejected.** SB replaces CG's hard forcing with a soft 5× score multiplier for sole-source relays, using standard Thompson scoring (not partial-weight or sole-source exclusion). 30-run benchmark (6 EN × 5 sessions, 1yr, NIP-66 liveness, cap@20):

| Profile | T (S5) | CG3 (S5) | SB (S5) | SB vs CG3 |
|---|:---:|:---:|:---:|:---:|
| fiatjaf | 15.2% | 40.6% | 38.8% | −1.8pp |
| hodlbod | 30.5% | 27.2% | 20.3% | −6.9pp |
| jb55 | 26.9% | 27.3% | 27.3% | ±0.0pp |
| ODELL | 26.3% | 26.1% | 19.9% | −6.2pp |
| Gato | 21.9% | 21.9% | 19.7% | −2.2pp |
| Telluride | 30.0% | 29.9% | 28.8% | −1.1pp |
| **Grand mean** | **25.1%** | **28.8%** | **25.8%** | **−3.0pp** |

SB regresses on every profile except jb55 (tie). The root cause: SB lacks CG3's conditional skip. On large graphs (ODELL: 18 SS relays, hodlbod: 12, Telluride: 29), SB's priority re-sorting pushes sole-source pubkeys to the front of the processing queue, consuming most of the 20-relay budget on boosted sole-source relays before high-value multi-relay pubkeys are processed. The 5× boost overcomes Thompson's learned priors — even a relay with E=0.15 scores competitively when boosted. Adding a conditional skip to SB would fix the large-graph regression but leave SB worse than CG3 on the remaining profiles (fiatjaf −1.8pp, Gato −2.2pp). There is no configuration of SB that beats CG3.

**Recommendation:** CG3 (`ndk-thompson-cg3`) is the recommended NDK+Thompson variant. It's Pareto-superior to both plain Thompson, CG, and Score Boost on grand mean, preserves the critical fiatjaf fix, and eliminates all large-graph regressions. The Gato tradeoff (-4.7pp vs CG) is acceptable given that CG3 still beats plain T by +2.4pp on that profile.

### 8.11 FD/NDK+Thompson JP Expansion

**Question:** Do FD+Thompson and NDK+Thompson help JP profiles as much as EN?

**FD+Thompson JP (6 JP profiles × 5 sessions, no NIP-66, cap@20):**

| Profile (follows) | FD baseline | FD+Thompson | FD+T Gain | NDK baseline | NDK+Thompson | NDK+T Gain |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| tanakei (84) | 53.1% | 39.1% | **-14.0pp** | 13.2% | 47.7% | **+34.5pp** |
| yutaro (240) | 20.5% | 16.7% | -3.9pp | 11.1% | 17.9% | +6.8pp |
| shion (1,746) | 26.0% | 25.6% | -0.4pp | 19.9% | 22.5% | +2.6pp |
| rokuyo (898) | 24.9% | 25.2% | +0.3pp | 14.1% | 16.6% | +2.6pp |
| darashi (353) | 16.7% | 11.7% | -5.0pp | 8.1% | 10.2% | +2.2pp |
| kojira (1,017) | 26.7% | 21.2% | -5.5pp | 15.2% | 21.1% | +5.9pp |
| **6-profile mean** | **28.0%** | **23.3%** | **-4.8pp** | **13.6%** | **22.7%** | **+9.1pp** |

**Critical finding: FD+Thompson hurts JP profiles (-4.8pp mean) while NDK+Thompson helps them (+9.1pp mean).** The FD per-author structure selects top-N relays per followed pubkey — in the JP relay ecosystem, where relay configurations are highly fragmented, Thompson's stochastic ranking of per-author relay sets is less effective than NDK's global priority approach. tanakei is the most dramatic: FD+T loses 14pp while NDK+T gains 34.5pp.

At 3yr, the same pattern holds: FD+T mean = -3.5pp, NDK+T mean = +6.4pp across JP profiles.

**Recommendation for JP/non-EN ecosystems:** Use NDK+Thompson or Welshman+Thompson, not FD+Thompson. The per-author relay selection in FD is poorly suited to fragmented relay graphs where delivery history per-relay-per-author is too sparse for Thompson to learn from.

### 8.12 JP NIP-66 Comparison

**JP profiles with NIP-66 liveness filter (6 JP profiles × 5 sessions, cap@20, S5 shown):**

| Profile (follows) | Greedy | Welshman | Welshman+Thompson | WT Gain |
|---|:---:|:---:|:---:|:---:|
| tanakei (84) | 23.0% | 55.4% | 74.7% | +19.3pp |
| yutaro (240) | 13.6% | 17.7% | 18.5% | +0.8pp |
| shion (1,746) | 28.7% | 36.6% | 32.3% | −4.3pp |
| rokuyo (898) | 26.7% | 30.5% | 28.7% | −1.8pp |
| darashi (353) | 15.8% | 20.4% | 24.7% | +4.3pp |
| kojira (1,017) | 23.7% | 31.4% | 30.9% | −0.5pp |
| **6-profile mean** | **21.9%** | **32.0%** | **35.0%** | **+3.0pp** |

JP Welshman+Thompson gains (+3.0pp mean at 1yr) are concentrated in tanakei (+19pp) and darashi (+4pp). Other JP profiles show negligible or negative Thompson gains. At 3yr, tanakei dominates even more (+26pp) while most other profiles regress or stay flat. Thompson's effectiveness in JP is profile-specific, not community-wide. NIP-66 coverage for JP relays is lower (~47% vs ~60% for EN), which reduces the candidate relay pool.

### 8.13 Adaptive Connection Limits

**Question:** At what relay budget does recall plateau for different follow graph sizes?

**Welshman+Thompson at cap@10, cap@15, cap@30 (tanakei=84, Gato=399, Telluride=2,784 follows; 5 sessions each, 1yr, NIP-66 liveness, S5 shown):**

| Profile (follows) | cap@10 | cap@15 | cap@20* | cap@30 | Δ(10→30) |
|---|:---:|:---:|:---:|:---:|:---:|
| tanakei (84) | 60.0% | 66.6% | ~75%* | 67.0% | +7.0pp |
| Gato (399) | 17.5% | 21.2% | ~26%* | 34.8% | +17.3pp |
| Telluride (2,784) | 33.0% | 35.4% | ~39%* | 34.1% | +1.1pp |

\*cap@20 values from separate benchmarks (different sessions/dates) — not directly comparable.

Session-to-session variance is high (S1–S5 Evt Recall ranges: tanakei cap@10 35–69%, cap@15 50–67%, cap@30 44–67%; Gato cap@10 17–26%, cap@15 19–24%, cap@30 24–35%; Telluride cap@10 19–33%, cap@15 32–35%, cap@30 34–40%). With only 5 sessions, per-profile Δ(10→30) is noisy.

**Key findings:**

1. **More connections generally help, but gains are profile-specific and noisy.** Aggregate Δ(10→30) is positive for all profiles, but the magnitude varies dramatically by session. At 5 sessions, individual scaling claims should be treated as tentative.

2. **Small graphs saturate quickly.** tanakei (84 follows) reaches 60% at cap@10 — adding 20 more relays gains only +7pp at S5 (and as little as +1pp at S3–S5 mean). The relay graph is simple enough that 10–15 relays cover most paths.

3. **Medium graphs benefit most reliably from more connections.** Gato (399 follows) shows the most consistent scaling: +17pp at S5, +11pp at S3–S5 mean.

4. **Large graphs show high variance.** Telluride (2,784 follows) ranges from +1pp to +13pp depending on metric. More budget doesn't guarantee proportionally more recall — session-to-session noise dominates.

**Recommendation for adaptive budgets:** Default to cap@20. Profiles with <200 follows can reduce to cap@10–15. Profiles with 300–500 follows benefit from cap@20–30. For >1000 follows, more connections help on average but gains are variable.

### 8.14 Thompson Prior Decay Rate Comparison

**Question:** Does the Thompson prior decay rate affect converged recall, or do all rates converge to the same level given enough sessions?

**Setup:** 60 runs (4 configs × 3 profiles × 5 sessions). FD+Thompson at 1yr, cap@20, NIP-66 liveness, `--no-phase2-cache`. Configs:
- **nodecay** (`--decay-factor 1.0`): pure accumulation, no forgetting
- **default** (no flags): 0.95/session discrete decay (current behavior)
- **decay90** (`--decay-factor 0.90 --decay-unit session`): aggressive session decay
- **hour95** (`--decay-factor 0.95 --decay-unit hour`): time-based decay (Welshman PR #53 rate)

Source: `bench/.cache/decay_comparison_logs/31536000/`

**S5 event recall (3-profile mean):**

| Config | jb55 | ODELL | Telluride | Mean |
|---|:---:|:---:|:---:|:---:|
| nodecay | 43.5% | 43.0% | 41.5% | 42.7% |
| default | 43.0% | 41.4% | 42.4% | 42.3% |
| decay90 | 40.5% | 38.5% | 42.8% | 40.6% |
| hour95 | 43.3% | 46.4% | 43.9% | 44.5% |

S5 spread: 3.9pp (40.6%–44.5%). Grand mean spread (all sessions): 2.2pp (35.3%–37.5%).

**Telluride session-by-session (largest profile, 2,784 follows):**

| Config | S1 | S2 | S3 | S4 | S5 | Mean |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| nodecay | 33.6% | 40.1% | 41.2% | 43.1% | 41.5% | 39.9% |
| default | 33.3% | 36.5% | 40.6% | 43.2% | 42.4% | 39.2% |
| decay90 | 34.6% | 41.0% | 40.4% | 42.5% | 42.8% | 40.3% |
| hour95 | 34.4% | 40.5% | 43.0% | 43.9% | 43.9% | 41.1% |

**Key findings:**

1. **All configs converge by S5.** The 3.9pp S5 spread is within normal session-to-session variance (~3–5pp). No config is statistically distinguishable from another at 5 sessions.

2. **Decay rate doesn't matter for closely-spaced sessions.** With 2–3 minute inter-session gaps (benchmark pacing), time-based and session-based decay produce equivalent results. The hour95 config shows slightly higher ODELL S5 (46.4%) but this is within noise.

3. **decay90 is marginally weaker.** The aggressive 0.90/session rate shows the lowest S5 mean (40.6%), suggesting over-forgetting can slow convergence — but the gap is not statistically significant at N=3.

**Implication:** Default 0.95/session decay is fine. Implementers should not tune decay rate — it has no measurable effect at realistic session frequencies.

### 8.15 Per-Author vs Global Use-Case Comparison

**Question:** Does FD+Thompson (per-author relay selection) outperform Welshman+Thompson (global scoring) for any use case, justifying a hybrid architecture?

**Setup:** 30 runs (6 profiles × 5 sessions). FD+Thompson and Welshman+Thompson run side-by-side in each run. 1yr, cap@20, NIP-66 liveness, `--no-phase2-cache`. Telluride S3–S5 originally lost to 0-follows indexer cache poisoning (AGENTS.md Known Bug #5); re-run with `--cache-ttl 86400000` after the fix.

Source: `bench/.cache/use_case_comparison_logs/31536000/`

**S5 event recall (6 profiles, converged Thompson):**

| Profile (follows) | FD+Thompson | Welshman+Thompson | Δ (W+T − FD+T) | Winner |
|---|:---:|:---:|:---:|:---:|
| fiatjaf (196) | 15.2% | 39.1% | +23.9pp | W+T |
| hodlbod (907) | 46.9% | 47.3% | +0.4pp | W+T |
| jb55 (455) | 43.8% | 45.5% | +1.8pp | W+T |
| ODELL (1,886) | 44.4% | 41.2% | −3.2pp | FD+T |
| Gato (399) | 29.6% | 27.4% | −2.2pp | FD+T |
| Telluride (2,784) | 42.4% | 42.0% | −0.4pp | FD+T |
| **6-profile mean** | **37.0%** | **40.4%** | **+3.4pp** | **W+T** |
| **Excl. fiatjaf (5)** | **41.4%** | **40.7%** | **−0.7pp** | **FD+T** |

Grand mean (30 runs): FD+T 32.9%, W+T 37.8%, gap +4.9pp.

**fiatjaf anomaly:** Thompson actively hurts FD on fiatjaf (FD+T 5-session mean 15.7% vs FD baseline 19.8% = −4.1pp regression). With only 120 testable authors from 196 follows, FD's per-author decomposition gives Thompson too few relay alternatives per author. Thompson's stochastic perturbation of these small per-author sets is destructive rather than exploratory. Welshman's global pool is unaffected because popularity weighting operates across all relays at once. This is the same small-graph Thompson regression documented for NDK in §8.10.

**Profile-view latency (algorithm-independent):**

Profile-view TTFE is 681–872ms median across profiles, independent of which algorithm selected the feed relays. Profile-view queries go to the viewed user's own write relays, bypassing the feed relay selection entirely.

| Profile | TTFE median | TTFE mean | TTFE p95 |
|---|:---:|:---:|:---:|
| fiatjaf | 743ms | 1.0s | 1.8s |
| hodlbod | 681ms | 977ms | 1.8s |
| jb55 | 872ms | 1.1s | 1.7s |
| ODELL | 798ms | 1.1s | 1.7s |
| Gato | 804ms | 1.1s | 1.8s |
| Telluride | 870ms | 946ms | 1.6s |

**Key findings:**

1. **W+T and FD+T are effectively equivalent for medium-to-large profiles.** At S5, the two algorithms split 3-3 across 6 profiles (W+T wins fiatjaf, hodlbod, jb55; FD+T wins ODELL, Gato, Telluride). The per-profile gaps outside fiatjaf are small (0.4–3.2pp). Excluding fiatjaf, FD+T leads by 0.7pp (41.4% vs 40.7%). The 6-profile W+T advantage (+3.4pp) is almost entirely driven by fiatjaf's +23.9pp gap — the same small-graph Thompson regression that affects NDK (§8.10).

2. **Profile-view latency is algorithm-independent.** Both algorithms achieve ~680–870ms median TTFE for profile views. This is expected: profile-view queries use the viewed user's own relay list, not the feed algorithm's relay selection.

3. **Hybrid architecture is not justified, but the reason differs from the original hypothesis.** The original hypothesis assumed FD+T would win on feed recall and W+T on profile views, justifying two implementations. In practice, (a) profile-view latency is algorithm-independent, and (b) excluding fiatjaf's small-graph anomaly (196 follows), FD+T and W+T converge to equivalent feed recall (0.7pp gap across the remaining 5 profiles). A single implementation of either algorithm suffices. For rust-nostr clients already using Filter Decomposition, adding Thompson Sampling to the existing per-author structure achieves the same converged recall as switching to Welshman+Thompson — no architectural change needed.

### 8.16 Latency-Aware Thompson Sampling

Sections 8.3–8.5 model relay quality as Bernoulli (delivered/not). This section tests whether adding a latency discount to the scoring function improves feed responsiveness — specifically, whether TTFE (time-to-first-event) becomes algorithm-dependent when latency is in the scoring function.

**Approach:** Multiply each relay's Thompson score by a hyperbolic latency discount: `score × 1/(1 + latencyMs/1000)`. Latency is an EWMA (α=0.7) of connect+query time, learned from Phase 2 relay outcomes and persisted across sessions. Cold start (no latency data) = discount of 1.0 → identical behavior to the base variant.

| Latency | Discount | Interpretation |
|---------|----------|----------------|
| 200ms | 0.83 | Fast relay, minimal penalty |
| 500ms | 0.67 | Slight preference against |
| 1000ms | 0.50 | Reference point |
| 2000ms | 0.33 | Significant penalty |
| 5000ms | 0.17 | Near-excluded |

**Why hyperbolic, not exponential:** Slow-but-reliable relays still compete. A relay at 2s with high delivery gets `0.33 × sampleBeta(high_α, low_β)` — often still above a fast relay with poor delivery.

**7 sessions on fiatjaf (194 follows), 7d window, NIP-66 liveness filtered, cap@20:**

| Metric | Welshman+Thompson | W+T+Latency | FD+Thompson | FD+T+Latency |
|--------|:-----------------:|:-----------:|:-----------:|:------------:|
| TTFE | 587–722ms | 587–722ms | 587–722ms | 587–779ms |
| p50 query | 1.8–2.0s | 1.5–2.0s | 1.6–1.9s | **1.4–1.5s** |
| p80 query | 2.2–2.3s | 2.0–2.3s | 2.2–2.3s | **2.0–2.1s** |
| Event recall | 88–90% | 83–90% | 88–93% | 79–86% |
| Completeness @2s | 55–84% | 67–88% | 57–80% | **81–90%** |
| EOSE-race +500ms | 23–57% | 33–69% | 41–63% | **49–72%** |

**Key findings:**

1. **TTFE remains algorithm-independent.** All four variants consistently hit the same TTFE (587–722ms per session). The fastest relay in the follow graph is always selected regardless of latency discount. This confirms the Section 8.17 finding: TTFE is determined by the single fastest relay, which every algorithm includes.

2. **Tail latency improves significantly.** FD+Thompson+Latency achieves p50 of 1.4–1.5s (vs 1.6–1.9s base) and p80 of 2.0–2.1s (vs 2.2–2.3s base) by sessions 4–7. The discount steers relay selection away from slow relays that drag down the median and upper percentiles.

3. **Progressive completeness is the clearest win.** FD+Thompson+Latency reaches 81–90% of its eventual recall within 2 seconds, vs 57–80% for the base variant. At EOSE-race +500ms, the latency variant captures 49–72% (vs 41–63% base). Events that matter arrive faster.

4. **The cost is 5–10% event recall for FD, 1–3% for Welshman.** FD+Thompson+Latency trades event recall (79–86% vs 88–93% base) for speed. Welshman+Thompson+Latency has a gentler tradeoff (83–90% vs 88–90% base) because the popularity weight `(1 + log(weight))` anchors selections toward high-coverage relays that also tend to be fast.

5. **For app devs: add `* 1/(1 + latencyMs/1000)` to Thompson scoring.** It's a 1-line change. If you care about how fast the full feed populates (not just first event), it's a clear UX win at modest recall cost. The Welshman variant is the safer bet (minimal recall loss). If recall is paramount, skip latency discount — the base Thompson variants already converge to 88–93%.

**Implementation:** Two new algorithm registry entries (`welshman-thompson-latency`, `fd-thompson-latency`) point to the same functions as their base variants. When `params.relayLatencies` is present, the discount is applied; otherwise `discount = 1.0` (zero behavioral change). Latency EWMA is persisted in the relay score DB alongside existing Beta parameters. See [`welshman-thompson.ts`](bench/src/algorithms/welshman-thompson.ts) and [`fd-thompson.ts`](bench/src/algorithms/fd-thompson.ts).

#### Cross-profile validation (6 profiles × 5 sessions, 7d window, NIP-66 liveness, cap@20)

The single-profile findings above (fiatjaf, 194 follows) were validated across the full 6-profile set. Sessions 2–5 averaged (session 1 is cold start parity):

| Profile (follows) | W+T Recall | W+T+Lat Recall | Δ Recall | W+T @2s | W+T+Lat @2s | Δ @2s | W+T p50 | W+T+Lat p50 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| fiatjaf (194) | 89.8% | 88.8% | −1.0pp | 70.1% | 80.8% | **+10.7pp** | 1.8s | 1.7s |
| Gato (399) | 83.6% | 83.1% | −0.5pp | 76.5% | 76.0% | −0.5pp | 2.1s | 2.0s |
| hodlbod (451) | 90.7% | 85.0% | −5.7pp | 53.7% | 65.0% | **+11.3pp** | 2.3s | 2.2s |
| jb55 (945) | 91.1% | 83.4% | −7.7pp | 26.7% | 43.0% | **+16.3pp** | 2.8s | 2.3s |
| ODELL (1,777) | 86.0% | 75.1% | −10.9pp | 7.3% | 13.7% | **+6.3pp** | 3.4s | 3.2s |
| Telluride (2,795) | 88.4% | 74.7% | −13.8pp | 2.8% | 8.0% | **+5.1pp** | 4.6s | 3.5s |

FD+Thompson shows the same pattern with larger recall cost:

| Profile (follows) | FD+T Recall | FD+T+Lat Recall | Δ Recall | FD+T @2s | FD+T+Lat @2s | Δ @2s |
|---|---:|---:|---:|---:|---:|---:|
| fiatjaf (194) | 89.6% | 83.2% | −6.4pp | 71.9% | 86.5% | **+14.6pp** |
| Gato (399) | 83.6% | 74.5% | −9.1pp | 72.4% | 75.7% | +3.3pp |
| hodlbod (451) | 88.6% | 76.2% | −12.5pp | 53.4% | 65.0% | **+11.6pp** |
| jb55 (945) | 89.7% | 75.2% | −14.4pp | 41.0% | 45.9% | +4.9pp |
| ODELL (1,777) | 83.0% | 68.0% | −15.0pp | 9.6% | 12.4% | +2.8pp |
| Telluride (2,795) | 84.8% | 68.9% | −15.8pp | 3.6% | 7.2% | +3.6pp |

**Cross-profile patterns:**

1. **Recall cost scales with profile size.** Welshman+Thompson+Latency: −1.0pp at 194 follows → −13.8pp at 2,795. FD+Thompson+Latency: −6.4pp → −15.8pp. Larger profiles have more relays competing, so the latency discount displaces more marginal-but-relevant relays.

2. **Completeness @2s wins are largest at medium profile sizes.** The sweet spot is 200–1000 follows: jb55 (945) gains +16.3pp for W+T+Lat. At 2,795 follows (Telluride), the gain shrinks to +5.1pp because even latency-optimized relay sets can't finish querying 574 candidate relays in 2 seconds.

3. **Welshman variant is strictly safer than FD variant.** W+T+Lat recall cost is roughly half of FD+T+Lat at every profile size, while @2s gains are comparable or better. The popularity weight `(1 + log(weight))` anchors relay selection to high-coverage relays, limiting how far latency discount can push selections toward fast-but-low-coverage relays.

4. **p50 improvement is consistent but modest.** Across all profiles, latency variants show 0.1–1.1s lower p50. The improvement is real but not transformative — tail latency (p80) and progressive completeness are where the latency discount has its biggest practical impact.

5. **Recommendation for app devs is profile-size-dependent.** For apps targeting typical users (< 500 follows), `W+T+Latency` is a clear win: +10pp completeness @2s at < 1pp recall cost. For apps targeting power users (1000+ follows), the tradeoff is steeper — consider making the latency discount tunable or applying it only when completeness @2s matters more than total recall.

### 8.17 Latency Simulation

**What this measures:** How fast do events arrive when querying outbox relays? When should a client stop waiting? This uses per-relay timing data (connect latency, query time, EOSE timing) collected during Phase 2 baseline queries to simulate parallel relay queries for each algorithm's relay set. No additional network calls — timing is replayed from baseline collection.

**7 profiles tested** (1-day window, `--verify --no-phase2-cache`):

| Profile (follows) | Relays queried | Connect p50 | Query p50 | Timeouts | Feed TTFE | Profile-view TTFE |
|---|---:|---:|---:|---:|---:|---:|
| fiatjaf (194) | 178 | 651ms | 843ms | 3 | 581ms | 1.0s |
| Gato (399) | 183 | 911ms | 1.3s | 3 | 545ms | 753ms |
| hodlbod (449) | 483 | 659ms | 894ms | 10 | 573ms | 836ms |
| jb55 (945) | 731 | 605ms | 808ms | 15 | 668ms | 920ms |
| ODELL (1,777) | 281 | 700ms | 954ms | 6 | 556ms | 717ms |
| ValderDama (1,082) | 635 | 658ms | 874ms | 14 | 542ms | 912ms |
| Telluride (2,795) | 1,234 | 611ms | 829ms | 35 | 527ms | 791ms |

*Follow counts differ slightly from earlier sections (e.g., ODELL 1,777 vs 1,779) because these latency benchmarks were run at a different time — follow counts change as users follow/unfollow people. The differences are small (<2%) and don't affect timing conclusions.*

Feed TTFE is algorithm-invariant: it depends on the fastest relay in the selected set, and all outbox algorithms include at least one fast relay. TTFE ranges from 527ms (Telluride) to 668ms (jb55). Profile-view TTFE (top 3 write relays per author, algorithm-independent) ranges from 717ms to 1.0s median, with 96-100% hit rates.

**EOSE-race simulation.** The key question for app devs: when you query 20 relays in parallel, the fastest sends EOSE first. How much recall have you captured at that point, and how much more do you get by waiting?

Completeness at first EOSE + grace period (% of eventual recall achieved), for representative algorithms:

**Greedy Set-Cover (20 relays, no learning):**

| Grace | fiatjaf | Gato | hodlbod | jb55 | ODELL | ValderDama | Telluride |
|---:|---:|---:|---:|---:|---:|---:|---:|
| +0ms | 7.7% | 62.1% | 0.0% | 0.1% | 0.1% | 2.9% | 1.3% |
| +500ms | 72.6% | 63.1% | 11.4% | 8.0% | 88.8% | 8.5% | 5.6% |
| +1s | 78.1% | 66.8% | 83.4% | 19.2% | 92.7% | 85.4% | 5.6% |
| +2s | 94.6% | 98.0% | 93.3% | 95.4% | 98.5% | 86.2% | 86.3% |
| +5s | 100% | 100% | 99.4% | 99.9% | 100% | 100% | 89.0% |

**Ditto+Outbox Thompson (hybrid: 4 app relays + outbox):**

| Grace | fiatjaf | Gato | hodlbod | jb55 | ODELL | ValderDama | Telluride |
|---:|---:|---:|---:|---:|---:|---:|---:|
| +0ms | 60.5% | 59.2% | 7.7% | 0.5% | 78.3% | 0.4% | 3.8% |
| +500ms | 65.6% | 60.8% | 23.2% | 22.2% | 92.3% | 16.3% | 11.1% |
| +1s | 70.7% | 65.2% | 82.8% | 42.3% | 93.4% | 86.6% | 15.1% |
| +2s | 86.6% | 96.8% | 94.9% | 94.8% | 98.0% | 90.7% | 86.8% |
| +5s | 100% | 99.7% | 100% | 100% | 100% | 100% | 89.8% |

**Big Relays (2 relays, no outbox) and Ditto-Mew (4 app relays):**

| Grace | Big Relays (all profiles) | Ditto-Mew range |
|---:|---:|---:|
| +0ms | 88.7–100% | 7.9–83.9% |
| +2s | 88.7–100% | 84.8–100% |

Big Relays reaches full completeness at +0ms on most profiles (only 1-2 relays with events, so first EOSE = last EOSE). But absolute recall is 50-77%. Ditto-Mew similarly front-loads events from 4 app relays, reaching 81-95% completeness quickly. The hybrid approach combines both: app relay events arrive instantly, outbox events fill in over 2-5s.

**Key findings:**

1. **+2s grace captures 86-99% of recall for most profiles.** This is the recommended default for feeds. Only Telluride (2,784 follows, 1,234 relays) and ValderDama (1,082 follows) stay below 90% at +2s. For these large profiles, +5s gets to 89-100%.

2. **TTFE is algorithm-independent and profile-size-independent — even with latency-aware scoring.** 527-668ms across all 7 profiles and all algorithms. The fastest relay in any 20-relay set responds in under 700ms. Latency-aware Thompson Sampling (Section 8.16) confirms this: adding a latency discount to relay scoring does not change TTFE, but does improve tail latency (p50, p80) and progressive completeness (@2s recall fraction) by steering selections away from slow relays.

3. **Coverage and latency are directly opposed.** This is the fundamental tradeoff — more relays = more events found, but longer to collect them:

    | Relays queried | Recall ceiling | At first EOSE | At +2s | At +5s |
    |:---:|:---:|:---:|:---:|:---:|
    | 2 (Big Relays) | 50–77% | 100% | 100% | 100% |
    | 4 (Ditto-Mew) | 62–86% | 8–84% | 85–100% | 85–100% |
    | 20 (Outbox) | 81–98% | 0–62% | 86–99% | 89–100% |

    Two relays finish instantly but miss half the events. Twenty relays find nearly everything but take 2-5s to converge. Hybrid outbox side-steps this: show app relay events immediately (2-4 relay speed), stream in outbox events in the background (20-relay coverage).

4. **Dead relays are the main latency risk.** Each timeout burns 15s. Telluride's 35 timeouts across 1,234 relays means: without NIP-66 filtering, some concurrency slots sit idle for 15s while dead relays fail to respond. NIP-66 pre-filtering is as much a latency optimization as a connection budget one.

5. **Profile-view latency is consistent.** 717ms–1.0s median across all profiles, 96-100% hit rate, ~2.9 relays queried per author. This is the per-author outbox lookup cost — predictable and manageable.

**Progressive completeness** (% of eventual recall at wall-clock time, Greedy Set-Cover):

| Time | fiatjaf | Gato | hodlbod | jb55 | ODELL | ValderDama | Telluride |
|---:|---:|---:|---:|---:|---:|---:|---:|
| @1s | 68.4% | 62.1% | 0.0% | 5.7% | 0.1% | 5.2% | 1.3% |
| @2s | 88.3% | 66.8% | 83.4% | 19.2% | 94.7% | 85.7% | 5.6% |
| @5s | 100% | 100% | 99.4% | 99.9% | 100% | 100% | 89.0% |
| @10s | 100% | 100% | 100% | 100% | 100% | 100% | 89.2% |
| @15s | 100% | 100% | 100% | 100% | 100% | 100% | 100% |

Telluride's slow convergence (89% at @5s, 100% only at @15s) is driven by timeout overhead: 35 timed-out relays in a 20-concurrency pool means some batches wait the full 15s EOSE timeout.

*Latency simulation uses per-relay timing from baseline queries. It models parallel WebSocket connections with the same concurrency as the live benchmark (20 concurrent). Timing includes connection establishment (DNS+TCP+TLS+WS upgrade) and query execution through EOSE. See [`bench/src/phase2/verify.ts`](bench/src/phase2/verify.ts) for the simulation code and [`bench/src/phase2/probe.ts`](bench/src/phase2/probe.ts) for the standalone relay latency probe.*

### 8.18 Thompson regression analysis: coverage vs delivery rate

Thompson Sampling scores relays by aggregate delivery rate — for each relay, it tracks what fraction of baseline events the relay delivered across all assigned pubkeys (see `relay-scores.ts`). This works well when delivery rate and coverage are correlated (large diverse follow graphs), but fails when they diverge.

**The misalignment:** At 1yr, relay.damus.io might deliver only 20-30% of baseline events (a retention policy issue — events older than 6-12 months get pruned). Thompson learns low α/β → low Beta samples → low score. But for fiatjaf's 194 follows, relay.damus.io covers ~50 of them — no other relay comes close. Thompson demotes the most irreplaceable relay and substitutes smaller relays with higher delivery rates but far less coverage.

**Why it only hurts small concentrated graphs:** For hodlbod (2,784 follows), demoting one relay merely shifts queries to other relays covering the same pubkeys. For fiatjaf (194 follows on a few popular relays), demoting relay.damus.io leaves pubkeys with no alternative coverage.

**Neutral cold start does not help** because the problem is not cold-start randomness — it's that Thompson's learning objective (delivery rate) diverges from the algorithm's need (pubkey coverage) for this profile shape.

**Tested mitigation — Coverage Guarantee CG3 (Section 8.10):** The recommended fix combines conditional CG (skip when sole-source ≥ 50% of budget) with partial-weight scoring (0.3× for sole-source observations). CG3 is Pareto-superior: 26.9% grand mean beats both T (22.0%) and CG (26.2%). Preserves the fiatjaf fix (+25.6pp), eliminates ODELL/hodlbod regressions, and gains +2.4pp vs T on Gato. This regression is NDK-specific — Welshman+Thompson, FD+Thompson, and Greedy+Thompson do not regress fiatjaf (see the cross-algorithm comparison in Section 8.8).

**Untested mitigations:** (1) Coverage-weighted scoring — weight Thompson updates by how irreplaceable a relay is for the profile, so high-coverage relays resist demotion. (2) Per-author scoring — track (relay, pubkey-cluster) pairs instead of global relay scores, so fiatjaf's relays aren't penalized by delivery rates from unrelated authors.

---

## 9. Observations

Based on patterns observed across all implementations and benchmark results:

1. **Algorithm choice depends on use case.** Among practitioner algorithms, Greedy/NDK/Welshman cluster at 83-84% at 7d (effectively tied). At 1yr, Filter Decomposition (25%) and Welshman Stochastic (24%) lead — both 1.5× better than Greedy's 16%. Coverage-optimal is not event-recall-optimal. Academic algorithms define a ~92% ceiling at 7d, but that gap is closable through learning (Thompson Sampling) rather than algorithmic complexity.

2. **Most clients default to 2-3 relays per pubkey.** 7 of 9 implementations with per-pubkey limits converge on 2 or 3 (see Section 2.3). This is an observed ecosystem consensus, not an empirically benchmarked finding — no study has measured the optimal number or the marginal value of a 3rd vs 4th relay per author.

3. **Track relay health — and consider NIP-66 pre-filtering.** At minimum, implement binary online/offline tracking with backoff. Ideally, use tiered error thresholds (Welshman) or penalty timers (Gossip) to avoid repeatedly connecting to flaky relays. [NIP-66](https://github.com/nostr-protocol/nips/blob/master/66.md) (kind 30166) and [nostr.watch](https://github.com/sandwichfarm/nostr-watch) publish network-wide relay liveness and performance data (RTT, uptime, supported NIPs) that clients could consume instead of independently probing relays — no analyzed client uses this yet. Our benchmarks show NIP-66 liveness filtering removes 40–66% of dead relays from the candidate set and improves relay success rates substantially (about 1.5× to 3.1×, from ~30% to ~75–85%), with the biggest impact on profiles with large follow counts.

4. **Configure multiple indexer relays.** Relying on a single indexer (e.g., only purplepag.es) is a single point of failure. Amethyst's 5-indexer approach is the most resilient.

5. **Handle misconfigured kind 10002.** NIP-65 relay list pollution is a widespread problem: users put purplepages, NWC relays, blastrs, proxies, and read-only feed relays into their outbox relay list because clients only expose a single relay configuration. As [vitorpamplona notes](https://github.com/nostr-protocol/nips/pull/2243#issuecomment-2695456282): "NIP-65 lists are for everybody else to find your content or to send content to you (tagging). They are not the place to put any other relay that you are using in any client." At minimum, filter out known-bad relay entries. Blocklists for aggregator relays (feeds.nostr.band, filter.nostr.wine), special-purpose relays (purplepag.es, NWC endpoints), and blast/proxy relays prevent wasted connections on relays that have no user content.

6. **Make outbox debuggable — but go beyond assignment coverage.** noStrudel's coverage debugger is the only client that exposes outbox internals (coverage %, orphaned users, per-relay assignment, color-coded health). But it only shows the academic view — the on-paper relay mapping. NIP-66 monitors check relay liveness, but no client verifies per-author delivery — "did this relay return events for author X?" Our central finding is that these two views diverge sharply (85% assignment coverage can mean 16% event recall at 1yr). True completeness isn't measurable (no relay has everything — if indexers were complete, you'd skip outbox entirely), but cross-checking catches systematic gaps: a relay that's supposed to serve an author but consistently returns nothing. Opportunities for future work: per-author delivery cross-checks against independent relays, relay response/efficiency rates (events delivered per connection), orphan root-cause analysis (missing kind 10002 vs relays offline vs filtered out), and relay list staleness indicators.

7. **Stochastic exploration is the best archival strategy — and learning makes it even better.** Welshman's `random()` factor isn't just anti-centralization — it discovers relays that retain old events and that static optimizers miss. MAB-UCB's exploration-exploitation achieves the same effect. Welshman+Thompson Sampling adds memory to this randomness: after 2–3 sessions, it learns which relays actually deliver and outperforms baseline Welshman by up to 12pp (90% vs 78% at 3yr on Telluride). Pure greedy concentrates on mega-relays that may prune history.

8. **Support NIP-17 DM relays.** Only 4 of 10 mature implementations fully route DMs via kind 10050 relays. Kind 10050 is straightforward to implement and provides meaningful privacy benefits for direct messaging.

9. **EOSE-race with 2s grace is the practical feed timeout.** Across 7 profiles, waiting 2s after the first relay finishes captures 86-99% of eventual recall — enough for feeds, where showing *most* events quickly beats showing *all* events slowly. The tradeoff is fundamental: 2 relays give instant completeness (100% at +0ms) but low absolute recall (50-77%). 20 outbox relays give high recall (81-98%) but need 2-5s to converge. Hybrid outbox bridges this — app relay events arrive instantly, outbox events stream in. For completeness-critical paths (archival, search), 5s gets to ~100% on all but the largest profiles (2,700+ follows need 15s due to timeout overhead).

10. **Aggregator results are surprisingly poor.** Primal reaches 32% recall at 7d (6-profile mean) and <1% at 3yr — worse than Popular+Random (damus + nos.lol + 2 random relays) at every window. This is unexpected: an aggregator that proxies tens if not hundreds of relays should in theory outperform 4 random connections. This may indicate a limitation in the benchmark methodology rather than a real-world indictment of aggregators.

11. **Latency-aware scoring is worth it for small-to-medium profiles.** Adding `score × 1/(1 + latencyMs/1000)` to Thompson Sampling improves progressive completeness @2s by +5 to +16pp across 6 profiles, with the sweet spot at 200–1000 follows (Section 8.16). Recall cost scales with profile size: −1pp at 194 follows, −14pp at 2,795 follows. Welshman+Thompson+Latency is the safer variant (half the recall cost of FD+Thompson+Latency). For apps targeting typical users (<500 follows), this is a clear win — a 1-line scoring change. For power users (1000+ follows), consider making the discount tunable.

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

All algorithms are in [`bench/src/algorithms/`](bench/src/algorithms/).

**Practitioner algorithms** (deployed or deployable):

| Algorithm | Source | Inspired By |
|-----------|--------|-------------|
| Greedy Set-Cover | [`greedy-set-cover.ts`](bench/src/algorithms/greedy-set-cover.ts) | Gossip, Applesauce, Wisp |
| Priority-Based | [`priority-based.ts`](bench/src/algorithms/priority-based.ts) | NDK |
| Weighted Stochastic | [`weighted-stochastic.ts`](bench/src/algorithms/weighted-stochastic.ts) | Welshman/Coracle |
| Greedy Coverage Sort | [`greedy-coverage-sort.ts`](bench/src/algorithms/greedy-coverage-sort.ts) | Nostur |
| Filter Decomposition | [`filter-decomposition.ts`](bench/src/algorithms/filter-decomposition.ts) | rust-nostr |
| Direct Mapping | [`direct-mapping.ts`](bench/src/algorithms/direct-mapping.ts) | Amethyst (feeds) |
| Welshman+Thompson | [`welshman-thompson.ts`](bench/src/algorithms/welshman-thompson.ts) | Welshman + Thompson Sampling |
| FD+Thompson | [`fd-thompson.ts`](bench/src/algorithms/fd-thompson.ts) | Filter Decomposition + Thompson Sampling |
| Welshman+Thompson+Latency | [`welshman-thompson.ts`](bench/src/algorithms/welshman-thompson.ts) | Welshman+Thompson + latency discount |
| FD+Thompson+Latency | [`fd-thompson.ts`](bench/src/algorithms/fd-thompson.ts) | FD+Thompson + latency discount |
| Greedy+ε-Explore | [`greedy-epsilon.ts`](bench/src/algorithms/greedy-epsilon.ts) | Greedy + ε-exploration |
| Primal Aggregator | [`primal-baseline.ts`](bench/src/algorithms/primal-baseline.ts) | Baseline |
| Popular+Random | [`popular-plus-random.ts`](bench/src/algorithms/popular-plus-random.ts) | Baseline |
| Big Relays | [`big-relays.ts`](bench/src/algorithms/big-relays.ts) | Baseline (damus + nos.lol) |
| Hybrid+Thompson | [`ditto-outbox.ts`](bench/src/algorithms/ditto-outbox.ts) | App relays + per-author outbox (Ditto-Mew) |
| Ditto-Mew (4 app relays) | [`ditto-mew.ts`](bench/src/algorithms/ditto-mew.ts) | Baseline (4 hardcoded app relays) |

**Academic algorithms** (benchmark ceilings only — not practical for real clients):

| Algorithm | Source | CS Technique | Why not practical |
|-----------|--------|--------------|-------------------|
| ILP Optimal | [`ilp-optimal.ts`](bench/src/algorithms/ilp-optimal.ts) | Branch-and-bound | NP-hard, requires solver library |
| MAB-UCB | [`mab-relay.ts`](bench/src/algorithms/mab-relay.ts) | Combinatorial bandits | 500 simulated rounds per selection |
| Streaming Coverage | [`streaming-coverage.ts`](bench/src/algorithms/streaming-coverage.ts) | Streaming submodular max | Marginal gains over simpler greedy |
| Bipartite Matching | [`bipartite-matching.ts`](bench/src/algorithms/bipartite-matching.ts) | Weighted matching | O(V²E), complex implementation |
| Spectral Clustering | [`spectral-clustering.ts`](bench/src/algorithms/spectral-clustering.ts) | Community detection | Eigendecomposition, linear algebra dependency |
| Stochastic Greedy | [`stochastic-greedy.ts`](bench/src/algorithms/stochastic-greedy.ts) | Lazier-than-lazy greedy | Worse than standard greedy at this scale |

Phase 2 verification: [`bench/src/phase2/`](bench/src/phase2/) (baseline construction, event verification, reporting, disk cache).

NIP-66 relay filtering: [`bench/src/nip66/`](bench/src/nip66/) (monitor data fetching, relay classification).

Relay score persistence: [`bench/src/relay-scores.ts`](bench/src/relay-scores.ts) (Thompson Sampling Beta distribution persistence).

### Protocol Resources

- [Building Nostr](https://building-nostr.coracle.social) — Staab's guide to Nostr protocol architecture. Defines relay selection as a family of heuristics (outbox, inbox, group, DM, topic, community) using a database-index analogy. Identifies content migration after relay changes as a critical unsolved problem. No algorithmic guidance for relay scoring — the benchmark fills that gap.
- [replicatr](https://github.com/coracle-social/replicatr) — Proof-of-concept daemon that monitors kind 10002 changes and replicates events to new relays via negentropy sync. Addresses the relay migration problem but not relay retention (the dominant recall loss factor in our benchmarks).
- [NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md) — Relay List Metadata specification
- [NIP-66](https://github.com/nostr-protocol/nips/blob/master/66.md) — Relay Discovery and Liveness Monitoring
- [NIP-77](https://github.com/nostr-protocol/nips/blob/master/77.md) — Negentropy Syncing (set reconciliation, used by replicatr and rust-nostr)
