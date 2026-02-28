> **DRAFT** — This document is a work in progress. Findings and framing may change.

> **For the practitioner summary, see [README.md](README.md).** This document contains the full methodology, cross-client analysis, and complete benchmark data.

# Outbox Model Implementation Report

**An analysis of NIP-65 outbox/inbox relay routing across 15 Nostr clients and libraries**

*Produced for [nostrability#69](https://github.com/niclas-pfeifer/nostrability/issues/69)*

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

**Only 37% of relay-user pairs point to normal content relays.** The remaining 63% are offline (34%), missing NIP-11 (17%), paid (7%), restricted writes (4%), or auth-gated (0.5%). Nearly half (48.6%) of all unique relay URLs encountered were offline at probe time.

The most common offline relays appear in 32-34 of 36 profiles — widely listed but long dead: `relay.nostr.band`, `relay.nostr.bg`, `nostr.orangepill.dev`, `nostr.zbd.gg`, `relay.current.fyi`, `relayable.org`. These waste connection budget on every feed load.

Paid relays like `nostr.wine`, `nostr.land`, `atlas.nostr.land` appear in 34/36 profiles. While some paid relays serve content to readers without payment, others require authentication or payment for any access. The `filter.nostr.wine/*` pattern alone accounts for 104 unique URLs (per-user broadcast proxies).

Restricted-write relays like `pyramid.fiatjaf.com` (34/36 users), `nostr.einundzwanzig.space` (32/36), and `nostr.thank.eu` (28/36) are community or personal relays that won't serve general content queries.

*Classification: `content` = no restriction flags; `paid` = `limitation.payment_required: true`; `auth-gated` = `limitation.auth_required: true`; `restricted` = `limitation.restricted_writes: true` without paid/auth; `no-nip11` = no NIP-11 response; `offline` = connection failed. Probed with 5s HTTP timeout, `Accept: application/nostr+json`. Data: [`bench/.cache/nip11_probe_*.json`](bench/.cache/).*

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
- 14 algorithms tested across 6 time windows (7d to 3 years)

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

The ~8pp gap between the best academic algorithm (92.4%) and the best practitioner algorithm (87.9%) represents the theoretical ceiling that no simple, deployable algorithm has reached. However, Welshman+Thompson Sampling (Section 8.3) closes most of this gap through learning — achieving 92-97% after 2-3 sessions without the implementation complexity of the academic algorithms.

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
- **~8pp gap to academic ceiling** (92% vs 88% mean). Closable through learning: Welshman+Thompson Sampling (Section 8.3) reaches 92-97% after 2-3 sessions.
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
| jb55 | 655 | 27.0, 26.8, 30.5, 36.5, 27.8 | 29.7% ± 4.1pp | 22.1, 23.0, 23.7, 23.4, 22.6 | 23.0% ± 0.6pp |
| ODELL | 1,779 | 21.0, 18.5, 17.6, 19.4, 17.0 | 18.7% ± 1.6pp | 20.2, 18.9, 18.9, 19.2, 18.3 | 19.1% ± 0.7pp |

Key observations:
- **Variance decreases with follow count.** fiatjaf (194 follows) has ±8pp Welshman std; ODELL (1,779 follows) has ±1.6pp. Larger follow lists average out per-relay randomness.
- **fiatjaf seed 0 (37.8%) was a genuine outlier** — 1.6 standard deviations above the mean. The cross-profile table's single-seed values should be interpreted with this variance in mind.
- **Popular+Random is remarkably stable** for larger profiles (±0.6–0.7pp for jb55/ODELL). Its randomness is limited to 2 relay slots, so most of the signal comes from the fixed Popular relays.
- **At large follow counts, Welshman ≈ Popular+Random.** ODELL shows 18.7% vs 19.1% — within noise. The stochastic advantage is strongest for smaller, more concentrated follow lists.
- **Baseline variability matters.** The number of testable-reliable authors varies 5-10% between runs of the same profile (e.g., jb55: 368–390), reflecting relay availability differences. This contributes to variance beyond PRNG.

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

NIP-66 filtering benefits stochastic algorithms (MAB-UCB, Welshman) most because they sample from the full relay pool — removing dead relays from that pool directly improves sample quality. Thompson Sampling and Greedy show negligible or slightly negative deltas — likely noise from stochastic selection variance and intermittently available relays (online during our query window but offline when the monitor checked) rather than a systematic effect.

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

4. **MAB-UCB remains the best single-session algorithm — but isn't shippable.** Without learning history, MAB-UCB's internal exploration-exploitation (500 simulated rounds) outperforms everything. It defines the benchmark ceiling. Thompson Sampling needs 2–3 sessions to match it but is actually deployable.

5. **The 20-connection limit is the fundamental bottleneck at scale.** Telluride (2,784 follows) at 3yr shows all algorithms struggling: Greedy at 56%, Thompson at 63%, MAB-UCB at 67%. The relay diversity needed to cover 2,784 authors' 3-year history exceeds what 20 connections can provide.

**Key real-world event verification findings:**

*Practitioner takeaways:*
1. **Coverage-optimal ≠ event-recall-optimal.** Greedy Set-Cover wins Phase 1 (assignment coverage) but at 1yr drops to 16% event recall (6-profile mean) while Filter Decomposition (25%) and Welshman Stochastic (24%) retain more history through relay diversity.

2. **Welshman's `random()` factor helps for archival.** The stochastic factor in ``quality * (1 + log(weight)) * random()`` spreads queries across more relays over time. At 1 year: 24% mean recall across 6 profiles (1.5× Greedy's 16%). Filter Decomposition (25%) edges it out through per-author relay diversity. Welshman's fiatjaf-specific result (37.8%) was an outlier — cross-profile means are more representative. Variance analysis (5 seeds × 3 profiles) shows ±2–8pp run-to-run std, with variance decreasing as follow count increases.

3. **Greedy Set-Cover degrades sharply.** 84% at 7d → 16% at 1 year (6-profile means). It minimizes connections by concentrating on popular relays, but those relays don't necessarily retain old events. Algorithms that spread queries fare better long-term.

4. **Aggregator results are surprisingly poor.** Primal achieves only 31.6% recall at 7 days (6-profile mean) and 0.9% at 3 years (fiatjaf single-profile) — worse than Popular+Random (damus + nos.lol + 2 random relays) at every window. This is unexpected for a relay that proxies many upstream relays, and may indicate a benchmark methodology limitation rather than a definitive conclusion about aggregators.

5. **Author recall is more stable than event recall.** You can *find* most authors even at long windows (74-81% author recall at 1 year), but you miss most of their posts. The disparity means relay retention policies are the binding constraint, not relay selection.

*Academic context:*
6. **The academic ceiling is ~92% at 7d** (Streaming Coverage, ILP, Spectral Clustering). The ~5-8pp gap vs the best practitioner algorithm (88%) is closable through learning (Thompson Sampling reaches 92-97% after 2-3 sessions) rather than through more complex static algorithms.

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

**5-session learning comparison (1yr event recall, cap@20, NIP-66 filtered, per-algorithm score DBs):**

| Profile (follows) | FD+Thompson | Welshman+Thompson | Gap |
|---|:---:|:---:|:---:|
| fiatjaf (194) | 75.1% | 82.0% | -6.9pp |
| Gato (399) | 91.9% | 95.5% | -3.6pp |
| ODELL (1,779) | 85.3% | 90.5% | -5.2pp |
| Telluride (2,784) | 83.4% | 89.5% | -6.1pp |
| **4-profile mean** | **83.9%** [75–92] | **89.4%** [82–96] | **-5.5pp** |

**FD+Thompson session progression (1yr event recall):**

| Profile (follows) | S1 | S2 | S3 | S4 | S5 |
|---|:---:|:---:|:---:|:---:|:---:|
| fiatjaf (194) | 16.5% | 63.8% | 75.1% | 75.1% | 75.1% |
| Gato (399) | 37.9% | 84.4% | 88.9% | 92.3% | 91.9% |
| ODELL (1,779) | 17.5% | 59.1% | 77.5% | 80.3% | 85.3% |
| Telluride (2,784) | 17.1% | 54.4% | 78.2% | 81.5% | 83.4% |

**Key findings:**

1. **Both Thompson variants far exceed their stateless baselines.** FD+Thompson averages 31.8% event recall from a single session vs Filter Decomposition's 23.1% at 1yr — a +38% relative improvement. After 5 learning sessions, FD+Thompson reaches 83.9% (a 2.6× improvement over session 1). Welshman+Thompson reaches 89.4%. Most gains arrive in sessions 2-3; sessions 4-5 provide diminishing returns.

2. **Welshman+Thompson leads by 5-7pp at all profile sizes after convergence.** The `(1 + log(weight))` popularity factor provides a consistent advantage — the popularity signal helps identify relays that retain events across all follow-count scales, not just large graphs. The gap is narrowest on Gato (3.6pp) and widest on fiatjaf (6.9pp).

3. **Median recall tells a different story.** FD+Thompson's 39.4% median on fiatjaf (vs 18.7% for Welshman+Thompson) shows more equitable per-author coverage — fewer authors with zero recall. At larger scales, Welshman+Thompson's median advantage (64% vs 55% on ODELL) reflects better overall delivery.

4. **Both hit the same ceiling.** The relay-discovery problem ([issue #21](https://github.com/nostrability/outbox/issues/21)) limits all algorithms equally — current NIP-65 lists don't reflect where authors wrote a year ago. Staab's [Building Nostr](https://building-nostr.coracle.social) identifies this as the content migration problem: "the onus is on users (and by extension their clients) to choose good outbox relays and publish their events to them… it is the responsibility of anyone that changes the result of relay selection heuristics to synchronize events to the new relay." His [replicatr](https://github.com/coracle-social/replicatr) tool automates this via negentropy-based sync, but notes "synchronization is currently absent from most (or all) implementations."

---

### 8.5 Hybrid Outbox: App Relay Broadcast + Per-Author Thompson

Sections 8.3 and 8.4 benchmark full outbox routing — every filter is decomposed by author and routed to their write relays. This section benchmarks a **hybrid approach**: keep a fixed set of app relays for the main feed (broadcast, no per-author routing), and add per-author outbox queries only for long-tail paths (profile views, event lookups, thread traversal).

The algorithm models [Ditto-Mew](https://gitlab.com/soapbox-pub/ditto-mew)'s architecture: 4 hardcoded app relays (relay.ditto.pub, relay.primal.net, relay.damus.io, nos.lol) broadcast all feed queries. For profile/event lookups, the viewed author's NIP-65 write relays are fetched, scored by Thompson Sampling, and the top 3 are queried in parallel with the app relays.

**Why this matters:** Full outbox routing requires rewriting the relay routing layer — a significant engineering investment. Hybrid outbox is ~80 LOC of hook-level changes with no routing layer modifications. The question is how much recall this sacrifices.

**1yr cross-profile comparison (cap@20, NIP-66 liveness filtered):**

| Profile (follows) | Ditto-Mew baseline | Big Relays | Hybrid S1 | Hybrid S5 | Welshman+Thompson S5 |
|---|:---:|:---:|:---:|:---:|:---:|
| fiatjaf (194) | 5.3% | 4.1% | 40.8% | **91.9%** | 93.3% |
| Gato (399) | 7.4% | 6.5% | 24.3% | **86.0%** | 95.6% |
| ODELL (1,779) | 7.1% | 6.2% | 32.7% | **87.2%** | 89.2% |
| Telluride (2,784) | 5.0% | 3.6% | 23.7% | **92.5%** | 97.7% |
| **4-profile mean** | **6.2%** [5–7] | **5.1%** [4–7] | **30.4%** [24–41] | **89.4%** [86–93] | **93.9%** [89–98] |

**Hybrid outbox session progression (1yr event recall):**

| Profile (follows) | S1 | S2 | S3 | S4 | S5 |
|---|:---:|:---:|:---:|:---:|:---:|
| fiatjaf (194) | 40.8% | 91.9% | 91.9% | 91.9% | 91.9% |
| Gato (399) | 24.3% | 86.0% | 86.0% | 86.0% | 86.0% |
| ODELL (1,779) | 32.7% | 87.2% | 87.2% | 87.2% | 87.2% |
| Telluride (2,784) | 23.7% | 92.5% | 92.5% | 92.5% | 92.5% |

**Welshman+Thompson session progression for comparison (1yr event recall):**

| Profile (follows) | S1 | S2 | S3 | S4 | S5 |
|---|:---:|:---:|:---:|:---:|:---:|
| fiatjaf (194) | 14.9% | 86.3% | 89.7% | 91.9% | 93.3% |
| Gato (399) | 31.2% | 93.7% | 95.7% | 95.6% | 95.6% |
| ODELL (1,779) | 29.1% | 87.1% | 89.2% | 89.2% | 89.2% |
| Telluride (2,784) | 17.5% | 97.5% | 97.7% | 97.7% | 97.7% |

**Key findings:**

1. **Hybrid outbox converges faster than full outbox.** Hybrid reaches its ceiling by session 2 on all profiles — the app relay floor provides a strong starting signal for Thompson to learn from. Welshman+Thompson takes 3-4 sessions to converge because it starts from a purely stochastic baseline.

2. **The gap to full outbox is 4.5pp after convergence.** Hybrid mean is 89.4% vs Welshman+Thompson's 93.9% at 1yr (4-profile mean, session 5). The gap is smallest on ODELL (2.0pp) and largest on Gato (9.6pp). This 4.5pp gap represents the cost of not routing the main feed per-author — niche relays that only appear in full decomposition's 20-relay budget are missed.

3. **Hybrid outbox beats Welshman+Thompson at session 1.** On cold start, hybrid (30.4% mean) outperforms Welshman+Thompson (23.2% mean) because the 4 app relays provide a guaranteed floor. This advantage inverts by session 2-3 as Welshman+Thompson's learned priors surpass the app relay floor.

4. **The Ditto-Mew baseline (4 app relays, no outbox) averages 6.2% at 1yr.** This is comparable to Big Relays (5.1%) — 4 major relays capture roughly the same fraction of 1yr-old events as 2 major relays. The value of app relays is latency and reliability, not historical recall.

5. **Hybrid outbox is a viable ship-first strategy.** For clients with hardcoded app relays, hybrid outbox + Thompson delivers 89% 1yr recall with ~80 LOC and no routing layer changes. Full outbox routing (#1305-style transport decomposition) can be added later for the remaining 4.5pp, or deferred entirely if the engineering cost doesn't justify the marginal gain.

See [bench/src/algorithms/ditto-outbox.ts](bench/src/algorithms/ditto-outbox.ts) for the benchmark implementation and [bench/src/algorithms/ditto-mew.ts](bench/src/algorithms/ditto-mew.ts) for the baseline.

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

9. **Aggregator results are surprisingly poor.** Primal reaches 32% recall at 7d (6-profile mean) and <1% at 3yr — worse than Popular+Random (damus + nos.lol + 2 random relays) at every window. This is unexpected: an aggregator that proxies tens if not hundreds of relays should in theory outperform 4 random connections. This may indicate a limitation in the benchmark methodology rather than a real-world indictment of aggregators.

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
