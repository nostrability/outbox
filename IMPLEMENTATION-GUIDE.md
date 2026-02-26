# Implementation Guide

Detailed recommendations for adding or upgrading outbox relay selection in your app. For the summary, see [README.md](README.md). For full benchmark data, see [OUTBOX-REPORT.md](OUTBOX-REPORT.md).

## Choosing an Algorithm

```
What's your starting point?
│
├─ No outbox yet?
│  └─ Start here → hardcode relay.damus.io + nos.lol (8% 1yr recall)
│     then upgrade to basic outbox when ready
│
├─ Basic outbox (real-time feeds)?
│  ├─ Need connection minimization? → Greedy Set-Cover (16% 1yr, 84% 7d)
│  ├─ Need zero-config library?     → Priority-Based / NDK (16% 1yr, 83% 7d)
│  └─ Simplicity over optimization? → Direct Mapping (30% 1yr, unlimited connections)
│
├─ Historical event recall (archival, search)?
│  ├─ Can persist state across sessions? → Welshman+Thompson Sampling (81% 1yr)
│  └─ Stateless?                         → Filter Decomposition (25% 1yr) or
│                                          Weighted Stochastic / Welshman (24% 1yr)
│
└─ Anti-centralization (distribute relay load)?
   ├─ Via scoring?       → Weighted Stochastic (log dampening + random)
   └─ Via explicit skip? → Greedy Coverage Sort (skipTopRelays, but -20% recall)
```

*All recall numbers are 1yr, 6-profile means. At 7d most algorithms cluster at 83-84% —
the differences only emerge at longer windows where relay retention becomes the binding constraint.*

Key tradeoff: **coverage-optimal ≠ event-recall-optimal.** Greedy set-cover
wins assignment coverage (23/26 profiles) but drops to 16% event recall at 1yr
while stochastic approaches reach 24%. Algorithms that spread queries discover
relays that retain history.

## Recommendations (ordered by impact)

### 1. Learn from what actually works

**Impact: +60-70pp event recall after 2-3 sessions**

Every analyzed client picks relays statelessly — recompute from NIP-65 data
each time, with no memory of which relays actually delivered events.

Welshman+Thompson Sampling adds learning to Welshman's existing stochastic
scoring. After 2-3 sessions, it consistently outperforms Greedy and matches
or exceeds baseline Welshman at long windows (120 benchmark runs across 4
profiles, 3 time windows, 5 sessions):

| Profile (follows) | Window | Greedy | Welshman | Thompson (learned) |
|---|---|---|---|---|
| Telluride (2,784) | 3yr | 56% | 60% | **63%** |
| ValderDama (1,077) | 3yr | 71% | 77% | **75%** |
| Gato (399) | 1yr | 79% | 83% | **83%** |

Thompson converges in 2-3 sessions. The biggest gains appear at long windows
and large follow counts, where the relay selection problem is hardest. Small
profiles (<200 follows) may see minimal gains — the 20-relay budget already
covers most combinations.

**Why Welshman's `random()` already works well:** `random()` = sampling from
Beta(1,1), the "I know nothing" prior. Thompson Sampling replaces this with
Beta(successes, failures) — the "I've observed this relay" posterior. The
upgrade preserves randomness, adds memory, and is ~80 lines of code on top
of what Coracle already ships.

See [README.md § Thompson Sampling](README.md#thompson-sampling) for complete code including the full integration loop (startup → score → select → observe → persist).

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
