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
│  ├─ Can maintain state across rounds? → MAB-UCB
│  └─ Stateless?                        → Weighted Stochastic
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

1 relay = fragile (relay goes down, you lose that author). 2 = redundancy.
3+ = diminishing returns. Industry consensus: 7 of 9 implementations with
per-pubkey limits default to 2 or 3.

### 3. Pre-filter dead relays with NIP-66

[NIP-66](https://github.com/nostr-protocol/nips/blob/master/66.md) (kind
30166) and [nostr.watch](https://github.com/sandwichfarm/nostr-watch) publish
relay liveness and performance data. No analyzed client uses this yet.
Two modes:

- **Strict** — remove relays marked dead
- **Relaxed** — remove relays marked dead + relays with no NIP-66 data

Caveat: some relays block NIP-66 monitors, resulting in "falsely dead"
classifications. More monitors publishing kind 30166 would reduce this.
NIP-66 data is best used as a supplement to local health tracking, not a
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

## Algorithm Quick Reference

Event recall varies dramatically by time window. An algorithm that works
well for recent posts may fail badly for older content:

| Algorithm | 7d recall | 1yr recall | Best for | Weakness |
|-----------|:---------:|:----------:|----------|----------|
| **Greedy Set-Cover** | 84% | 16% | Max assignment coverage within a budget | Degrades sharply for history; concentrates on popular relays |
| **Weighted Stochastic** (Welshman) | 83% | 38% | Balanced real-time + archival | Slightly lower coverage than greedy (~1–3%) |
| **Priority-Based** (NDK) | 83% | 19% | Zero-effort outbox (transparent to app) | Rich-get-richer effect on first-connected relays |
| **MAB-UCB** | 91% | 41% | Long-window event recall | Requires rounds/state; not yet in any client |
| **Direct Mapping** (Amethyst feeds) | 88% | 17% | Simplicity; no optimization needed | No connection minimization; scales poorly |
| **Filter Decomposition** (rust-nostr) | 77% | 19% | Fine-grained per-type limits | Lower recall than greedy at short windows |
| **Greedy Coverage Sort** (Nostur) | 65% | 13% | Anti-centralization (skipTopRelays) | Costs 5–12% coverage vs standard greedy |
| **Streaming Coverage** | 92% | 38% | Near-optimal coverage in a single pass | Not yet in any client |

Recall = mean event recall across 6 profiles (7d) or fiatjaf profile (1yr).
See [OUTBOX-REPORT.md Section 8](OUTBOX-REPORT.md#8-benchmark-results) for
full data across all time windows and profiles.

## Further Reading

- Full benchmark data: [OUTBOX-REPORT.md](OUTBOX-REPORT.md)
- Per-client implementation details: [analysis/clients/](analysis/clients/)
- Cross-client comparison: [analysis/cross-client-comparison.md](analysis/cross-client-comparison.md)
- Reproduce results: [bench/](bench/) (Deno v2+, run `deno task bench --help`)
