# Outbox Model: What Actually Works

The relay that "should" have the event often doesn't — due to retention, downtime, silent write failures, or auth restrictions. We tested 27 relay selection algorithms against 12 real profiles to find what actually works.

**Full report:** [OUTBOX-REPORT.md](OUTBOX-REPORT.md) | **Code examples:** [IMPLEMENTATION-GUIDE.md](IMPLEMENTATION-GUIDE.md) | **Reproduce results:** [Benchmark-recreation.md](Benchmark-recreation.md) | **Parent issue:** [nostrability#69](https://github.com/nostrability/nostrability/issues/69)

## Using a client library? Start here.

| If you use… | You're at step… | Next upgrade | Details |
|---|:---:|---|---|
| **Welshman/Coracle** | Stochastic scoring | Add Thompson Sampling — +9pp at 1yr (paired); cross-profile baseline ~24% | [cheat sheet](analysis/clients/welshman-coracle.md) |
| **NDK** | Priority-based | Add NDK+Thompson CG3 — ~16% → ~27% (65% increase), fixes fiatjaf regression | [cheat sheet](analysis/clients/ndk-applesauce-nostrudel.md) |
| **Applesauce/noStrudel** | Greedy set-cover | Stochastic scoring then Thompson — ~16% → ~40% (140% increase), two steps | [cheat sheet](analysis/clients/ndk-applesauce-nostrudel.md) |
| **Gossip** | Greedy set-cover | Stochastic scoring then Thompson — ~16% → ~40% (140% increase), two steps | [cheat sheet](analysis/clients/gossip.md) |
| **rust-nostr** | Filter decomposition | Add FD+Thompson — ~25% → ~37% (50% increase) | [cheat sheet](analysis/clients/rust-nostr-voyage-nosotros-wisp-shopstr.md) |
| **Amethyst** | Direct mapping | Add NIP-66 filtering — cuts load time by ~45% | [cheat sheet](analysis/clients/amethyst.md) |
| **Nostur** | Coverage sort | Remove skipTopRelays, add stochastic factor — recovers 5–12% lost coverage | [cheat sheet](analysis/clients/nostur-yakihonne-notedeck.md) |
| **Ditto-Mew** | 4 app relays | Add hybrid outbox — ~10% → ~23% (130% increase), ~80 LOC | [details below](#full-outbox-vs-hybrid-outbox) |
| **Nothing yet** | — | Start with hybrid outbox or big relays, then add full outbox when ready | [IMPLEMENTATION-GUIDE.md](IMPLEMENTATION-GUIDE.md) |

## If you're building from scratch

- **Filter dead relays** ([NIP-66](https://github.com/nostr-protocol/nips/blob/master/66.md)) — nearly half of declared relays are offline. Removing them halves your load time.
- **Add randomness** — deterministic algorithms pick the same popular relays that prune old events. Stochastic selection finds ~50% more events at 1yr.
- **Learn from delivery** (Thompson Sampling) — track which relays actually return events and feed it back. +9pp at 1yr (~30% → ~39%, paired benchmark), ~80 LOC.
- **EOSE-race with 2s grace** — query 20 relays in parallel, stop 2s after the first finishes. 86–99% completeness in under 3s.

## What each step buys you

| Step | What you do | 1yr recall | Effort |
|:---:|---|:---:|---|
| 0 | **Hardcode big relays** (damus + nos.lol) | ~8% | Zero |
| 1a | **Basic outbox** (greedy set-cover from NIP-65) | ~16% | Medium — ~200 LOC |
| 1b | **Hybrid outbox** (keep app relays + add author write relays) | ~23% | Low — ~80 LOC |
| 2 | **Stochastic scoring** (Welshman's random factor) | ~24% | Low — ~50 LOC |
| 3 | **Filter dead relays** (NIP-66 liveness) | neutral recall, −45% latency | Low — ~30 LOC |
| 4 | **Learn from delivery** (Thompson Sampling) | ~40% | Low — ~80 LOC + DB table |
| 4+ | **Learn relay speed** (latency discount) | same recall, faster feed fill | 1 line on top of Step 4 |

Steps 1a/1b are alternative entry points. 1a replaces your routing layer, 1b augments it. Steps 2–4 are incremental on the 1a (full outbox) path. The 1b (hybrid) path gets Thompson Sampling directly — see [Hybrid+Thompson](OUTBOX-REPORT.md#85-hybrid-outbox-app-relay-broadcast--per-author-thompson) for gains on that path. See [OUTBOX-REPORT.md](OUTBOX-REPORT.md) for per-profile data and methodology.

## Full outbox vs hybrid outbox

<details>
<summary>Expand comparison</summary>

**Full outbox** — replace your relay selection layer. Route queries to each author's NIP-65 write relays. Used by Welshman/Coracle, rust-nostr, NDK, Gossip.

**Hybrid outbox** — keep app relays for the main feed, add outbox queries for profile views, event lookups, and threads. ~80 LOC, no routing layer changes.

| | Full outbox | Hybrid outbox |
|---|---|---|
| **1yr recall** | ~40% | ~23% |
| **Feed latency** | Depends on per-author relay quality | Unchanged (app relays) |
| **What changes** | Routing layer | Individual hooks (profile, event, thread) |
| **Connections** | 20+ (budgeted across follows) | 4 app relays + 3 per viewed profile |
| **Engineering effort** | ~200–500 LOC | ~80 LOC |
| **Best for** | Clients building relay routing from scratch | Clients with fixed app relays |

**Decision tree:**

```text
Do you have a routing layer that selects relays per-author?
├─ Yes → Add Thompson Sampling to it (Step 4)
│
└─ No (fixed app relays / broadcast)
   ├─ Can you rewrite your routing layer?
   │  └─ Yes → Implement full outbox (Step 1a → Step 4)
   │
   └─ No, or need to preserve feed latency?
      └─ Add hybrid outbox (Step 1b) — ~80 LOC, no routing changes
```

</details>

<details>
<summary>Algorithm quick reference (27 algorithms)</summary>

**Deployed in clients:**

| Algorithm | Used by | 1yr recall | 7d recall | Verdict |
|---|---|:---:|:---:|---|
| **Welshman+Thompson** | *not yet deployed* | ~40% | ~83% | Upgrade path for Coracle — learns from delivery |
| **FD+Thompson** | *not yet deployed* | ~37% | ~84% | Upgrade path for rust-nostr — learns from delivery |
| **Hybrid+Thompson** | *not yet deployed* | ~23% | — | Upgrade path for app-relay clients |
| **Filter Decomposition** | rust-nostr | ~25% | ~77% | Per-author top-N write relays |
| **Welshman Stochastic** | Coracle | ~24% | ~83% | Best stateless deployed algorithm |
| **Greedy Set-Cover** | Gossip, Applesauce, Wisp | ~16% | ~84% | Best on-paper coverage; degrades for history |
| **NDK+Thompson CG3** | *not yet deployed* | ~27% | — | Recommended NDK variant — fixes regressions |
| **NDK Priority** | NDK | ~16% | ~83% | Similar to Greedy |
| **Coverage Sort** | Nostur | ~16% | ~65% | skipTopRelays costs 5–12% coverage |

**Baselines:**

| Baseline | 1yr recall | 7d recall | What it is |
|---|:---:|:---:|---|
| Direct Mapping | ~30% | ~88% | All declared write relays — unlimited connections |
| Ditto-Mew | ~6% | ~62% | 4 hardcoded app relays |
| Big Relays | ~8% | ~61% | Just damus + nos.lol |

All values are 6-profile means. See [OUTBOX-REPORT.md § 8](OUTBOX-REPORT.md#8-benchmark-results) for per-profile data, confidence intervals, and the full 25-algorithm table.

</details>

<details>
<summary>Key findings detail</summary>

**1. Learning beats static optimization.** Greedy set-cover (Gossip, Applesauce) picks the "best" relays on paper but never learns whether they actually deliver. Thompson Sampling tracks delivery and reaches ~40% at 1yr vs ~16% for greedy. [Report § 8.2](OUTBOX-REPORT.md#82-approximating-real-world-conditions-event-verification)

**2. Dead relay filtering saves your connection budget.** Nearly half of declared relays are offline. NIP-66 filtering removes them, cutting load time by 45% (protocol-level benchmark — see [Benchmark-recreation.md](Benchmark-recreation.md#nip-66-liveness-comparison) for methodology). Recall impact is roughly neutral. [Report § 5.3](OUTBOX-REPORT.md#53-misconfigured-relay-lists)

**3. Per-author relay diversity beats popularity.** Algorithms that give each author their own relay picks (Filter Decomposition, Welshman stochastic) find 1.5× more events at 1yr than popularity-based selection. [Report § 8.2](OUTBOX-REPORT.md#82-approximating-real-world-conditions-event-verification)

**4. EOSE-race with 2s grace is the latency sweet spot.** First event arrives in 530–670ms regardless of algorithm. At +2s grace, you have 86–99% of events. [Report § 8.17](OUTBOX-REPORT.md#817-latency-simulation)

**5. Latency-aware scoring helps small follow graphs.** A 1-line latency discount gives +10pp completeness at 2s for <500 follows, with negligible recall cost. Steep tradeoff for 1000+ follows. [Report § 8.16](OUTBOX-REPORT.md#816-latency-aware-thompson-sampling)

**6. 20 relay connections is enough for most users.** Small graphs saturate at 10–15 relays. Medium graphs benefit from 20. Beyond 20 shows diminishing returns. [Report § 8.13](OUTBOX-REPORT.md#813-adaptive-connection-limits)

</details>

## How to implement

See **[IMPLEMENTATION-GUIDE.md](IMPLEMENTATION-GUIDE.md)** for Thompson Sampling, hybrid outbox, NIP-66 filtering, FD+Thompson, and latency-aware scoring — all with code examples and integration guides.

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

# Multi-session Thompson Sampling (5 learning sessions)
bash run-benchmark-batch.sh
```

Run `deno task bench --help` for all options. See [Benchmark-recreation.md](Benchmark-recreation.md) for full reproduction instructions.

## Help wanted: benchmark from your location

All data was collected from a single observer. Relay latency and success rates are location-dependent. We need runs from different locations to validate generalizability.

**What to run** (~30 min, needs Deno v2+):

```bash
cd bench
deno task bench 3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d \
  --verify --verify-window 604800 \
  --nip66-filter liveness --no-phase2-cache \
  --output both
```

**What to share:** Open an issue with your JSON file from `bench/results/`, your approximate location, and connection type.

<details>
<summary>Repo structure</summary>

```text
OUTBOX-REPORT.md              Full analysis report (methodology + all data)
IMPLEMENTATION-GUIDE.md       How to implement the recommendations above
Benchmark-recreation.md       Step-by-step reproduction instructions
bench/                        Benchmark tool (Deno/TypeScript)
  main.ts                     CLI entry point
  src/algorithms/             25 algorithm implementations (+2 latency-aware variants)
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

</details>

## Links

- [Full Analysis Report](OUTBOX-REPORT.md) — 15-client cross-analysis + complete benchmark data
- [Implementation Guide](IMPLEMENTATION-GUIDE.md) — Detailed recommendations with code examples
- [Cross-Client Comparison](analysis/cross-client-comparison.md) — How 15 clients make each decision
- [Benchmark Recreation](Benchmark-recreation.md) — Reproduce all results
- [nostrability#69](https://github.com/nostrability/nostrability/issues/69) — Parent issue
- [NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md) — Relay List Metadata specification
- [Building Nostr](https://building-nostr.coracle.social) — Protocol architecture guide
- [replicatr](https://github.com/coracle-social/replicatr) — Event replication daemon for relay list changes

*Benchmark data collected February 2026. Relay state changes continuously — relative algorithm rankings should be stable; absolute recall percentages will vary on re-run.*
