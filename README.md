> **DRAFT** — This document is a work in progress. Findings and framing may change.

# Outbox Model Analysis

**How 15 Nostr clients implement NIP-65 relay routing — and which algorithms actually work best.**

Produced for [nostrability#69](https://github.com/niclas-pfeifer/nostrability/issues/69).

This repo contains a cross-client analysis of outbox model implementations across 5 languages (Rust, TypeScript, Kotlin, Swift, Dart), plus a benchmark suite that tests 14 relay selection algorithms against real-world follow lists and NIP-65 data. The goal: give Nostr developers empirical grounding for relay selection design decisions.

## Key Findings

**From benchmarking 14 algorithms against real relays (6 profiles, 8 time windows):**

1. **The best relay-mapping algorithm ranks 7th at actually retrieving events.** Greedy set-cover (used by Gossip, Applesauce, Wisp) produces the best on-paper relay assignments — but when we connected to real relays and queried for real events, it ranked 7th of 14 (84% mean recall at 7d vs 92% for Streaming Coverage). Relays that *should* have an event often don't, due to retention policies, downtime, or access restrictions.
2. **Event recall degrades sharply over time — and algorithms diverge.** At 7 days, most algorithms retrieve 83–98% of events. At 1 year, greedy set-cover drops to 16% while stochastic approaches (Welshman: 38%, MAB-UCB: 41%) retain 2–2.5x more. The algorithm that's best for recent feeds may be worst for history.
3. **20 connections is nearly sufficient.** All algorithms reach within 1–2% of their unlimited ceiling at 20 relays. Greedy at 10 already achieves 93–97% of its unlimited coverage.
4. **NIP-65 adoption is the real bottleneck.** The gap between the best algorithm and the theoretical ceiling is 1–3%. But 20–44% of follows have no relay list at all. More NIP-65 adoption helps far more than better algorithms.
5. **Concentration is the tradeoff.** Greedy maps the most follows to relays on paper by concentrating on a few popular relays (Gini 0.77) — but those relays don't always retain events long-term. Stochastic approaches spread queries across more relays (Gini 0.39–0.51), which costs some assignment coverage but discovers relays that keep older posts.

**From the implementation analysis (15 clients):**

6. **Three independent codebases converged on greedy set-cover** (Gossip/Rust, Applesauce/TypeScript, Wisp/Kotlin). It wins on-paper relay assignment 23 of 26 profiles, but real-world event recall tells a different story (see #1).
7. **Only Welshman uses randomness in relay selection** — and it accidentally has the best archival recall among deployed clients (38% at 1yr vs greedy's 16%).
8. **No client measures whether you actually received an author's events.** noStrudel shows relay assignment coverage, but no client tracks event recall — the metric that matters most.

## How the Benchmark Works

No apps are involved. The benchmark is a standalone Deno tool ([bench/](bench/)) that reimplements relay selection logic extracted from client source code, then tests it against real data.

The core problem is [maximum coverage](https://en.wikipedia.org/wiki/Maximum_coverage_problem): each relay "covers" the authors who publish there. Given a budget of K connections, pick the K relays that cover the most authors. This is NP-hard, which is why 3 clients independently converged on the standard greedy approximation.

1. **Fetch real data.** Given a pubkey, pull their follow list and every followed user's kind 10002 relay list from indexer relays.
2. **Run 14 relay selection algorithms.** Each answers: "given a budget of K connections, which relays should I open to see posts from the most follows?" 8 are reimplemented from real client codebases (Gossip, NDK, Welshman, Nostur, rust-nostr, Amethyst, Wisp, Primal). 6 are standard CS optimization techniques adapted to the same problem.
3. **Phase 1 — assignment coverage (no network).** If every relay were perfectly online and kept every event forever, how many of your follows would be reachable from the relays this algorithm picked? Pure math on NIP-65 data — no WebSocket is ever opened.
4. **Phase 2 — event recall (connects to real relays).** Connect to each algorithm's selected relays and query for kind-1 notes across time windows (7d to 3yr). Compare events returned against a baseline built by querying *all* declared write relays. This is the "did you actually get the posts?" score — relays go down, prune old events, or require auth, so the on-paper score can be very different from reality.

The central finding: these two phases diverge sharply. An algorithm can win on paper and lose in practice.

## Algorithm Comparison

| Algorithm | Client Inspiration | Strategy | Cap | Per-Pubkey |
|-----------|-------------------|----------|:---:|:----------:|
| Greedy Set-Cover | Gossip, Applesauce, Wisp | Iterative max-uncovered | 50 | 2 |
| Priority-Based | NDK | Connected > selected > popular | None | 2 |
| Weighted Stochastic | Welshman/Coracle | `quality * (1 + log(weight)) * random()` | None | 3 |
| Greedy Coverage Sort | Nostur | Sort by count, skip top 3 | 50 | 2 |
| Filter Decomposition | rust-nostr | Per-author top-N write relays | None | 3w+3r |
| Direct Mapping | Amethyst (feeds) | All declared write relays | Dynamic | All |
| Primal Aggregator | Primal | Single aggregator relay | 1 | N/A |
| Popular+Random | — | Top popular + random fill | — | — |
| **ILP Optimal** | — | Brute-force best answer (slow, 3s timeout). Upper bound for comparison | 20 | — |
| **Bipartite Matching** | — | Prioritizes relays that serve hard-to-reach pubkeys (few relay options) | 20 | — |
| **Spectral Clustering** | — | Groups relays by author overlap, picks one representative per group | 20 | — |
| **MAB-UCB** | — | Learns which relays add the most new coverage over 500 simulated rounds | 20 | — |
| **Streaming Coverage** | — | Single pass: keep K best relays, swap one out if a new relay improves coverage | 20 | — |
| **Stochastic Greedy** | — | Like greedy but samples random subsets each step instead of scanning all | 20 | — |

## Benchmark Results

### Academic: Assignment Coverage at 20 Connections

*Given NIP-65 relay lists, how many of your follows get assigned to at least one relay? This never connects to any relay — it measures the quality of the mapping, not whether events actually exist there.*

Fraction of followed authors assigned at least one relay (higher = better). Selected from 26 profiles:

| User (follows) | Ceiling | Greedy | NDK | Welshman | Nostur | rust-nostr | Direct |
|----------------|--------:|-------:|----:|---------:|-------:|-----------:|-------:|
| ODELL (1,779) | 76.6% | **75.3%** | 74.9% | 73.7% | 66.4% | 69.8% | 74.1% |
| Derek Ross (1,328) | 80.8% | **79.6%** | 79.3% | 78.2% | 69.8% | 73.9% | 78.5% |
| jb55 (943) | 69.2% | **68.1%** | 67.7% | 67.1% | 63.6% | 64.4% | 66.7% |
| Karnage (581) | 88.5% | **87.6%** | 87.4% | 87.1% | 76.6% | 81.2% | 86.2% |
| hodlbod (442) | 87.1% | **84.8%** | 83.0% | 83.9% | 75.1% | 80.1% | 83.0% |
| Kieran (377) | 80.4% | **79.3%** | 79.0% | 78.5% | 75.1% | 74.3% | 78.5% |
| fiatjaf (194) | 76.3% | **75.3%** | **75.3%** | 73.2% | 61.9% | 71.1% | 71.6% |
| Rabble (105) | 90.5% | **90.5%** | **90.5%** | 89.5% | 75.2% | 85.7% | 88.6% |

**CS-inspired algorithms vs. Greedy (same 20-connection cap):**

| User (follows) | Ceiling | Greedy | ILP | Bipartite | Streaming | Spectral | MAB | StochGrdy |
|----------------|--------:|-------:|----:|----------:|----------:|---------:|----:|----------:|
| ODELL (1,779) | 76.6% | 75.3% | **75.5%** | 75.3% | 75.4% | 75.4% | 75.0% | 73.9% |
| Derek Ross (1,328) | 80.8% | 79.6% | **80.0%** | 79.9% | 79.9% | 79.9% | 79.2% | 78.9% |
| jb55 (943) | 69.2% | 68.1% | **68.6%** | **68.6%** | **68.6%** | 68.5% | 67.9% | 67.7% |
| Karnage (581) | 88.5% | 87.6% | **88.5%** | 88.2% | **88.5%** | **88.5%** | 86.5% | 87.4% |
| hodlbod (442) | 87.1% | 84.8% | **86.0%** | 85.5% | **86.0%** | 85.9% | 84.6% | 84.3% |
| Kieran (377) | 80.4% | 79.3% | **80.4%** | 80.1% | **80.4%** | **80.4%** | 78.7% | 79.0% |
| fiatjaf (194) | 76.3% | 75.3% | **76.3%** | 75.9% | **76.3%** | **76.3%** | 72.3% | 73.4% |
| Rabble (105) | 90.5% | **90.5%** | **90.5%** | **90.5%** | **90.5%** | **90.5%** | 86.0% | 89.8% |

ILP, Streaming, and Spectral frequently hit the theoretical ceiling. Greedy leaves 1–4% on the table. MAB and Stochastic Greedy trade coverage for exploration diversity.

"Ceiling" = NIP-65 adoption rate. No algorithm can exceed it. Full results for all 26 profiles across 14 algorithms in the [full report](OUTBOX-REPORT.md#81-academic-assignment-coverage).

### Approximating Real-World Conditions: Event Recall Across Time Windows

*Connects to real relays and queries for real events. Answers "did you actually get the posts?" — which depends on relay uptime, retention policies, event propagation, auth requirements, etc.*

Percentage of baseline events actually retrievable from selected relays. Events per (relay, author) pair capped at 10,000 to prevent a single prolific relay from dominating the baseline.

**Time-window degradation (fiatjaf):**

| Algorithm | 3yr | 1yr | 90d | 30d | 14d | 7d |
|-----------|:---:|:---:|:---:|:---:|:---:|:---:|
| **MAB-UCB** | **22.8%** | **40.8%** | **65.9%** | **74.6%** | 82.3% | 93.5% |
| ILP Optimal | 21.3% | 38.1% | 60.3% | 70.9% | 83.2% | 98.0% |
| Bipartite Matching | 21.2% | 38.0% | 60.3% | 71.0% | 83.3% | 98.0% |
| Streaming Coverage | 21.2% | 37.9% | 59.8% | 69.9% | 81.7% | 97.5% |
| Spectral Clustering | 21.2% | 37.9% | 59.8% | 69.9% | 81.7% | 97.5% |
| Welshman Stochastic | 21.1% | 37.8% | 59.7% | 68.6% | 82.8% | 93.2% |
| Stochastic Greedy | 12.6%\* | 11.6% | 23.9% | 43.3% | 56.8% | 67.1% |
| NDK Priority | 11.2% | 18.7% | 36.1% | 61.4% | 76.5% | 92.3% |
| Filter Decomposition | 10.6% | 19.0% | 39.0% | 63.1% | 77.5% | 88.1% |
| Greedy Set-Cover | 9.8% | 16.3% | 35.8% | 61.8% | 77.5% | 93.5% |
| Direct Mapping | 9.4% | 16.8% | 38.5% | 63.9% | 79.9% | 89.9% |
| Coverage Sort (Nostur) | 7.4% | 13.3% | 30.8% | 53.5% | 65.6% | 67.6% |
| Popular+Random | 6.6% | 11.8% | 27.1% | 53.3% | 71.9% | 83.4% |
| Primal Aggregator | 0.9% | 1.6% | 3.7% | 8.3% | 14.5% | 28.3% |

\* Stochastic Greedy's non-monotonic 3yr > 1yr result is a data artifact: the algorithm selects fewer relays than budget due to early convergence, and the baseline event count grows faster than the miss rate at this window boundary.

At short windows (7d), ILP/Bipartite/Streaming/Spectral hit 97–98%. At longer windows, MAB-UCB's adaptive exploration dominates — it discovers relays that retain historical events. Greedy degrades sharply past 14 days (16% at 1 year vs MAB's 41%).

**Cross-profile validation (7d, mean event recall across 6 profiles):**

| Algorithm | fiatjaf | hodlbod | Kieran | jb55 | ODELL | Derek Ross | Mean |
|-----------|:-------:|:-------:|:------:|:----:|:-----:|:----------:|:----:|
| Streaming Coverage | 97.5% | 93.2% | 91.8% | 92.6% | 88.1% | 90.9% | **92.4%** |
| ILP Optimal | 98.0% | 96.8% | 90.5% | 91.6% | 87.2% | 89.8% | 92.3% |
| Spectral Clustering | 97.5% | 94.8% | 89.7% | 93.3% | 87.0% | 89.8% | 92.0% |
| Bipartite Matching | 98.0% | 93.1% | 90.1% | 93.1% | 86.3% | 90.1% | 91.8% |
| MAB-UCB | 93.5% | 92.9% | 92.5% | 92.4% | 83.0% | 90.9% | 90.9% |
| Direct Mapping | 89.9% | 85.9% | 90.9% | 85.9% | 87.6% | 87.3% | 87.9% |
| Greedy Set-Cover | 93.5% | 87.6% | 84.8% | 81.0% | 77.2% | 82.5% | 84.4% |
| NDK Priority | 92.3% | 82.1% | 85.2% | 81.1% | 77.2% | 82.0% | 83.3% |
| Welshman Stochastic | 93.2% | 83.6% | 84.6% | 84.1% | 74.8% | 77.8% | 83.0% |
| Popular+Random | 83.4% | 86.8% | 84.1% | 87.0% | 76.9% | 79.7% | 83.0% |
| Primal Aggregator | 28.3% | 37.3% | 34.8% | 25.2% | 33.6% | 30.2% | 31.6% |

Rankings generalize across all profiles: CS-inspired algorithms (92% mean) consistently outperform client-derived algorithms (84% mean) by ~8 percentage points at event recall.

## Repo Structure

```
OUTBOX-REPORT.md              Full analysis report
IMPLEMENTATION-GUIDE.md       Opinionated recommendations backed by benchmarks
bench/                         Benchmark tool (Deno/TypeScript)
  main.ts                      CLI entry point
  src/algorithms/              14 algorithm implementations
  src/phase2/                  Event verification probes
  phase-1-findings.md          Phase 1 methodology and detailed results
  results/                     JSON benchmark outputs
analysis/
  clients/                     Per-client cheat sheets (6 files)
  cross-client-comparison.md   Cross-client comparison by decision point
```

## Running the Benchmark

Prerequisites: [Deno](https://deno.com/) v2+

```bash
cd bench

# Phase 1: Assignment coverage (fast, no network after initial fetch)
deno task bench <npub_or_hex>

# With connection budget sweep
deno task bench <npub_or_hex> --sweep

# Phase 2: Event verification (connects to relays, slower)
deno task bench <npub_or_hex> --verify

# Phase 2 with custom time window (7 days)
deno task bench <npub_or_hex> --verify --verify-window 604800

# Specific algorithms only
deno task bench <npub_or_hex> --algorithms greedy,ndk,welshman
```

Run `deno task bench --help` for all options.

## Observations

Based on patterns across all 15 implementations:

1. **Choose your algorithm by use case.** For real-time feeds, CS-inspired algorithms (Streaming Coverage, Spectral Clustering) achieve 92% mean event recall across 6 profiles vs Greedy's 84%. For historical access, Greedy degrades sharply (16% recall at 1yr) while stochastic approaches (Welshman: 38% at 1yr) or adaptive exploration (MAB-UCB: 41% at 1yr) are 2–2.5x better. Coverage-optimal is not event-recall-optimal.

2. **Most clients default to 2–3 relays per pubkey.** 7 of 9 implementations with per-pubkey limits converge on 2 or 3. This is an observed ecosystem consensus, not an empirically benchmarked finding — no study has measured the optimal number.

3. **Track relay health.** At minimum, binary online/offline with backoff. Ideally, tiered error thresholds (Welshman) or penalty timers (Gossip). [NIP-66](https://github.com/nostr-protocol/nips/blob/master/66.md) (kind 30166) and [nostr.watch](https://github.com/sandwichfarm/nostr-watch) publish network-wide relay liveness data (3 states: online/offline/dead — not binary) that clients could consume as a supplement to local tracking. No analyzed client uses this yet. Caveats: some relays block monitors, and the offline→dead threshold is subjective. See [IMPLEMENTATION-GUIDE.md §3](IMPLEMENTATION-GUIDE.md#3-pre-filter-relays-with-nip-66).

4. **Use multiple indexer relays.** Relying only on purplepag.es is a single point of failure. It appears in 6/13 implementations. Amethyst's 5-indexer approach is most resilient.

5. **Filter misconfigured kind 10002.** Blocklist known-bad relays (aggregators, NWC endpoints, localhost). Every mature client does this.

6. **Make outbox debuggable — but go beyond assignment coverage.** noStrudel's coverage debugger is the only client that exposes outbox internals (coverage %, orphaned users, per-relay assignment). But it only shows the academic view — the on-paper relay mapping. No client shows real-world event recall: "did I actually get the posts?" Our central finding is that these two views diverge sharply (85% assignment coverage can mean 16% event recall at 1yr). Future work: extend debuggers to show per-author event delivery success, relay response rates, and staleness of relay list data.

7. **No client learns which relays actually deliver.** Every client picks relays statelessly — recompute from NIP-65 data each time. MAB-UCB wins long-term recall (41% at 1yr vs greedy's 16%) because it remembers which relays worked and explores alternatives. In practice this is just periodic rebalancing with a per-relay stats table (~100 bytes/relay) persisted to DB — not fundamentally harder than the health tracking Gossip and Welshman already do. Some clients already track the right data (Voyage's `EventRelayAuthorView`, Nosotros's `seen` table) but none feed it back into relay selection. Welshman's `random()` factor — the reason it has the best deployed archival recall at 38% — is accidentally a crude form of Thompson Sampling and could be upgraded to learn from observed delivery with a few dozen lines of code. See [IMPLEMENTATION-GUIDE.md §7](IMPLEMENTATION-GUIDE.md#7-learn-from-what-actually-works) for details.

8. **Aggregator results are surprisingly poor.** Primal reaches 28% recall at 7d and <1% at 3yr — worse than Popular+Random (damus + nos.lol + 2 random relays) at every window. This is unexpected: an aggregator that proxies tens if not hundreds of relays should in theory outperform 4 random connections. This may indicate a limitation in the benchmark methodology rather than a real-world indictment of aggregators.

For details, see Sections 8–9 of the [full report](OUTBOX-REPORT.md).

## Links

- [Full Analysis Report](OUTBOX-REPORT.md) — Cross-client analysis + benchmark results
- [Implementation Guide](IMPLEMENTATION-GUIDE.md) — Opinionated recommendations backed by benchmarks
- [Cross-Client Comparison](analysis/cross-client-comparison.md) — Decisions compared across 15 clients
- [Phase 1 Findings](bench/phase-1-findings.md) — Benchmark methodology and detailed results
- [nostrability#69](https://github.com/niclas-pfeifer/nostrability/issues/69) — Parent issue
- [NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md) — Relay List Metadata specification
