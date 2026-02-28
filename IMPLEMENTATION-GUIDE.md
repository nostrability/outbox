# Implementation Guide

Detailed recommendations for adding or upgrading outbox relay selection in your app. For the summary, see [README.md](README.md). For full benchmark data, see [OUTBOX-REPORT.md](OUTBOX-REPORT.md).

## Choosing an Algorithm

```
What's your starting point?
│
├─ No outbox yet (hardcoded app relays / broadcast)?
│  │
│  ├─ Can you rewrite your relay routing layer?
│  │  └─ Yes → Full outbox (Steps 1a → 4 in README)
│  │           Best recall (84-89% 1yr [75–96]), biggest engineering investment
│  │
│  └─ Need to preserve feed latency or can't change routing?
│     └─ Hybrid outbox — add outbox queries to profile/event/thread hooks
│        89% 1yr recall [86–93] (after learning), ~80 LOC, no routing layer changes
│        See README § Hybrid outbox for code
│
├─ Basic outbox (real-time feeds)?
│  ├─ Need connection minimization? → Greedy Set-Cover (16% [12–20] 1yr, 84% [77–94] 7d)
│  ├─ Need zero-config library?     → Priority-Based / NDK (16% [12–19] 1yr, 83% [77–92] 7d)
│  └─ Simplicity over optimization? → Direct Mapping (30% [17–40] 1yr, unlimited connections)
│
├─ Historical event recall (archival, search)?
│  ├─ Can persist state across sessions?
│  │  ├─ Using Welshman/Coracle?  → Welshman+Thompson Sampling (89% [82–96] 1yr)
│  │  ├─ Using rust-nostr?        → FD+Thompson (84% [75–92] 1yr after 5 sessions)
│  │  └─ Using app relays?        → Hybrid+Thompson (89% [86–93] 1yr, no routing changes)
│  └─ Stateless?                  → Filter Decomposition (25% [19–32] 1yr) or
│                                   Weighted Stochastic / Welshman (24% [12–38] 1yr)
│
└─ Anti-centralization (distribute relay load)?
   ├─ Via scoring?       → Weighted Stochastic (log dampening + random)
   └─ Via explicit skip? → Greedy Coverage Sort (skipTopRelays, but -20% recall)
```

*All recall numbers are 1yr, 6-profile means. [min–max] ranges show the spread across tested profiles (194–1,779 follows) — your recall depends on your follow graph. At 7d most algorithms cluster at 83-84% — the differences only emerge at longer windows where relay retention becomes the binding constraint.*

Key tradeoff: **coverage-optimal ≠ event-recall-optimal.** Greedy set-cover
wins assignment coverage (23/26 profiles) but drops to 16% event recall at 1yr
while stochastic approaches reach 24%. Algorithms that spread queries discover
relays that retain history.

## Recommendations (ordered by impact)

### 1. Learn from what actually works

**Impact: +60-70pp event recall after 2-3 sessions**

Every analyzed client picks relays statelessly — recompute from NIP-65 data
each time, with no memory of which relays actually delivered events.

Thompson Sampling adds learning to any stochastic relay scoring. On session 1,
`sampleBeta(1, 1)` = `rng()` — identical to stateless Welshman. By session 3,
the scorer has learned which relays actually deliver and recall jumps dramatically
(1yr event recall, cap@20, NIP-66 filtered):

| Profile (follows) | Session 1 (stateless) | Session 3+ (learned) | Improvement |
|---|---|---|---|
| Gato (399) | 31.2% | **95.5%** | +64pp |
| ODELL (1,779) | 29.1% | **90.5%** | +61pp |
| Telluride (2,784) | 17.5% | **89.5%** | +72pp |
| 4-profile mean | 23% [15–31] | **89%** [82–96] | +66pp |

Thompson converges in 2-3 sessions. The gains are largest at long time windows
and large follow counts, where the relay selection problem is hardest. Small
profiles (<200 follows) may see minimal gains — the 20-relay budget already
covers most combinations.

**Why Welshman's `random()` already works well:** `random()` = sampling from
Beta(1,1), the "I know nothing" prior. Thompson Sampling replaces this with
Beta(successes, failures) — the "I've observed this relay" posterior. The
upgrade preserves randomness, adds memory, and is ~80 lines of code on top
of what Coracle already ships.

See [README.md § Thompson Sampling](README.md#thompson-sampling) for complete code including the full integration loop (startup → score → select → observe → persist).

**For rust-nostr / Filter Decomposition users:** FD+Thompson is a variant that fits
Filter Decomposition's per-author structure directly. It replaces lexicographic relay
ordering with `sampleBeta(α, β)` scoring — no popularity weight. After 5 learning
sessions (cap@20, NIP-66 filtered), FD+Thompson reaches **83.9% event recall** [75–92] at 1yr
vs baseline FD's 23.1% — converging within 2-3 sessions. Welshman+Thompson leads by
~5pp (89.4% [82–96]) due to the popularity weight, but FD+Thompson is a drop-in upgrade for
existing rust-nostr code with no structural changes needed.
See [README.md § FD+Thompson](README.md#fdthompson-for-rust-nostr) for code.

**For app-relay clients (Ditto-Mew, or any client with hardcoded relay URLs):**
Hybrid+Thompson keeps your app relays for the main feed and adds Thompson-scored
outbox queries only for profile views, event lookups, and thread traversal. After
2 sessions, hybrid reaches **89.4% event recall** [86–93] at 1yr — within 4.5pp of full
Welshman+Thompson (93.9% [89–98]) — with ~80 LOC and no routing layer changes. Converges
faster than full outbox because the app relay floor provides a strong initial signal.
See [README.md § Hybrid outbox](README.md#hybrid-outbox-for-app-relay-clients) for code
and [OUTBOX-REPORT.md § 8.5](OUTBOX-REPORT.md#85-hybrid-outbox-app-relay-broadcast--per-author-thompson) for full benchmark data.

### 2. Pre-filter relays with NIP-66

**Impact: 1.5-3× better relay success rates, 39% faster feed loads**

[NIP-66](https://github.com/nostr-protocol/nips/blob/master/66.md) (kind
30166) and [nostr.watch](https://github.com/sandwichfarm/nostr-watch) publish
relay liveness data. No analyzed client uses this yet.

The improvement is in relay success rate (fewer wasted connections), not
necessarily in event recall. NIP-66 filtering removes 40-66% of dead relays
and more than doubles the rate at which selected relays actually respond:

| Profile (follows) | Without NIP-66 | With NIP-66 | Relays Removed |
|---|---|---|---|
| fiatjaf (194) | 56% success | 87% success | 93 (40%) |
| Gato (399) | 26% | 80% | 454 (66%) |
| ValderDama (1,077) | 35% | 79% | 531 (58%) |
| Telluride (2,784) | 30% | 74% | 1,057 (64%) |

Relay liveness is 3 states, not binary (per nostr.watch author):

- **Online** — recently seen. Include normally.
- **Offline** — not seen recently, may come back. Deprioritize but don't
  exclude.
- **Dead** — probably never coming back. Exclude.

At minimum, track health locally: binary online/offline with exponential
backoff (Amethyst), tiered error thresholds (Welshman: 1/min, 3/hr, 10/day =
excluded), or penalty timers (Gossip: 15s-10min per failure reason).

See [README.md § NIP-66 pre-filter](README.md#nip-66-pre-filter) for code.

### 3. Measure actual delivery

**Impact: catches systematic gaps invisible to relay health checks**

NIP-66 monitors check relay liveness, but no analyzed client verifies
per-author delivery — "did this relay return events for author X?" True
completeness isn't measurable (no relay has everything), but you can detect
systematic gaps: for each followed author, periodically query a second relay
and compare against what your outbox relays returned. When gaps are detected,
add a fallback relay automatically. This should be invisible to the user.

[NIP-77](https://github.com/nostr-protocol/nips/blob/master/77.md) (negentropy
syncing) makes this efficient: instead of downloading all events to compare,
a client can run a set-reconciliation handshake to learn which events a relay
has without transferring them. This is the same protocol
[replicatr](https://github.com/coracle-social/replicatr) uses for relay
migration — it works equally well for delivery verification.

See [README.md § Delivery check](README.md#delivery-check-self-healing) for code.

### 4. Cap at 20 connections

All algorithms reach within 1-2% of their unlimited ceiling by 20
connections. Greedy at 10 already achieves 93-97% of its unlimited coverage.

### 5. Target 2-3 relays per author

1 relay = fragile (relay goes down or silently drops a write, you lose events).
2 = redundancy. 3+ = diminishing returns. 7 of 9 implementations with
per-pubkey limits default to 2 or 3.

### 6. Handle missing relay lists gracefully

On paper, 20-44% of followed users lack kind 10002 — but [dead account
analysis](bench/NIP66-COMPARISON-REPORT.md#5-dead-account-analysis) shows
~85% of those are accounts with no posts in 2+ years. The real NIP-65 adoption
gap among active users is ~3-5%. Options for handling missing relay lists
(most clients combine several):

- **Fallback to hardcoded popular relays** — relay.damus.io, nos.lol,
  relay.primal.net (most clients do this)
- **Use relay hints** from e/p tags in events
- **Query indexer relays** — purplepag.es, relay.nostr.band, nos.lol
- **Track which relays deliver events** per author (Gossip, rust-nostr,
  Voyage, Amethyst, Nosotros all do this as a secondary signal)

A related problem: users who change write relays without migrating old events.
Current NIP-65 lists reflect where users write *now*, not where they wrote
historically. No analyzed client handles this. [Building Nostr](https://building-nostr.coracle.social)
frames this as a synchronization problem: "it is the responsibility of anyone
that changes the result of relay selection heuristics to synchronize events to
the new relay." [replicatr](https://github.com/coracle-social/replicatr)
automates this server-side via negentropy sync, but is a proof-of-concept (not
production). Client-side detection of "relay listed but no data from this
author" would catch both missing relay lists and stale migrations.

### 7. Diversify bootstrap relays

8/13 analyzed clients hardcode relay.damus.io. 6/13 depend on purplepag.es
for indexing. Consider diversifying:

| Role | Options |
|------|---------|
| Bootstrap | relay.damus.io, nos.lol, relay.primal.net |
| Indexer | purplepag.es, indexer.coracle.social, user.kindpag.es, directory.yabu.me |

## Further Reading

- Full benchmark data: [OUTBOX-REPORT.md](OUTBOX-REPORT.md)
- Per-client implementation details: [analysis/clients/](analysis/clients/)
- Cross-client comparison: [analysis/cross-client-comparison.md](analysis/cross-client-comparison.md)
- Reproduce results: [Benchmark-recreation.md](Benchmark-recreation.md)
- Protocol architecture: [Building Nostr](https://building-nostr.coracle.social) — relay routing, content migration, bootstrapping
- Relay sync tooling: [replicatr](https://github.com/coracle-social/replicatr) — negentropy-based event replication on relay list changes
