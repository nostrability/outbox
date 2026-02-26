# Implementation Guide

How to implement the three things from the [README](README.md): dead relay filtering,
learning-based selection, and delivery verification.

See [OUTBOX-REPORT.md](OUTBOX-REPORT.md) for full benchmark data.

## Choosing an Algorithm

```
What matters most?
│
├─ Maximum coverage (real-time feeds)?
│  ├─ Need connection minimization? → Greedy Set-Cover
│  ├─ Need zero-config library?     → Priority-Based (NDK)
│  └─ Simplicity over optimization? → Direct Mapping
│
├─ Historical event recall (archival, search)?
│  ├─ Can persist state across sessions? → Welshman+Thompson Sampling
│  ├─ State within single session?       → MAB-UCB
│  └─ Stateless?                         → Weighted Stochastic (Welshman/Coracle)
│
└─ Anti-centralization (distribute relay load)?
   ├─ Via scoring?       → Weighted Stochastic (log dampening + random)
   └─ Via explicit skip? → Greedy Coverage Sort (skipTopRelays)
```

Key tradeoff: **coverage-optimal ≠ event-recall-optimal.** Greedy set-cover
wins assignment coverage (23/26 profiles) but ranks 7th at actual event
retrieval. Stochastic approaches discover relays that retain history.

## Recommendations

### 1. Cap at 20 connections

All algorithms reach within 1-2% of their unlimited ceiling by 20
connections. Greedy at 10 already achieves 93-97% of its unlimited coverage.

### 2. Target 2-3 relays per author

1 relay = fragile (relay goes down or silently drops a write, you lose events).
2 = redundancy. 3+ = diminishing returns. 7 of 9 implementations with
per-pubkey limits default to 2 or 3.

### 3. Pre-filter relays with NIP-66

[NIP-66](https://github.com/nostr-protocol/nips/blob/master/66.md) (kind
30166) and [nostr.watch](https://github.com/sandwichfarm/nostr-watch) publish
relay liveness data. No analyzed client uses this yet.

The improvement is in relay success rate (fewer wasted connections), not
necessarily in event recall. NIP-66 filtering removes 40-64% of dead relays
and more than doubles the rate at which selected relays actually respond:

| Profile (follows) | Without NIP-66 | With NIP-66 | Relays Removed |
|---|---|---|---|
| fiatjaf (194) | 56% success | 87% success | 93 (40%) |
| Gato (399) | 26% | 80% | 454 (66%) |
| ValderDama (1,077) | 35% | 79% | 531 (58%) |
| Telluride (2,784) | 30% | 74% | 1,057 (64%) |

Event recall impact is mixed: stochastic algorithms (MAB-UCB, Welshman) gain
+5pp because removing dead relays improves sample quality. Thompson Sampling
shows minimal NIP-66 benefit because it already learns to avoid dead relays.
Greedy shows a slight negative delta because NIP-66 may remove relays that
are offline but still serve historical events from disk.

Relay liveness is 3 states, not binary (per nostr.watch author):

- **Online** — recently seen. Include normally.
- **Offline** — not seen recently, may come back. Deprioritize but don't
  exclude — an offline relay may still have historical events you need.
- **Dead** — probably never coming back. Exclude.

At minimum, track health locally: binary online/offline with exponential
backoff (Amethyst), tiered error thresholds (Welshman: 1/min, 3/hr, 10/day =
excluded), or penalty timers (Gossip: 15s-10min per failure reason).

### 4. Measure actual delivery

No analyzed client tracks per-author event coverage. In practice: for each
followed author, periodically query a second relay and compare event counts
against what your primary outbox relay returned. When gaps are detected, add
a fallback relay automatically. This should be invisible to the user.

```typescript
async function checkDelivery(author: string, outboxRelays: string[]) {
  const fromOutbox = await queryEvents(outboxRelays, { authors: [author], limit: 50 });
  const fromIndexer = await queryEvents(["wss://relay.nostr.band"], { authors: [author], limit: 50 });
  const missing = fromIndexer.filter(e => !fromOutbox.has(e.id));
  if (missing.length > 5) {
    addFallbackRelay(author, fromIndexer.bestRelay);
  }
}
```

### 5. Handle missing relay lists gracefully

20-44% of followed users lack kind 10002. Options (most clients combine
several):

- **Fallback to hardcoded popular relays** — relay.damus.io, nos.lol,
  relay.primal.net (most clients do this)
- **Use relay hints** from e/p tags in events
- **Query indexer relays** — purplepag.es, relay.nostr.band, nos.lol
- **Track which relays deliver events** per author (Gossip, rust-nostr,
  Voyage, Amethyst, Nosotros all do this as a secondary signal)

### 6. Diversify bootstrap relays

8/13 analyzed clients hardcode relay.damus.io. 6/13 depend on purplepag.es
for indexing. Consider diversifying:

| Role | Options |
|------|---------|
| Bootstrap | relay.damus.io, nos.lol, relay.primal.net |
| Indexer | purplepag.es, indexer.coracle.social, user.kindpag.es, directory.yabu.me |

### 7. Learn from what actually works

Every analyzed client picks relays statelessly — recompute from NIP-65 data
each time, with no memory of which relays actually delivered events.

Welshman+Thompson Sampling adds learning to Welshman's existing stochastic
scoring. After 2-3 sessions, it outperforms baseline Welshman and Greedy
at long windows and large follow counts (120 benchmark runs across 4
profiles, 3 time windows, 5 sessions). MAB-UCB still wins overall, but
requires 500 simulated rounds per selection:

```typescript
// Current Welshman (stateless):
const score = quality * (1 + Math.log(weight)) * Math.random();

// With Thompson Sampling (learns from delivery):
function sampleBeta(a: number, b: number): number {
  const x = gammaVariate(a);
  return x / (x + gammaVariate(b));
}
const alpha = stats.eventsDelivered + 1;
const beta = stats.eventsExpected - stats.eventsDelivered + 1;
const score = quality * (1 + Math.log(weight)) * sampleBeta(alpha, beta);
```

| Profile (follows) | Window | Greedy | Welshman | Thompson (learned) | MAB-UCB |
|---|---|---|---|---|---|
| Telluride (2,784) | 3yr | 56% | 60% | **63%** | 67% |
| ValderDama (1,077) | 3yr | 71% | 77% | **75%** | 80% |
| Gato (399) | 1yr | 79% | 83% | **83%** | 84% |

Thompson converges in 2-3 sessions. The biggest gains appear at long windows
and large follow counts, where the relay selection problem is hardest.

In practice, a learning relay selector is periodic rebalancing with memory:

```
On startup:
  Load per-relay stats from DB: {relay → (times_selected, events_delivered)}

Every N minutes (one "round"):
  1. Score each candidate relay using stats + exploration bonus
  2. Pick top K relays by score
  3. Swap connections if the selected set changed
  4. Observe: count events received per relay for followed authors
  5. Update stats, persist to DB
```

Minimal schema:

```sql
CREATE TABLE relay_stats (
  relay_url TEXT PRIMARY KEY,
  times_selected INTEGER DEFAULT 0,
  events_delivered INTEGER DEFAULT 0,
  events_expected INTEGER DEFAULT 0,
  last_selected_at INTEGER,
  last_event_at INTEGER
);
```

**Why Welshman's `random()` already works well:** `random()` = sampling from
Beta(1,1), the "I know nothing" prior. Thompson Sampling replaces this with
Beta(successes, failures) — the "I've observed this relay" posterior. The
upgrade preserves randomness, adds memory, and is a few dozen lines of code
on top of what Coracle already ships.

## Improvement Opportunities

Building on [§7](#7-learn-from-what-actually-works):

- **Greedy+ε-exploration** showed negligible benefit at ε=0.05 in our
  benchmarks — higher values may be needed.
- **Sliding window for MAB** — only use the last N observations per relay,
  or exponentially decay old ones. Relay quality changes over time.
- **Per-author event recall as reward** — current reward is binary (is this
  author covered?). Better: how many of this author's events did this relay
  actually deliver?
- **Contextual features** — use NIP-11 capabilities, NIP-66 health data,
  paid vs free as features for estimating new relay quality without exploring.

## Further Reading

- Full benchmark data: [OUTBOX-REPORT.md](OUTBOX-REPORT.md)
- Per-client implementation details: [analysis/clients/](analysis/clients/)
- Cross-client comparison: [analysis/cross-client-comparison.md](analysis/cross-client-comparison.md)
- Reproduce results: [Benchmark-recreation.md](Benchmark-recreation.md)
