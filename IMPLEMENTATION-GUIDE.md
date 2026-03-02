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
│  │           Best recall (84-89% [75–96] 1yr), biggest engineering investment
│  │
│  └─ Need to preserve feed latency or can't change routing?
│     └─ Hybrid outbox — add outbox queries to profile/event/thread hooks
│        89% [86–93] 1yr recall (after learning), ~80 LOC, no routing layer changes
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

*Recall numbers are 1yr by default (6-profile means) unless a 7d value is explicitly shown. [min–max] ranges show the spread across tested profiles (194–1,779 follows) — your recall depends on your follow graph. At 7d most algorithms cluster at 83-84% — the differences only emerge at longer windows where relay retention becomes the binding constraint.*

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

#### Optional: Latency-aware scoring (faster feed population)

Once you have Thompson Sampling running, you can optionally add a latency discount that makes the feed fill in faster. This doesn't change TTFE (first event) — that's already fast. It improves *progressive completeness*: how much of the feed is visible within 2 seconds.

Add one line to your Thompson scoring:

```typescript
// Track latency alongside delivery stats:
// After each relay query, update EWMA:
const measured = connectTimeMs + queryTimeMs;
stats.latencyMs = stats.latencyMs === undefined
  ? measured
  : stats.latencyMs * 0.7 + measured * 0.3;

// In relay scoring, multiply by latency discount:
const discount = stats.latencyMs !== undefined
  ? 1 / (1 + stats.latencyMs / 1000)
  : 1.0;  // cold start = no penalty
const score = quality * (1 + Math.log(weight)) * sampleBeta(alpha, beta) * discount;
```

The discount shape is hyperbolic: 200ms → 0.83, 500ms → 0.67, 1s → 0.50, 2s → 0.33, 5s → 0.17. Slow-but-reliable relays still compete. Cold start (no data yet) = 1.0 = identical to base Thompson.

**When to use it:** For apps targeting typical users (< 500 follows), add it unconditionally — +10-11pp completeness @2s at < 1pp recall cost. For power users (1000+ follows), the recall cost is steeper (−11 to −14pp) — consider making the discount tunable or skipping it. The Welshman variant (with popularity weight) has roughly half the recall cost of FD+Thompson at every profile size.

Persist the EWMA in your relay stats table (one extra column). See [README.md § 5](README.md#5-make-your-feed-fill-in-faster-by-learning-relay-speed) for the cross-profile data and [OUTBOX-REPORT.md § 8.6](OUTBOX-REPORT.md#86-latency-aware-thompson-sampling) for the full benchmark results.

### 2. Pre-filter relays with NIP-66

**Impact: 1.5-3× better relay success rates, 45% faster feed loads**

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

### 4. Set timeouts by use case (latency-coverage tradeoff)

**Impact: determines how fast your UI feels vs how much content users see**

Every relay query faces a tradeoff: wait longer → more events, but slower UI. The right timeout depends on what you're loading. Benchmarked across 7 profiles (194–2,784 follows):

```text
What are you loading?
│
├─ Main feed (timeline)
│  └─ EOSE-race: show events as they stream in,
│     cut off at first EOSE + 2s grace
│     → First event: 530-670ms
│     → 86-99% completeness at cutoff
│     → Done in 2-3s total wall-clock
│
├─ Profile view
│  └─ Query author's top 3 write relays + app relays in parallel
│     3s timeout
│     → 750-920ms median TTFE, 96-100% hit rate
│
├─ Event lookup / reply context
│  └─ Try relay hint from e-tag first (500ms timeout)
│     Fall back to author's write relays (2s timeout)
│
├─ Search / archival
│  └─ Query all selected relays, 15s timeout per relay
│     → ~100% completeness, accept 5-15s latency
│
└─ Notification badge / unread count
   └─ EOSE-race: first EOSE + 500ms grace
      → 70-76% completeness, sub-second total
```

**EOSE-race implementation.** Query all relays in parallel. When the first relay sends EOSE, start a grace timer. Cut off when the timer fires:

```typescript
function eoseRace(pool, relays, filter, graceMs = 2000) {
  const events = new Map();  // deduplicate by event ID
  let firstEose = false;
  let graceTimer;

  return new Promise(resolve => {
    const sub = pool.subscribe(relays, filter, {
      onevent(event) {
        if (!events.has(event.id)) {
          events.set(event.id, event);
          onNewEvent(event);  // render immediately
        }
      },
      oneose() {
        if (!firstEose) {
          firstEose = true;
          graceTimer = setTimeout(() => {
            sub.close();
            resolve([...events.values()]);
          }, graceMs);
        }
      }
    });

    // Hard timeout: 15s regardless
    setTimeout(() => { sub.close(); resolve([...events.values()]); }, 15000);
  });
}
```

**Coverage and latency are directly opposed.** More relays = more events, but longer to collect them:

| Relays queried | Recall ceiling | At first EOSE | At +2s | At +5s |
|:---:|:---:|:---:|:---:|:---:|
| 2 (Big Relays) | 50–77% | 100% | 100% | 100% |
| 4 (Ditto-Mew) | 62–86% | 8–84% | 85–100% | 85–100% |
| 20 (Outbox) | 81–98% | 0–62% | 86–99% | 89–100% |

Two relays finish instantly but miss half the events. Twenty relays find nearly everything but take 2-5s. Hybrid outbox side-steps this: show app relay events immediately, stream in outbox events in the background.

**Grace period decision matrix** (from 7-profile benchmark, EOSE-race simulation):

| Grace period | Completeness range | Best for |
|:---:|:---:|---|
| +0ms | 0–62% | Only 1-2 relay setups (Big Relays, Ditto-Mew) |
| +500ms | 5–93% | Notification badges, unread counts |
| +1s | 5–93% | Unreliable — too variable across profile sizes |
| **+2s** | **86–99%** | **Main feeds — best balance of speed and coverage** |
| +5s | 89–100% | Archival, search, completeness-critical paths |

The 0–62% range at +0ms means: if your algorithm queries 20 relays, the first EOSE arrives from the fastest relay but 19 others haven't reported yet. Waiting 2s lets most of them finish. For the largest profiles (2,700+ follows), +2s gets 86-87% — consider +5s for completeness-critical use cases.

*Data: 7 cross-profile benchmarks (194–2,784 follows). See [README.md § Latency](README.md#4-latency-when-to-stop-waiting-for-relays) for the summary and [OUTBOX-REPORT.md § 8.7](OUTBOX-REPORT.md#87-latency-simulation) for full data.*

#### Showing late-arriving events in the UI

The EOSE-race means your feed renders in <1s but more events trickle in over the next 2-5s. You need a UI pattern that shows the fast results immediately without reflowing content when stragglers arrive. This is a solved problem — Twitter, Mastodon, and federated search engines all handle it.

**Pattern 1: "N new posts" banner (recommended for feeds)**

The user sees the initial load. Late-arriving events accumulate in a buffer. A non-intrusive banner appears when the buffer has new content:

```text
┌─────────────────────────────────┐
│  ↑ 3 more posts                 │  ← banner appears after grace period
├─────────────────────────────────┤
│  Alice: just mass-adopted nostr │  ← first-EOSE events (visible immediately)
│  Bob: gm                        │
│  Carol: building on nostr...    │
│                                 │
│  Dave: new relay just dropped   │
│  Eve: outbox model is fire      │
└─────────────────────────────────┘
```

Tapping the banner scrolls up and inserts the new events in chronological position. This avoids layout shift — the user's reading position never jumps.

**Pattern 2: Shimmer placeholder rows (good for profile views)**

When loading a profile via outbox (3 write relays, 3s timeout), show skeleton rows that resolve into real events:

```text
┌─────────────────────────────────┐
│  @fiatjaf                       │
│  194 follows · 3 write relays   │
├─────────────────────────────────┤
│  Real note from relay 1         │  ← arrived at 400ms
│  Real note from relay 1         │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  ← shimmer placeholder
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  ← shimmer placeholder
└─────────────────────────────────┘

          ↓ 800ms later ↓

┌─────────────────────────────────┐
│  @fiatjaf                       │
│  194 follows · 3 write relays   │
├─────────────────────────────────┤
│  Real note from relay 1         │
│  Real note from relay 1         │
│  Real note from relay 2         │  ← resolved
│  Real note from relay 3         │  ← resolved
└─────────────────────────────────┘
```

Only show skeletons when you *expect* more content (you've queried relays that haven't responded yet). Remove them when the timeout fires, even if empty.

**Pattern 3: Relay progress counter (power-user addition)**

A subtle status line showing relay progress. Useful during longer queries (search, archival) or as a trust signal for users who want to see outbox routing working:

```text
┌─────────────────────────────────┐
│  Timeline                       │
│  ✓ 14 of 18 relays · 2 slow    │  ← progress counter
├─────────────────────────────────┤
│  [events...]                    │
└─────────────────────────────────┘

          ↓ grace period fires ↓

┌─────────────────────────────────┐
│  Timeline                       │
│                                 │  ← counter disappears
├─────────────────────────────────┤
│  [events...]                    │
└─────────────────────────────────┘
```

**Implementation with EOSE-race.** Extend the `eoseRace` function to support a UI callback:

```typescript
function eoseRaceFeed(pool, relays, filter, {
  graceMs = 2000,
  onEvent,          // (event) => void — render immediately
  onLateEvents,     // (events[]) => void — show "N new posts" banner
  onRelayProgress,  // (responded: number, total: number) => void
} = {}) {
  const earlyEvents = new Map();   // events before grace fires
  const lateEvents = new Map();    // events after grace fires
  let graceFired = false;
  let responded = 0;
  const total = relays.length;

  const sub = pool.subscribe(relays, filter, {
    onevent(event) {
      if (earlyEvents.has(event.id) || lateEvents.has(event.id)) return;
      if (!graceFired) {
        earlyEvents.set(event.id, event);
        onEvent?.(event);  // render in feed immediately
      } else {
        lateEvents.set(event.id, event);  // buffer for banner
      }
    },
    oneose() {
      responded++;
      onRelayProgress?.(responded, total);
      if (responded === 1) {
        // First EOSE — start grace timer
        setTimeout(() => {
          graceFired = true;
          // Any events already buffered? Show banner immediately.
          // Future events go to lateEvents buffer.
        }, graceMs);
      }
    }
  });

  // Hard timeout
  setTimeout(() => {
    sub.close();
    if (lateEvents.size > 0) onLateEvents?.([...lateEvents.values()]);
  }, 15000);
}
```

**Which pattern to use where:**

| Context | Pattern | Why |
|---|---|---|
| Main feed (timeline) | "N new posts" banner | Avoids layout shift while reading |
| Profile view | Shimmer placeholders | User expects content to fill in; short wait (750-920ms) |
| Thread / reply chain | Shimmer for missing parents | Conversations should look complete; fill gaps as relays respond |
| Search / archival | Relay progress counter | Longer waits (5-15s); counter sets expectations |
| Hybrid outbox feed | Banner for outbox layer | App relay events show instantly; banner for outbox additions |

These patterns are proven at scale: Twitter uses the banner for timeline updates, Facebook and LinkedIn use shimmer for profile/card loading, and Slack/Confluence use progress counters for federated search. The nostr multi-relay model maps directly to the federated search model — you're querying N independent sources and progressively merging results.

### 5. Cap at 20 connections

All algorithms reach within 1-2% of their unlimited ceiling by 20
connections. Greedy at 10 already achieves 93-97% of its unlimited coverage.

### 6. Target 2-3 relays per author

1 relay = fragile (relay goes down or silently drops a write, you lose events).
2 = redundancy. 3+ = diminishing returns. 7 of 9 implementations with
per-pubkey limits default to 2 or 3.

### 7. Handle missing relay lists gracefully

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

### 8. Diversify bootstrap relays

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
