# Outbox Model: What Actually Works

## If you read nothing else

1. **Filter dead relays first** ([NIP-66](https://github.com/nostr-protocol/nips/blob/master/66.md)) — 40-66% of declared relays are dead. Removing them stops you wasting connection budget on relays that will never respond (success rate goes from ~30% to ~75%). Zero algorithmic changes needed.
2. **Add randomness to relay selection** — deterministic algorithms (greedy set-cover) pick the same popular relays every time. Those relays prune old events. Stochastic selection discovers relays that keep history. 2.5x better recall at 1 year.
3. **Learn from what relays actually return** — no client tracks "did this relay deliver events?" Track it, feed it back into selection, and your relay picks improve by 60-70pp after 2-3 sessions ([Thompson Sampling](#thompson-sampling)).

## The problem in one sentence

Your relay picker optimizes for "who publishes where" on paper, but the relay that *should* have the event often doesn't — due to retention policies, downtime, silent write failures, or auth restrictions.

## What we tested

16 relay selection algorithms (8 extracted from real clients, 8 experimental), tested against 4 real Nostr profiles (194-2,784 follows), across 3 time windows (7 days to 3 years), with and without NIP-66 liveness filtering. 120 benchmark runs total (4 profiles × 3 windows × 5 sessions × 2 NIP-66 modes). Assignment coverage was also tested across 26 profiles. Every algorithm connected to real relays and queried for real events.

Full methodology: [OUTBOX-REPORT.md](OUTBOX-REPORT.md) | Reproduce results: [Benchmark-recreation.md](Benchmark-recreation.md) | Produced for [nostrability#69](https://github.com/niclas-pfeifer/nostrability/issues/69)

## What matters for app devs

### 1. Learning beats static optimization

The relay that's "best on paper" isn't always the one that delivers events. Greedy set-cover (used by Gossip, Applesauce, Wisp) wins on-paper relay assignments but ranks 7th at actually retrieving events. This is inherent to the algorithm: greedy set-cover is a static, one-shot computation — it picks relays based on declared write lists and never learns whether those relays actually delivered.*

**What to do:** Track which relays return events. Feed that data back into selection. Thompson Sampling does this with a few dozen lines of code on top of Welshman/Coracle's existing algorithm ([code below](#thompson-sampling)).

*\*Greedy set-cover solves "which relays cover the most authors?" but the answer doesn't change between sessions. A relay that failed to deliver events last time gets picked again next time if it still covers the most authors on paper. Learning algorithms (Thompson, MAB) update their beliefs after each session.*

| Profile (follows) | Window | Before learning | After 2-3 sessions | Gain |
|---|---|---|---|---|
| Gato (399) | 1yr | 24.5% | 97.4% | **+72.9pp** |
| ValderDama (1,077) | 3yr | 20.4% | 91.0% | **+70.7pp** |
| Telluride (2,784) | 1yr | 33.1% | 92.6% | **+59.4pp** |

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

Greedy set-cover gets 93% event recall at 7 days but crashes to 16% at 1 year (fiatjaf profile). Why? Relays prune old events to manage storage, and popular high-volume relays prune more aggressively. Greedy concentrates on those popular relays — great for last week's posts, useless for last year's. Welshman's stochastic scoring (`quality * (1 + log(weight)) * random()`) gets 38% at 1 year — 2.3× better — by spreading queries across smaller relays that retain history longer.

**What to do:** If you use greedy set-cover, switch to stochastic scoring. If you already use Welshman, upgrade to Thompson Sampling for even better results.

### 4. 20 relay connections is enough — NIP-65 adoption is the real ceiling

All algorithms reach within 1-2% of their unlimited ceiling at 20 relays. Raw data shows 20-44% of follows have no relay list — but [dead account analysis](bench/NIP66-COMPARISON-REPORT.md#5-dead-account-analysis) reveals ~85% of those are accounts with no posts in 2+ years (or ever). The real NIP-65 adoption gap among active users is ~3-5%.

**What to do:** Cap at 20 connections. The "missing relay list" problem is smaller than it looks — most of it is dead accounts, not active users who forgot to publish NIP-65. For the ~3-5% of active follows without relay lists, use fallback strategies (relay hints from tags, indexer queries, hardcoded popular relays).

### 5. Event volume follows a power law — this is why stochastic wins

A few prolific authors produce most events (mean/median ratio: 7.6:1 at 3 years). Greedy concentrates on popular relays where many authors publish, but those relays may not retain the high-volume output of prolific posters. Stochastic approaches discover the relays that do.

**What to do:** Don't optimize purely for "covers the most authors." Factor in whether the relay actually retains events long-term.

## What each step buys you

Each technique adds incremental value. You don't need to implement everything at once:

| Step | What you do | 7d recall | 1yr recall | Effort |
|:---:|---|:---:|:---:|---|
| 0 | **Hardcode big relays** (damus + nos.lol) | 61% | 5% | Zero |
| 1 | **Basic outbox** (greedy set-cover from NIP-65 data) | 84% | 16% | Medium — fetch relay lists, implement set-cover |
| 2 | **Stochastic scoring** (Welshman's `random()` factor) | 83% | 38% | Low — replace greedy with weighted random |
| 3 | **Filter dead relays** (NIP-66 liveness data) | +5pp efficiency | neutral | Low — fetch kind 30166, exclude dead relays |
| 4 | **Learn from delivery** (Thompson Sampling) | 92% | 81% | Low — track per-relay stats, replace `random()` with `sampleBeta()` |

*Steps 2→4 are incremental — each builds on the previous. Step 3 (NIP-66) can be added at any point. Going from step 0 to step 4 takes your 7d recall from 61% to 92% and your 1yr recall from near-zero to 81%.*

## Algorithm quick reference

All deployed client algorithms plus key experimental ones:

| Algorithm | Used by | 7d recall | 1yr recall | Verdict |
|---|---|:---:|:---:|---|
| **Greedy Set-Cover** | Gossip, Applesauce, Wisp | 84% | 16% | Best on-paper coverage; degrades sharply for history |
| **NDK Priority** | NDK | 83% | 19% | Similar to Greedy; connected > selected > popular |
| **Welshman Stochastic** | Coracle | 83% | 38% | Best deployed client for archival — 2.3× Greedy at 1yr |
| **Coverage Sort** | Nostur | 65% | 13% | Skip-top-relays heuristic costs 5-12% coverage |
| **Filter Decomposition** | rust-nostr | 77% | 19% | Per-author top-N write relays |
| **Direct Mapping**\*\* | Amethyst (feeds) | 88% | 17% | All declared write relays — high recall but unlimited connections |
| **Welshman+Thompson** | *not yet deployed* | 92% | 81% | Upgrade path for Coracle — learns from delivery |
| **Big Relays** | *common default* | 61% | 5% | Just damus+nos.lol — the "do nothing" baseline |
| **Primal Aggregator** | Primal | 32% | 2% | Centralized — 100% assignment but low actual recall |

*7d recall: 6-profile mean from cross-profile benchmarks. 1yr recall: fiatjaf single-profile (Section 8.2 of [OUTBOX-REPORT.md](OUTBOX-REPORT.md)). All testable-reliable authors, 20-connection cap except Direct Mapping. Thompson = 4-profile mean with NIP-66, 5 learning sessions. Big Relays/Primal 7d = 6-profile mean without NIP-66.*

*\*\*Direct Mapping uses unlimited connections (all declared write relays, typically 50-200+). All other algorithms capped at 20. Its high 7d recall reflects connection count, not algorithmic superiority.*

<details>
<summary>All 16 algorithms</summary>

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

Replace `random()` in Welshman's scoring with `sampleBeta(successes, failures)` per relay. This keeps the beneficial randomness, adds learning, and is a few dozen lines of code:

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
  src/algorithms/             16 algorithm implementations
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
