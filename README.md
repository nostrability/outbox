# Outbox Model: What Actually Works

## If you read nothing else

1. **Filter dead relays first** ([NIP-66](https://github.com/nostr-protocol/nips/blob/master/66.md)) — 40-66% of declared relays are dead. Removing them stops you wasting connection budget on relays that will never respond (success rate goes from ~30% to ~75%). Zero algorithmic changes needed.
2. **Add randomness to relay selection** — deterministic algorithms (greedy set-cover) pick the same popular relays every time. Those relays prune old events. Stochastic selection discovers relays that keep history. 1.5× better recall at 1 year across 6 profiles.
3. **Learn from what relays actually return** — no client tracks "did this relay deliver events?" Track it, feed it back into selection, and your relay picks improve by 60-70pp after 2-3 sessions ([Thompson Sampling](#thompson-sampling)).

## What each step buys you

Each technique adds incremental value. You don't need to implement everything at once:

| Step | What you do | 1yr recall | 7d recall | Effort |
|:---:|---|:---:|:---:|---|
| 0 | **Hardcode big relays** (damus + nos.lol) | 8% | 61% | Zero |
| 1 | **Basic outbox** (greedy set-cover from NIP-65 data) | 16% | 84% | Medium — ~200 LOC, fetch relay lists + implement set-cover |
| 2 | **Stochastic scoring** (Welshman's `random()` factor) | 24% | 83% | Low — ~50 LOC, replace greedy with weighted random |
| 3 | **Filter dead relays** (NIP-66 liveness data) | neutral | +5pp efficiency | Low — ~30 LOC, fetch kind 30166, exclude dead relays |
| 4 | **Learn from delivery** (Thompson Sampling) | 81% | 92% | Low — ~80 LOC + DB table, replace `random()` with `sampleBeta()` |

*Step 2 is an alternative to Step 1 — replace greedy with stochastic, don't stack them. Steps 3 (NIP-66 filtering) and 4 (Thompson Sampling) are incremental enhancements that apply to either Step 1 or Step 2. Going from Step 0 to Step 4 takes your 1yr recall from 8% to 81% (and 7d from 61% to 92%). All values are 6-profile means except Thompson (4-profile mean, 5 learning sessions). 1yr recall is the more informative metric — 7d masks relay retention problems that dominate real-world performance.*

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
| **Nothing yet** | 0 | Start with big relays (damus + nos.lol), then add basic outbox | [IMPLEMENTATION-GUIDE.md](IMPLEMENTATION-GUIDE.md) |

*Each link goes to a per-client cheat sheet with specific code paths, current behavior, and upgrade recommendations.*

## The problem in one sentence

Your relay picker optimizes for "who publishes where" on paper, but the relay that *should* have the event often doesn't — due to retention policies, downtime, silent write failures, or auth restrictions.

## What we tested

17 relay selection algorithms (8 extracted from real clients, 9 experimental), tested against 6 real Nostr profiles (194-2,784 follows), across 6 time windows (7 days to 3 years), with and without NIP-66 liveness filtering. Every algorithm connected to real relays and queried for real events.

Full methodology: [OUTBOX-REPORT.md](OUTBOX-REPORT.md) | Reproduce results: [Benchmark-recreation.md](Benchmark-recreation.md) | Produced for [nostrability#69](https://github.com/niclas-pfeifer/nostrability/issues/69)

*Benchmark data collected February 2026. Relay state changes continuously — relative algorithm rankings should be stable; absolute recall percentages will vary on re-run.*

## What matters for app devs

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

### 3. Randomness > determinism for anything beyond real-time

At 1 year, greedy set-cover gets only 16% event recall. Welshman's stochastic scoring (`quality * (1 + log(weight)) * random()`) gets 24% — 1.5× better. Filter Decomposition (rust-nostr) does even better at 25% by preserving per-author relay diversity. (All 6-profile means.) Why? Relays prune old events to manage storage, and popular high-volume relays prune more aggressively. A few prolific authors produce most events (mean/median ratio: 7.6:1 at 3 years) — greedy concentrates on popular relays where many authors publish, but those relays can't retain the high-volume output. Stochastic selection discovers smaller relays that keep history longer. At 7 days all algorithms cluster at 83-84% — the differences only emerge at longer windows. Note: stochastic results have meaningful run-to-run variance (±2–8pp depending on profile size) — the advantage is real but noisy on any single run.

**What to do:** If you use greedy set-cover, switch to stochastic scoring. If you already use Welshman, upgrade to Thompson Sampling for even better results. Don't optimize purely for "covers the most authors" — factor in whether the relay actually retains events long-term.

### 4. 20 relay connections is enough — relay history is the real ceiling

All algorithms reach within 1-2% of their unlimited ceiling at 20 relays. NIP-65 adoption is not the bottleneck — only ~3-5% of active users lack relay lists ([dead account analysis](bench/NIP66-COMPARISON-REPORT.md#5-dead-account-analysis) shows the raw 20-44% "missing" rate is mostly accounts with no posts in 2+ years).

The real ceiling is **historical relay discovery**: relays retain 77% of events at 1 year, but algorithms only achieve 24% recall — because NIP-65 lists reflect where users write *now*, not where they wrote a year ago. See [issue #21](https://github.com/nostrability/outbox/issues/21) for the full analysis and proposed protocol-level fixes.

**What to do:** Cap at 20 connections. For the ~3-5% of active follows without relay lists, use fallback strategies (relay hints from tags, indexer queries, hardcoded popular relays).

## Algorithm quick reference

All deployed client algorithms plus key experimental ones:

| Algorithm | Used by | 1yr recall | 7d recall | Verdict |
|---|---|:---:|:---:|---|
| **Welshman+Thompson** | *not yet deployed* | 81% | 92% | Upgrade path for Coracle — learns from delivery |
| **FD+Thompson** | *not yet deployed* | 32% | 97% | Upgrade path for rust-nostr — +38% over baseline FD from learning |
| **Filter Decomposition** | rust-nostr | 25% | 77% | Per-author top-N write relays; strong at long windows |
| **Welshman Stochastic** | Coracle | 24% | 83% | Best stateless deployed algorithm for archival — 1.5× Greedy at 1yr |
| **Greedy Set-Cover** | Gossip, Applesauce, Wisp | 16% | 84% | Best on-paper coverage; degrades sharply for history |
| **NDK Priority** | NDK | 16% | 83% | Similar to Greedy; connected > selected > popular |
| **Coverage Sort** | Nostur | 16% | 65% | Skip-top-relays heuristic costs 5-12% coverage |

**Baselines** (for comparison, not recommendations):

| Baseline | 1yr recall | 7d recall | What it is |
|---|:---:|:---:|---|
| Direct Mapping\*\* | 30% | 88% | All declared write relays — unlimited connections |
| Big Relays | 8% | 61% | Just damus+nos.lol — the "do nothing" baseline |
| Primal Aggregator\*\*\* | 1% | 32% | Single caching relay — 100% assignment but low actual recall |

*1yr and 7d recall: 6-profile means from cross-profile benchmarks (Section 8.2 of [OUTBOX-REPORT.md](OUTBOX-REPORT.md)). All testable-reliable authors, 20-connection cap except Direct Mapping. Thompson = 4-profile mean with NIP-66, 5 learning sessions. FD+Thompson = 4-profile single-run mean (32% 1yr vs baseline FD's 23% = +38% relative improvement from learning). Stochastic algorithms have run-to-run variance of ±2–8pp depending on profile size (see [variance analysis](OUTBOX-REPORT.md#82-approximating-real-world-conditions-event-verification)).*

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

**1yr cross-profile results (cap@20, single run):**

| Profile (follows) | FD+Thompson | Filter Decomp (baseline) | Gain |
|---|:---:|:---:|:---:|
| fiatjaf (194) | **39.0%** | 25.5% | +13.5pp (+53%) |
| Gato (399) | **20.6%** | 13.1% | +7.5pp (+57%) |
| ODELL (1,079) | **29.1%** | 21.6% | +7.5pp (+35%) |
| Telluride (2,747) | **38.6%** | 32.3% | +6.3pp (+20%) |
| **4-profile mean** | **31.8%** | **23.1%** | **+8.7pp (+38%)** |

*FD+Thompson adds +8.7pp event recall on average from a single session of learning. The gain is largest on small graphs where lexicographic ordering wastes slots on pruning-heavy relays. Welshman+Thompson is competitive at larger follow counts where the popularity signal helps — see [Section 8.4](OUTBOX-REPORT.md#84-fdthompson-filter-decomposition-with-thompson-sampling) for the full comparison.*

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
