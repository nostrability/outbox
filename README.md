# Outbox Model: What Actually Works

## If you read nothing else

1. **Filter dead relays first** ([NIP-66](https://github.com/nostr-protocol/nips/blob/master/66.md)) — only 37% of relay-user pairs in NIP-65 lists point to normal content relays ([NIP-11 survey](#relay-list-pollution-is-worse-than-expected)). The rest are offline, paid, restricted, or missing. Removing them stops you wasting connection budget on relays that will never respond (success rate goes from ~30% to ~75%). Zero algorithmic changes needed.
2. **Add randomness to relay selection** — deterministic algorithms (greedy set-cover) pick the same popular relays every time. Those relays prune old events. Stochastic selection discovers relays that keep history. 1.5× better recall at 1 year across 6 profiles.
3. **Learn from what relays actually return** — no client tracks "did this relay deliver events?" Track it, feed it back into selection, and your relay picks improve by 60-70pp after 2-3 sessions ([Thompson Sampling](#thompson-sampling)).

## What each step buys you

Each technique adds incremental value. You don't need to implement everything at once:

| Step | What you do | 1yr recall | 7d recall | Effort |
|:---:|---|:---:|:---:|---|
| 0 | **Hardcode big relays** (damus + nos.lol) | 8% [5–12] | 61% [45–70] | Zero |
| 1a | **Basic outbox** (greedy set-cover from NIP-65 data) | 16% [12–20] | 84% [77–94] | Medium — ~200 LOC, fetch relay lists + implement set-cover |
| 1b | **Hybrid outbox** (keep app relays + add author write relays for profiles/threads) | 89% [86–93] | — | Low — ~80 LOC, no routing layer changes ([details](#two-ways-to-add-outbox)) |
| 2 | **Stochastic scoring** (Welshman's `random()` factor) | 24% [12–38] | 83% [75–93] | Low — ~50 LOC, replace greedy with weighted random |
| 3 | **Filter dead relays** (NIP-66 liveness data) | neutral | +5pp efficiency | Low — ~30 LOC, fetch kind 30166, exclude dead relays |
| 4 | **Learn from delivery** (Thompson Sampling) | 84-89% [75–96] | 92% | Low — ~80 LOC + DB table, replace `random()` with `sampleBeta()` |

*Steps 1a and 1b are alternative entry points — 1a replaces your routing layer, 1b augments it. Step 1b already includes Thompson Sampling (it's the same ~80 LOC). Steps 2-4 are incremental enhancements that apply to the 1a path. Going from Step 0 to Step 4 takes your 1yr recall from 8% to 84-89% (and 7d from 61% to 92%). [min–max] ranges show the spread across tested profiles — your recall depends on your follow graph size and relay diversity. All values are 6-profile means except Thompson variants (4-profile mean with NIP-66, 5 learning sessions; FD+Thompson=84%, Welshman+Thompson=89%, Hybrid+Thompson=89%). 1yr recall is the more informative metric — 7d masks relay retention problems that dominate real-world performance.*

## Already using a client library?

If you're building on an existing library, here's where you stand and what to do next:

| If you use… | You're at step… | Next upgrade | Details |
|---|:---:|---|---|
| **Welshman/Coracle** | 2 (stochastic) | Add Thompson Sampling — replace `random()` with `sampleBeta()` | [analysis/clients/welshman-coracle.md](analysis/clients/welshman-coracle.md) |
| **NDK** | 1 (priority-based) | Add stochastic factor, then Thompson | [analysis/clients/ndk-applesauce-nostrudel.md](analysis/clients/ndk-applesauce-nostrudel.md) |
| **Applesauce/noStrudel** | 1 (greedy set-cover) | Add stochastic factor, then Thompson | [analysis/clients/ndk-applesauce-nostrudel.md](analysis/clients/ndk-applesauce-nostrudel.md) |
| **Gossip** | 1 (greedy set-cover) | Add stochastic factor or Thompson | [analysis/clients/gossip.md](analysis/clients/gossip.md) |
| **rust-nostr** | 1 (filter decomp) | Add FD+Thompson — same per-author structure, learns from delivery | [analysis/clients/rust-nostr-voyage-nosotros-wisp-shopstr.md](analysis/clients/rust-nostr-voyage-nosotros-wisp-shopstr.md) |
| **Amethyst** | 1 (direct mapping) | Add NIP-66 filtering — unlimited connections already give high recall | [analysis/clients/amethyst.md](analysis/clients/amethyst.md) |
| **Nostur** | 1 (coverage sort) | Remove skipTopRelays, add stochastic factor | [analysis/clients/nostur-yakihonne-notedeck.md](analysis/clients/nostur-yakihonne-notedeck.md) |
| **Ditto-Mew** | 0 (4 app relays) | Add hybrid outbox — keep app relays, add author write relays for profiles/threads | [details below](#two-ways-to-add-outbox) |
| **Nothing yet** | 0 | Start with hybrid outbox or big relays, then add full outbox when ready | [IMPLEMENTATION-GUIDE.md](IMPLEMENTATION-GUIDE.md) |

*Each link goes to a per-client cheat sheet with specific code paths, current behavior, and upgrade recommendations.*

## The problem in one sentence

Your relay picker optimizes for "who publishes where" on paper, but the relay that *should* have the event often doesn't — due to retention policies, downtime, silent write failures, or auth restrictions.

## What we tested

17 relay selection algorithms (8 extracted from real clients, 9 experimental), tested against 6 real Nostr profiles (194-2,784 follows), across 6 time windows (7 days to 3 years), with and without NIP-66 liveness filtering. Every algorithm connected to real relays and queried for real events.

Full methodology: [OUTBOX-REPORT.md](OUTBOX-REPORT.md) | Reproduce results: [Benchmark-recreation.md](Benchmark-recreation.md) | Produced for [nostrability#69](https://github.com/niclas-pfeifer/nostrability/issues/69)

*Benchmark data collected February 2026. Relay state changes continuously — relative algorithm rankings should be stable; absolute recall percentages will vary on re-run.*

## What matters for app devs

### Two ways to add outbox

There are two architecturally distinct approaches to outbox routing. Both reach ~80-89% event recall at 1 year with Thompson Sampling, but they differ in where changes land and what tradeoffs they impose.

**Full outbox routing** — replace your relay selection layer. For each followed author, route queries to their NIP-65 write relays instead of broadcasting to a fixed relay set. This is what Welshman/Coracle, rust-nostr, NDK, and Gossip do.

**Hybrid outbox enrichment** — keep your existing relay infrastructure for the main feed and add parallel outbox queries only for long-tail paths: profile views, event lookups, and thread traversal. The main feed stays on your app relays (fast, predictable latency). Profile views additionally query the viewed author's write relays. Event lookups use relay hints and author write relays as fallback tiers.

| | Full outbox | Hybrid outbox |
|---|---|---|
| **1yr event recall** | 84-89% | 89% |
| **Main feed latency** | Depends on per-author relay quality | Unchanged (app relays) |
| **What changes** | Routing layer (NostrProvider / pool router) | Individual hooks (profile, event, thread) |
| **Connection count** | 20+ (capped budget shared across all follows) | 4 app relays + 3 per viewed profile |
| **Cold start** | Random relay selection (session 1) | Same as current app behavior (session 1) |
| **Engineering effort** | Rewrite relay routing (~200-500 LOC) | Add outbox queries to 3-4 hooks (~80 LOC) |
| **Best for** | Clients building relay routing from scratch, or with existing per-author routing | Clients with hardcoded app relays or fixed relay sets that can't change the feed path |

The 4.5pp gap between hybrid (89%) and full outbox (94%) at 1yr — measured in the [Section 8.5 head-to-head benchmark](OUTBOX-REPORT.md#85-hybrid-outbox-app-relay-broadcast--per-author-thompson) — comes from the full approach having more relay diversity in its 20-relay budget — every author's relays compete for the budget, surfacing niche relays that retain history. The hybrid approach queries fewer outbox relays per author (top 3) but compensates with the app relay safety net. Hybrid converges faster (session 2 vs session 3-4) because the app relay floor provides a strong initial signal.

**Decision tree:**

```text
Do you have a routing layer that selects relays per-author?
├─ Yes → Add Thompson Sampling to it (Step 4)
│        Welshman+Thompson: 89% 1yr | FD+Thompson: 84% 1yr
│
└─ No (fixed app relays / broadcast)
   │
   ├─ Can you rewrite your routing layer?
   │  └─ Yes → Implement full outbox (Step 1a → Step 4)
   │           Best recall, but biggest engineering investment
   │
   └─ No, or need to preserve feed latency guarantees?
      └─ Add hybrid outbox (Step 1b)
         89% 1yr recall, ~80 LOC, no routing layer changes
         Profile views: fetch author's kind 10002, query top 3 write relays in parallel
         Event lookups: rank relay hints by Thompson score, NIP-65 fallback
         Thread loading: propagate relay hints from e-tags
```

### 1. Learning beats static optimization

The relay that's "best on paper" isn't always the one that delivers events. Greedy set-cover (used by Gossip, Applesauce, Wisp) wins on-paper relay assignments but drops to 16% event recall at 1 year — while algorithms with randomness or per-author diversity reach 24-25%. This is inherent to the algorithm: greedy set-cover is a static, one-shot computation — it picks relays based on declared write lists and never learns whether those relays actually delivered.*

**What to do:** Track which relays return events. Feed that data back into selection. Thompson Sampling does this with ~80 lines of code on top of Welshman/Coracle's existing algorithm ([code below](#thompson-sampling)).

*\*Greedy set-cover solves "which relays cover the most authors?" but the answer doesn't change between sessions. A relay that failed to deliver events last time gets picked again next time if it still covers the most authors on paper. Learning algorithms (Thompson, MAB) update their beliefs after each session.*

| Profile (follows) | Window | Before learning | After 2-3 sessions | Gain |
|---|---|---|---|---|
| Gato (399) | 1yr | 24.5% | 97.4% | **+72.9pp** |
| ValderDama (1,077) | 3yr | 20.4% | 91.0% | **+70.7pp** |
| Telluride (2,784) | 1yr | 33.1% | 92.6% | **+59.4pp** |

*Note: Small profiles (<200 follows) may see minimal gains — the 20-relay budget already covers most combinations.*

### 2. Dead relay filtering saves your connection budget

NIP-66 publishes relay liveness data. Filtering out dead relays before running any algorithm means you stop wasting connections on relays that will never respond. The benefit is **efficiency** — fewer wasted slots in your 20-connection budget — not a coverage guarantee. Event recall impact is roughly neutral: stochastic algorithms gain ~+5pp, while Thompson Sampling and Greedy show negligible or slightly negative impact (likely noise from stochastic selection variance and intermittently available relays).

**What to do:** Fetch NIP-66 monitor data (kind 30166), classify relays as online/offline/dead, exclude dead ones before relay selection ([code below](#nip-66-pre-filter)).

| Profile (follows) | Relay success without NIP-66 | With NIP-66 | Relays removed |
|---|---|---|---|
| fiatjaf (194) | 56% | 87% | 93 (40%) |
| Gato (399) | 26% | 80% | 454 (66%) |
| Telluride (2,784) | 30% | 74% | 1,057 (64%) |

*Relay success rate = % of selected relays that actually respond to queries. This is an efficiency improvement (fewer wasted connections), not necessarily more events retrieved.*

**Speed impact:** Across 10 profiles (4,587 relay queries), NIP-66 pre-filtering reduces feed load time by 39% (40s → 24s). Dead relays each burn a 15-second timeout that blocks a concurrency slot from querying live relays.

**Relay list pollution is worse than expected.** NIP-11 probing across 36 profiles (13,867 relay-user pairs) shows only 37% of relay-user pairs point to normal content relays. The rest are offline (34%), missing NIP-11 (17%), paid (7%), restricted (4%), or auth-gated (0.5%). Nearly half of all unique relay URLs in NIP-65 lists are offline. The most common dead relays (`relay.nostr.band`, `nostr.orangepill.dev`, `nostr.zbd.gg`) appear in 32-34 of 36 tested profiles. See [Section 5.3](OUTBOX-REPORT.md#53-misconfigured-relay-lists) for the full NIP-11 classification breakdown.

### 3. Per-author relay diversity beats popularity-based selection

At 1 year, greedy set-cover gets only 16% event recall. Welshman's stochastic scoring gets 24% — 1.5× better. Filter Decomposition (rust-nostr, deterministic) does even better at 25%. (All 6-profile means.) The winning factor isn't randomness vs determinism — it's **relay diversity**. Algorithms that give each author their own relay picks (FD's per-author top-N, Welshman's random perturbation) discover small/niche relays that retain events well. Algorithms that concentrate on popular relays (greedy, popularity-weighted) fill the 20-relay budget with the same high-volume relays that prune old events aggressively. FD's median per-author recall (87.5% on ODELL/1,779 follows) vs Welshman's (50.0%) shows the effect: FD gives equitable coverage across authors, while popularity weighting gets high recall for authors on popular relays but zero for authors on niche ones. At 7 days all algorithms cluster at 83-84% — the differences only emerge at longer windows where relay retention diverges. Note: stochastic results have meaningful run-to-run variance (±2–8pp depending on profile size).

**What to do:** If you use greedy set-cover, switch to per-author relay selection (Filter Decomposition) or stochastic scoring (Welshman). Either way, upgrade to Thompson Sampling for the biggest gains — learning steers toward relays that actually deliver, regardless of popularity.

### 4. 20 relay connections is enough — relay history is the real ceiling

All algorithms reach within 1-2% of their unlimited ceiling at 20 relays. NIP-65 adoption is not the bottleneck — only ~3-5% of active users lack relay lists ([dead account analysis](bench/NIP66-COMPARISON-REPORT.md#5-dead-account-analysis) shows the raw 20-44% "missing" rate is mostly accounts with no posts in 2+ years).

The real ceiling is **historical relay discovery**: relays retain 77% of events at 1 year, but algorithms only achieve 24% recall — because NIP-65 lists reflect where users write *now*, not where they wrote a year ago. See [issue #21](https://github.com/nostrability/outbox/issues/21) for the full analysis and proposed protocol-level fixes.

**What to do:** Cap at 20 connections. For the ~3-5% of active follows without relay lists, use fallback strategies (relay hints from tags, indexer queries, hardcoded popular relays).

## Algorithm quick reference

All deployed client algorithms plus key experimental ones:

| Algorithm | Used by | 1yr recall | 7d recall | Verdict |
|---|---|:---:|:---:|---|
| **Welshman+Thompson** | *not yet deployed* | 89% [82–96] | 92% | Upgrade path for Coracle — learns from delivery |
| **FD+Thompson** | *not yet deployed* | 84% [75–92] | — | Upgrade path for rust-nostr — learns from delivery |
| **Hybrid+Thompson** | *not yet deployed* | 89% [86–93] | — | Upgrade path for app-relay clients — no routing changes |
| **Filter Decomposition** | rust-nostr | 25% [19–32] | 77% [71–88] | Per-author top-N write relays; strong at long windows |
| **Welshman Stochastic** | Coracle | 24% [12–38] | 83% [75–93] | Best stateless deployed algorithm for archival — 1.5× Greedy at 1yr |
| **Greedy Set-Cover** | Gossip, Applesauce, Wisp | 16% [12–20] | 84% [77–94] | Best on-paper coverage; degrades sharply for history |
| **NDK Priority** | NDK | 16% [12–19] | 83% [77–92] | Similar to Greedy; connected > selected > popular |
| **Coverage Sort** | Nostur | 16% [9–22] | 65% [55–80] | Skip-top-relays heuristic costs 5-12% coverage |

**Baselines** (for comparison, not recommendations):

| Baseline | 1yr recall | 7d recall | What it is |
|---|:---:|:---:|---|
| Direct Mapping\*\* | 30% [17–40] | 88% [86–91] | All declared write relays — unlimited connections |
| Ditto-Mew (4 app relays) | 6% [5–7] | 62% | 4 hardcoded app relays — broadcast, no per-author routing |
| Big Relays | 8% [5–12] | 61% [45–70] | Just damus+nos.lol — the "do nothing" baseline |
| Primal Aggregator\*\*\* | 1% [0.2–1.6] | 32% [25–37] | Single caching relay — 100% assignment but low actual recall |

*1yr and 7d recall: 6-profile means from cross-profile benchmarks (Section 8.2 of [OUTBOX-REPORT.md](OUTBOX-REPORT.md)). [min–max] ranges show the spread across tested profiles (194–1,779 follows) — your recall will land somewhere in this range depending on your follow graph. All testable-reliable authors, 20-connection cap except Direct Mapping. Thompson = 4-profile mean with NIP-66, 5 learning sessions (FD+Thompson=84%, Welshman+Thompson=89%, Hybrid+Thompson=89%). Welshman+Thompson 7d = 92% (4-profile mean, Section 8.3); FD+Thompson and Hybrid+Thompson were not benchmarked at 7d (—). All Thompson variants converge within 2-3 sessions. Hybrid converges by session 2. Stochastic algorithms have additional run-to-run variance on top of the cross-profile range (see [variance analysis](OUTBOX-REPORT.md#82-approximating-real-world-conditions-event-verification)). Ditto-Mew baseline = 4-profile mean with NIP-66.*

*\*\*Direct Mapping uses unlimited connections (all declared write relays, typically 50-200+). Its high recall reflects connection count, not algorithmic superiority.*

*\*\*\*Primal's low recall may reflect a benchmark methodology limitation (querying a caching aggregator as if it were a standard relay) rather than a definitive measure of aggregator quality. App devs using Primal should test against their own use cases.*

<details>
<summary>All 17 algorithms</summary>

**Deployed in clients:**

| Algorithm | Client | Strategy |
|---|---|---|
| Greedy Set-Cover | Gossip, Applesauce, Wisp | Iterative max-uncovered |
| Priority-Based | NDK | Connected > selected > popular |
| Weighted Stochastic | Welshman/Coracle | `quality * (1 + log(weight)) * random()` |
| Greedy Coverage Sort | Nostur | Sort by count, skip top 3 |
| Filter Decomposition | rust-nostr | Per-author top-N write relays |
| Direct Mapping | Amethyst (feeds) | All declared write relays |
| Primal Aggregator | Primal | Single aggregator relay |
| Popular+Random | — | Top popular + random fill |

**Experimental — actionable** (not yet in any client, but deployable):

| Algorithm | Strategy |
|---|---|
| Welshman+Thompson | Welshman scoring with `sampleBeta(α,β)` instead of `random()` — learns from delivery |
| FD+Thompson | Filter Decomposition scoring with `sampleBeta(α,β)` — learns without popularity bias |
| Hybrid+Thompson | App relays + per-author outbox (top 3 write relays by Thompson) — no routing layer changes |
| Greedy+ε-Explore | Greedy with 5% chance of picking a random relay instead of the best |

**Academic** (benchmark ceilings only — not practical for real clients):

| Algorithm | Strategy | Why not practical |
|---|---|---|
| ILP Optimal | Brute-force best answer | NP-hard, requires solver, exponential worst-case |
| MAB-UCB | 500 simulated rounds of explore/exploit | Too slow — defines ceiling, not shippable |
| Bipartite Matching | Weighted matching for hard-to-reach pubkeys | O(V²E), complex, marginal gains |
| Spectral Clustering | Eigendecomposition of relay-author matrix | Requires linear algebra library |
| Streaming Coverage | Single-pass submodular maximization | Marginal gains over simpler greedy |
| Stochastic Greedy | Random subset sampling per step | Worse than standard greedy at this scale |

**Full benchmark data:** [OUTBOX-REPORT.md Section 8](OUTBOX-REPORT.md#8-benchmark-results)

</details>

## How to implement

### Thompson Sampling

Replace `random()` in Welshman's scoring with `sampleBeta(successes, failures)` per relay. This keeps the beneficial randomness, adds learning, and is ~80 lines of code. **If you use rust-nostr/Filter Decomposition**, use [FD+Thompson](#fdthompson-for-rust-nostr) instead — same idea but without the popularity weight, which fits Filter Decomposition's per-author structure better.

```typescript
// Current Welshman (stateless):
const score = quality * (1 + Math.log(weight)) * Math.random();

// With Thompson Sampling (learns from delivery):
function sampleBeta(a: number, b: number): number {
  const x = gammaVariate(a);
  return x / (x + gammaVariate(b));
}
const alpha = stats.eventsDelivered + 1;  // successes + prior
const beta = stats.eventsExpected - stats.eventsDelivered + 1;  // failures + prior
const score = quality * (1 + Math.log(weight)) * sampleBeta(alpha, beta);
```

Track per-relay stats in a small table (~100 bytes per relay):

```sql
CREATE TABLE relay_stats (
  relay_url TEXT PRIMARY KEY,
  times_selected INTEGER DEFAULT 0,
  events_delivered INTEGER DEFAULT 0,
  events_expected INTEGER DEFAULT 0,
  last_selected_at INTEGER
);
```

The full integration loop:

```typescript
// On app startup:
const relayStats = await db.loadRelayStats(); // {relay → (delivered, expected)}

// When building a feed subscription:
function selectRelays(candidates: RelayCandidate[], budget: number): string[] {
  const scored = candidates.map(r => {
    const stats = relayStats.get(r.url) ?? { delivered: 0, expected: 0 };
    const alpha = stats.delivered + 1;  // Beta prior: successes + 1
    const beta = stats.expected - stats.delivered + 1;  // failures + 1
    return {
      url: r.url,
      score: r.quality * (1 + Math.log(r.weight)) * sampleBeta(alpha, beta)
    };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, budget).map(r => r.url);
}

// After receiving events, update stats:
function updateStats(selectedRelays: string[], eventsPerRelay: Map<string, number>) {
  for (const relay of selectedRelays) {
    const stats = relayStats.get(relay) ?? { delivered: 0, expected: 0 };
    const delivered = eventsPerRelay.get(relay) ?? 0;
    stats.delivered += delivered > 0 ? 1 : 0;  // binary: did it deliver anything?
    stats.expected += 1;
    relayStats.set(relay, stats);
  }
  db.saveRelayStats(relayStats);  // persist for next session
}
```

### FD+Thompson (for rust-nostr)

If you use Filter Decomposition (rust-nostr's `break_down_filter()`), FD+Thompson is a drop-in upgrade: score each author's write relays by `sampleBeta(α, β)` instead of lexicographic order. No popularity weight — the score is purely learned delivery performance:

```typescript
// Current Filter Decomposition (stateless):
// Sort write relays lexicographically, take top N
const selected = authorWriteRelays.sort().slice(0, writeLimit);

// With FD+Thompson (learns from delivery):
const scored = authorWriteRelays.map(relay => {
  const stats = relayStats.get(relay) ?? { delivered: 0, expected: 0 };
  const alpha = stats.delivered + 1;
  const beta = stats.expected - stats.delivered + 1;
  return { relay, score: sampleBeta(alpha, beta) };
});
const selected = scored.sort((a, b) => b.score - a.score)
  .slice(0, writeLimit).map(r => r.relay);
```

Same `sampleBeta()`, same stats table, same update loop as [Thompson Sampling above](#thompson-sampling). The only difference: no `(1 + Math.log(weight))` multiplier. This avoids biasing toward popular relays that many authors declare but that prune aggressively — scoring purely from observed delivery.

**1yr cross-profile results after 5 learning sessions (cap@20, NIP-66 filtered):**

| Profile (follows) | FD+Thompson | Welshman+Thompson | Gap |
|---|:---:|:---:|:---:|
| fiatjaf (194) | 75.1% | 82.0% | -6.9pp |
| Gato (399) | 91.9% | 95.5% | -3.6pp |
| ODELL (1,779) | 85.3% | 90.5% | -5.2pp |
| Telluride (2,784) | 83.4% | 89.5% | -6.1pp |
| **4-profile mean** | **83.9%** [75–92] | **89.4%** [82–96] | **-5.5pp** |

*Both algorithms converge within 2-3 sessions (FD+Thompson session 1 = 22%, session 3 = 80%, session 5 = 84%). Welshman+Thompson leads by 5-7pp at all profile sizes after convergence — the popularity weight provides a consistent advantage. See [Section 8.4](OUTBOX-REPORT.md#84-fdthompson-filter-decomposition-with-thompson-sampling) for the full comparison including session progression.*

### Hybrid outbox (for app-relay clients)

If your client uses a fixed set of app relays (like Ditto-Mew's 4 relays, or any client with hardcoded relay URLs), you can add outbox routing to profile views and event lookups without changing your feed routing. The app relays handle the main feed. Outbox relays handle long-tail content.

The pattern has three parts:

**1. Profile views** — when loading a user's profile, fetch their kind 10002 relay list, pick top 3 write relays by Thompson score, and query them in parallel with your app relays:

```typescript
// Profile feed: app relays (fast path) + outbox relays (parallel enrichment)
async function fetchProfileFeed(nostr, pubkey, filter) {
  // Fast path: query app relays as usual
  const appPromise = nostr.query([filter]);

  // Parallel: look up author's write relays, score, query top 3
  const outboxPromise = fetchOutboxEvents(nostr, pubkey, filter);

  const [appEvents, outboxEvents] = await Promise.all([appPromise, outboxPromise]);

  // Merge and deduplicate
  const seen = new Set();
  const merged = [];
  for (const ev of [...appEvents, ...outboxEvents]) {
    if (!seen.has(ev.id)) { seen.add(ev.id); merged.push(ev); }
  }
  return merged;
}

async function fetchOutboxEvents(nostr, pubkey, feedFilter) {
  const relayList = await nostr.query([{ kinds: [10002], authors: [pubkey], limit: 1 }]);
  if (!relayList.length) return [];

  const writeRelays = relayList[0].tags
    .filter(([name, , marker]) => name === 'r' && marker !== 'read')
    .map(([, url]) => url).filter(Boolean);

  const top3 = scorer.rank(writeRelays).slice(0, 3);
  const events = await nostr.group(top3).query([feedFilter]);

  for (const url of top3) scorer.update(url, events.length > 0);
  scorer.persist();
  return events;
}
```

**2. Event lookups** — rank relay hints and NIP-65 write relays by Thompson score before querying:

```typescript
// Tier 2: sort relay hints by Thompson score
const rankedHints = scorer.rank(relayHints);
const hintEvents = await nostr.group(rankedHints).query(filter);

// Tier 3: author's write relays, top 3 by Thompson
const writeRelays = extractWriteRelays(authorRelayList);
const ranked = scorer.rank(writeRelays);
const events = await nostr.group(ranked.slice(0, 3)).query(filter);
```

**3. Thread traversal** — propagate relay hints from `e` tags so each ancestor lookup uses the hint from the child event:

```typescript
// NIP-10 e-tag: ["e", <event-id>, <relay-url>, <marker>, <pubkey>]
const parentRef = getParentEventRef(event); // { id, relay?, author? }
// Pass relay hint and author hint to useEvent for the parent lookup
useEvent(parentRef.id, parentRef.relay ? [parentRef.relay] : undefined, parentRef.author);
```

**1yr benchmark results (4-profile mean, cap@20, NIP-66, 5 sessions):**

| | Ditto-Mew baseline | Hybrid+Thompson | Delta |
|---|--:|--:|--:|
| **Event recall** | 6.2% [5–7] | 89.4% [86–93] | **+83.2pp** |
| **Author recall** | 62.2% | 84.1% | **+21.9pp** |

*Hybrid+Thompson reaches within 4.5pp of Welshman+Thompson (93.9%) without any changes to the feed routing layer. Converges by session 2. See [OUTBOX-REPORT.md § 8.5](OUTBOX-REPORT.md#85-hybrid-outbox-app-relay-broadcast--per-author-thompson) for per-profile data and [bench/src/algorithms/ditto-outbox.ts](bench/src/algorithms/ditto-outbox.ts) for the benchmark implementation.*

### NIP-66 pre-filter

Fetch relay liveness from NIP-66 monitors and exclude dead relays before running your selection algorithm:

```typescript
// Fetch NIP-66 monitor data (kind 30166) and classify relays
async function filterLiveRelays(candidateRelays: string[]): Promise<string[]> {
  const monitorEvents = await pool.querySync(
    ["wss://relay.nostr.watch"], // NIP-66 monitor relay
    { kinds: [30166] }
  );
  const alive = new Set(monitorEvents.map(e => e.tags.find(t => t[0] === "d")?.[1]).filter(Boolean));
  return candidateRelays.filter(url => alive.has(url));
}

// Use it before any relay selection algorithm:
const liveRelays = await filterLiveRelays(allDeclaredRelays);
const selected = runYourAlgorithm(liveRelays, budget);
```

### Delivery check (self-healing)

Periodically verify that your outbox relays are actually returning events. When gaps are found, add fallback relays automatically:

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

## Running the benchmark

Prerequisites: [Deno](https://deno.com/) v2+

```bash
cd bench

# Assignment coverage (fast, no network after initial fetch)
deno task bench <npub_or_hex>

# Event retrieval — connects to real relays
deno task bench <npub_or_hex> --verify

# With NIP-66 liveness filter
deno task bench <npub_or_hex> --verify --nip66-filter liveness

# Specific algorithms
deno task bench <npub_or_hex> --algorithms greedy,welshman,welshman-thompson,mab

# Multi-session Thompson Sampling (5 learning sessions)
bash run-benchmark-batch.sh
```

Run `deno task bench --help` for all options. See [Benchmark-recreation.md](Benchmark-recreation.md) for full reproduction instructions.

## Repo structure

```text
OUTBOX-REPORT.md              Full analysis report (methodology + all data)
IMPLEMENTATION-GUIDE.md       How to implement the recommendations above
Benchmark-recreation.md       Step-by-step reproduction instructions
bench/                        Benchmark tool (Deno/TypeScript)
  main.ts                     CLI entry point
  src/algorithms/             17 algorithm implementations
  src/phase2/                 Event verification + baseline cache
  src/nip66/                  NIP-66 relay liveness filter
  src/relay-scores.ts         Thompson Sampling score persistence
  probe-nip11.ts              NIP-11 relay classification probe
  run-benchmark-batch.sh      Multi-session batch runner
  results/                    JSON benchmark outputs
analysis/
  clients/                    Per-client cheat sheets (6 files)
  cross-client-comparison.md  Cross-client comparison by decision point
```

## Links

- [Full Analysis Report](OUTBOX-REPORT.md) — 15-client cross-analysis + complete benchmark data
- [Implementation Guide](IMPLEMENTATION-GUIDE.md) — Detailed recommendations with code examples
- [Cross-Client Comparison](analysis/cross-client-comparison.md) — How 15 clients make each decision
- [Benchmark Recreation](Benchmark-recreation.md) — Reproduce all results
- [nostrability#69](https://github.com/niclas-pfeifer/nostrability/issues/69) — Parent issue
- [NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md) — Relay List Metadata specification
- [Building Nostr](https://building-nostr.coracle.social) — Protocol architecture guide (relay routing, content migration, bootstrapping)
- [replicatr](https://github.com/coracle-social/replicatr) — Event replication daemon for relay list changes (negentropy sync)
