# Implementation Guide

Concrete recommendations for implementing outbox relay routing, based on
benchmarking 14 algorithms across 26 profiles and verifying event retrieval
across 6 time windows.

See [OUTBOX-REPORT.md](OUTBOX-REPORT.md) for full data.

## Choosing an Algorithm

The right relay selection algorithm depends on what your client needs.
Use these questions to narrow it down:

```
What matters most?
│
├─ Maximum coverage (real-time feeds)?
│  ├─ Need connection minimization? → Greedy Set-Cover
│  ├─ Need zero-config library?     → Priority-Based (NDK)
│  └─ Simplicity over optimization? → Direct Mapping
│
├─ Historical event recall (archival, search)?
│  ├─ Can maintain state? → MAB-UCB (not yet in any client)
│  └─ Stateless?          → Weighted Stochastic (Welshman/Coracle)
│
├─ Anti-centralization (distribute relay load)?
│  ├─ Via scoring?       → Weighted Stochastic (log dampening + random)
│  └─ Via explicit skip? → Greedy Coverage Sort (skipTopRelays)
│
└─ Near-optimal coverage (research, benchmarking)?
   ├─ Single-pass?       → Streaming Coverage
   └─ Exact solution?    → ILP Optimal
```

Key tradeoff: **coverage-optimal ≠ event-recall-optimal.** Greedy set-cover
wins assignment coverage (23/26 profiles) but ranks 7th at actual event
retrieval at 1yr (16.3% recall). Stochastic approaches discover relays that
retain history. See the [Algorithm Quick Reference](#algorithm-quick-reference)
below and [OUTBOX-REPORT.md Section 8](OUTBOX-REPORT.md#8-benchmark-results)
for full benchmark data.

## Recommendations

### 1. Cap at 20 connections

Diminishing returns after 20. All algorithms reach within 1–2% of their
unlimited ceiling by 20 connections. Greedy at 10 connections already achieves
93–97% of its unlimited coverage.

| Project | Default cap |
|---------|:-----------:|
| noStrudel | 20 |
| Voyage | 25 |
| Gossip | 50 |
| Nostur | 50 |
| Wisp | 75 |

### 2. Target 2–3 relays per author

1 relay = fragile (relay goes down or silently drops a write, you lose events). 2 = redundancy.
3+ = diminishing returns. Industry consensus: 7 of 9 implementations with
per-pubkey limits default to 2 or 3.

### 3. Pre-filter relays with NIP-66

[NIP-66](https://github.com/nostr-protocol/nips/blob/master/66.md) (kind
30166) and [nostr.watch](https://github.com/sandwichfarm/nostr-watch) publish
relay liveness and performance data. No analyzed client uses this yet.

Relay liveness is 3 states, not binary (per nostr.watch author):

- **Online** — recently seen. Include normally.
- **Offline** — not seen recently, may come back. Deprioritize but don't
  exclude — an offline relay may still have historical events you need.
- **Dead** — probably never coming back. Exclude.

To correctly classify, a client consuming NIP-66 needs: the monitor's
publishing frequency (kind 10166), a jitter-tolerant multiplier on that
frequency for the offline threshold (nostr.watch uses 1.2x), and a
client-chosen dead threshold (subjective — not seen in a week? a month?).

Caveats: some relays block NIP-66 monitors, causing false "offline"
classifications. The dead threshold is subjective — there is no universal
answer. More monitors publishing kind 30166 would improve accuracy. NIP-66
data is best used as a supplement to local health tracking, not a
replacement.

At minimum, track health locally: binary online/offline with exponential
backoff (Amethyst), tiered error thresholds (Welshman: 1/min, 3/hr, 10/day =
excluded), or penalty timers (Gossip: 15s–10min per failure reason).

### 4. Measure actual delivery

No analyzed client tracks per-author event coverage. In practice: for each
followed author, periodically query a second relay (an indexer or the
author's other declared write relays) and compare event counts against what
your primary outbox relay returned. When gaps are detected, the client
should act automatically — add a fallback relay for that author, promote a
relay that has the missing events, or temporarily broaden the query. This
should be invisible to the user, like email clients silently retrying
delivery. Power users can get a debug view (like noStrudel's outbox
debugger), but the default path should be self-healing.

noStrudel's outbox debugger shows assignment coverage (the "on paper" view —
how many follows are mapped to at least one relay) but not event recall (did
you actually get the posts). Our benchmark shows these diverge sharply: 85%
assignment coverage can mean 16% event recall at 1yr.

Example self-healing delivery check (TypeScript pseudocode):

```typescript
// Every 30 minutes, for a sample of followed authors:
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

20–44% of followed users lack kind 10002. Options (most clients combine
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

Amethyst is the most resilient with 5 configured indexer relays.

### 7. Learn from what actually works

Every analyzed client picks relays statelessly — recompute from NIP-65 data
each time, with no memory of which relays actually delivered events. This is
why greedy set-cover (the most common algorithm) degrades to 10% recall at
3yr: it keeps choosing the same popular relays that may have pruned old events.

MAB-UCB wins long-term recall (23% at 3yr, 41% at 1yr) because it learns.
In practice, a learning relay selector is just periodic rebalancing with
memory — something clients already do for health tracking, but applied to
event delivery:

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

Minimal schema for per-relay stats:

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

The stored state is small (~100 bytes per relay). Some clients already have
the building blocks: Gossip persists per-relay penalty timers, Voyage tracks
which relay delivered which author's events (`EventRelayAuthorView`),
Nosotros has a `seen` table recording `(eventId, relay, created_at)`. None
feed this data back into relay selection.

**Easiest path to adoption:** Welshman's `random()` factor — the reason it
has the best archival recall among deployed clients — is accidentally a
crude form of [Thompson Sampling](https://en.wikipedia.org/wiki/Thompson_sampling)
(drawing from Uniform(0,1) = Beta(1,1), the "I know nothing" prior). Replace
`random()` with `sample_beta(successes, failures)` per relay, where successes
and failures come from observed event delivery. This keeps the beneficial
randomness, adds learning, and is a few dozen lines of code on top of what
Coracle already ships:

```typescript
// Current Welshman (stateless):
const score = quality * (1 + Math.log(weight)) * Math.random();

// With Thompson Sampling (learns):
function sampleBeta(a: number, b: number): number {
  // Jüni approximation or use a library
  const x = gammaVariate(a);
  return x / (x + gammaVariate(b));
}
const alpha = stats.eventsDelivered + 1;
const beta = stats.eventsExpected - stats.eventsDelivered + 1;
const score = quality * (1 + Math.log(weight)) * sampleBeta(alpha, beta);
```

## Improvement Opportunities

All of these build on the rounds/state model from [§7](#7-learn-from-what-actually-works)
— periodic rebalancing with persisted per-relay stats. No client does this
yet. These are concrete enhancements to that model, ordered by effort:

**Low effort (modify existing algorithm):**

- **Welshman + Thompson Sampling.** Replace `random()` with
  `sample_beta(successes, failures)` per relay. Keeps the randomness that
  makes Welshman good at archival, adds memory so it learns which relays
  actually deliver. A few dozen lines on top of what Coracle already ships.
  See [§7](#7-learn-from-what-actually-works).
- **Greedy + ε-exploration.** With probability ε (e.g. 5%), pick a random
  relay instead of the max-coverage one. One `if` statement. Would likely
  fix greedy's catastrophic long-term recall (10% at 3yr) by occasionally
  discovering relays that retain history:

  ```typescript
  // Add to any greedy relay selector:
  function selectNextRelay(candidates, epsilon = 0.05) {
    if (Math.random() < epsilon) {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }
    return candidates.sort((a, b) => b.uncoveredCount - a.uncoveredCount)[0];
  }
  ```

**Medium effort (new capability):**

- **Sliding window for MAB.** Current MAB-UCB weights all rounds equally.
  Relay quality changes — a relay that was great 6 months ago may be dead
  now. Only use the last N observations per relay, or exponentially decay
  old ones. Matters in a real client, not in the static benchmark.
- **Warm-start MAB from greedy.** Instead of random initialization, start
  from greedy's solution and explore outward. Greedy is already good on
  paper — MAB should spend exploration budget discovering if alternatives
  are better in practice, not rediscovering what greedy already knows.

**Higher effort (new signal):**

- **Per-author event recall as reward.** Current reward is binary: is this
  author covered? Better: how many of this author's events did this relay
  actually deliver? A relay covering 10 authors but keeping only 7 days of
  history should score lower than one covering 5 authors with full
  retention.
- **Contextual features.** Use relay metadata (NIP-11 capabilities, NIP-66
  health, paid vs free, estimated retention window) as features. Lets the
  algorithm estimate quality for new relays without exploring from scratch.

None of these have been benchmarked yet. The Welshman + Thompson Sampling
variant is tracked as the first test
([outbox-d79](https://github.com/nostrability/outbox)).

## Algorithm Quick Reference

Event recall varies dramatically by time window. An algorithm that works
well for recent posts may fail badly for older content.

**Deployed in clients:**

| Algorithm | 3yr recall | 1yr recall | 7d recall | Best for | Weakness |
|-----------|:----------:|:----------:|:---------:|----------|----------|
| **Weighted Stochastic** (Welshman) | 21% | 38% | 83% | Balanced real-time + archival | Slightly lower coverage than greedy (~1–3%) |
| **Priority-Based** (NDK) | 11% | 19% | 83% | Zero-effort outbox (transparent to app) | Rich-get-richer effect on first-connected relays |
| **Filter Decomposition** (rust-nostr) | 11% | 19% | 77% | Fine-grained per-type limits | Lower recall than greedy at short windows |
| **Greedy Set-Cover** | 10% | 16% | 84% | Max assignment coverage within a budget | Degrades sharply for history; concentrates on popular relays |
| **Direct Mapping** (Amethyst feeds) | 9% | 17% | 88% | Simplicity; no optimization needed | No connection minimization; scales poorly |
| **Greedy Coverage Sort** (Nostur) | 7% | 13% | 65% | Anti-centralization (skipTopRelays) | Costs 5–12% coverage vs standard greedy |

**Not yet in any client (benchmark results only):**

| Algorithm | 3yr recall | 1yr recall | 7d recall | Best for | Weakness |
|-----------|:----------:|:----------:|:---------:|----------|----------|
| **MAB-UCB** | 23% | 41% | 91% | Long-window event recall | Must persist per-relay stats across sessions (see [§7](#7-learn-from-what-actually-works)) |
| **Streaming Coverage** | 21% | 38% | 92% | Near-optimal coverage in a single pass | Theoretical; no client implementation |

Recall = mean event recall across 6 profiles (7d) or fiatjaf profile (1yr and 3yr).
See [OUTBOX-REPORT.md Section 8](OUTBOX-REPORT.md#8-benchmark-results) for
full data across all time windows and profiles.

## Further Reading

- Full benchmark data: [OUTBOX-REPORT.md](OUTBOX-REPORT.md)
- Per-client implementation details: [analysis/clients/](analysis/clients/)
- Cross-client comparison: [analysis/cross-client-comparison.md](analysis/cross-client-comparison.md)
- Reproduce results: [bench/](bench/) (Deno v2+, run `deno task bench --help`)
