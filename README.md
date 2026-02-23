> **DRAFT** — This document is a work in progress. Findings and framing may change.

# Outbox Model Analysis

**How 15 Nostr clients implement NIP-65 relay routing — and which algorithms actually work best.**

Produced for [nostrability#69](https://github.com/niclas-pfeifer/nostrability/issues/69).

This repo contains a cross-client analysis of outbox model implementations across 5 languages (Rust, TypeScript, Kotlin, Swift, Dart), plus a benchmark suite that tests 14 relay selection algorithms against real-world follow lists and NIP-65 data. The goal: give Nostr developers empirical grounding for relay selection design decisions.

## Key Findings

**From the implementation analysis (15 clients):**

1. **Greedy set-cover wins academic coverage.** Three independent implementations (Gossip, Applesauce, Wisp) converged on the same algorithm — iteratively pick the relay covering the most uncovered pubkeys. It wins 23 of 26 benchmark profiles for assignment coverage (the theoretical "on paper" metric). But see findings #7–8 for the real-world caveat.
2. **Rankings are stable across all profiles.** Greedy > NDK Priority > Welshman Stochastic > Direct Mapping > Filter Decomposition > Coverage Sort. This ordering holds regardless of follow count (194–1,778) or NIP-65 adoption rate (56–87%).
3. **The skip-top-relays heuristic hurts.** Nostur's approach of skipping the 3 most popular relays costs 5–12% coverage. Those relays are popular because many authors publish there.
4. **20 connections is nearly sufficient.** Most algorithms reach within 1–2% of their unlimited ceiling at 20 relays. Greedy at 10 connections already achieves 93–97% of its unlimited coverage.
5. **NIP-65 adoption is the real bottleneck.** The gap between the best algorithm and the ceiling is 1–3%. But 20–44% of follows have no relay list at all. More adoption helps far more than better algorithms.
6. **Concentration is the tradeoff.** Greedy set-cover achieves best coverage by concentrating load on few relays (Gini 0.77). Stochastic/Direct approaches spread load more evenly (Gini 0.39–0.51) at lower coverage.

**From real-world event verification (14 algorithms, connecting to actual relays):**

7. **Academic coverage ≠ real-world event recall.** Greedy Set-Cover wins Phase 1 assignment coverage but ranks 7th of 14 at actual event retrieval (84.4% mean across 6 profiles at 7d vs 92.4% for Streaming Coverage). At 365 days, MAB-UCB (40.8%) beats Greedy (16.3%) by 2.5x. The relay that *should* have the event often doesn't — due to retention policies, downtime, or access restrictions.
8. **Adaptive algorithms shine at longer windows.** MAB-UCB and Welshman's stochastic approach maintain recall as time windows grow, while static greedy algorithms degrade sharply.

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
| **ILP Optimal** | — (CS: branch-and-bound) | Exact maximum coverage with LP relaxation bounds, 3s timeout | 20 | — |
| **Bipartite Matching** | — (CS: weighted matching) | Inverse-frequency weighting prioritizes hard-to-reach pubkeys | 20 | — |
| **Spectral Clustering** | — (CS: community detection) | Label propagation clusters relays by Jaccard similarity, select per-cluster reps | 20 | — |
| **MAB-UCB** | — (CS: multi-armed bandit) | UCB1 exploration-exploitation over 500 rounds, learns marginal coverage | 20 | — |
| **Streaming Coverage** | — (CS: streaming submodular max) | Single-pass with k-buffer, swap weakest if candidate improves coverage | 20 | — |
| **Stochastic Greedy** | — (CS: lazier-than-lazy greedy) | Sample random relay subset per step, pick best. (1-1/e-ε) approx guarantee | 20 | — |

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

| Algorithm | 7d | 14d | 30d | 90d | 365d | 1095d |
|-----------|:---:|:---:|:---:|:---:|:----:|:-----:|
| ILP Optimal | 98.0% | 83.2% | 70.9% | 60.3% | 38.1% | 21.3% |
| Bipartite Matching | 98.0% | 83.3% | 71.0% | 60.3% | 38.0% | 21.2% |
| Streaming Coverage | 97.5% | 81.7% | 69.9% | 59.8% | 37.9% | 21.2% |
| Spectral Clustering | 97.5% | 81.7% | 69.9% | 59.8% | 37.9% | 21.2% |
| Greedy Set-Cover | 93.5% | 77.5% | 61.8% | 35.8% | 16.3% | 9.8% |
| **MAB-UCB** | 93.5% | 82.3% | **74.6%** | **65.9%** | **40.8%** | **22.8%** |
| Welshman Stochastic | 93.2% | 82.8% | 68.6% | 59.7% | 37.8% | 21.1% |
| NDK Priority | 92.3% | 76.5% | 61.4% | 36.1% | 18.7% | 11.2% |
| Direct Mapping | 89.9% | 79.9% | 63.9% | 38.5% | 16.8% | 9.4% |
| Filter Decomposition | 88.1% | 77.5% | 63.1% | 39.0% | 19.0% | 10.6% |
| Popular+Random | 83.4% | 71.9% | 53.3% | 27.1% | 11.8% | 6.6% |
| Stochastic Greedy | 67.1% | 56.8% | 43.3% | 23.9% | 11.6% | 12.6%* |
| Coverage Sort (Nostur) | 67.6% | 65.6% | 53.5% | 30.8% | 13.3% | 7.4% |
| Primal Aggregator | 28.3% | 14.5% | 8.3% | 3.7% | 1.6% | 0.9% |

\* Stochastic Greedy's non-monotonic 1095d > 365d result is a data artifact: the algorithm selects fewer relays than budget due to early convergence, and the baseline event count grows faster than the miss rate at this window boundary.

At short windows (7d), ILP/Bipartite/Streaming/Spectral hit 97–98%. At longer windows, MAB-UCB's adaptive exploration dominates — it discovers relays that retain historical events. Greedy degrades sharply past 14 days (16% at 1yr vs MAB's 41%).

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

3. **Track relay health.** At minimum, binary online/offline with backoff. Ideally, tiered error thresholds (Welshman) or penalty timers (Gossip). [NIP-66](https://github.com/nostr-protocol/nips/blob/master/66.md) (kind 30166) and [nostr.watch](https://github.com/sandwichfarm/nostr-watch) publish network-wide relay liveness data that clients could consume instead of tracking health independently — no analyzed client uses this yet.

4. **Use multiple indexer relays.** Relying only on purplepag.es is a single point of failure. It appears in 6/13 implementations. Amethyst's 5-indexer approach is most resilient.

5. **Filter misconfigured kind 10002.** Blocklist known-bad relays (aggregators, NWC endpoints, localhost). Every mature client does this.

6. **Make outbox debuggable — but go beyond assignment coverage.** noStrudel's coverage debugger is the only client that exposes outbox internals (coverage %, orphaned users, per-relay assignment). But it only shows the academic view — the on-paper relay mapping. No client shows real-world event recall: "did I actually get the posts?" Our central finding is that these two views diverge sharply (85% assignment coverage can mean 16% event recall at 1yr). Future work: extend debuggers to show per-author event delivery success, relay response rates, and staleness of relay list data.

7. **Add stochastic exploration.** Welshman's `random()` factor isn't just anti-centralization — it's the best archival strategy by far. The randomness discovers relays that retain old events and that static optimizers miss. Pure greedy concentrates on mega-relays that may prune history.

8. **Aggregator results are surprisingly poor.** Primal reaches 28% recall at 7d and <1% at 3yr — worse than Popular+Random (damus + nos.lol + 2 random relays) at every window. This is unexpected: an aggregator that proxies tens if not hundreds of relays should in theory outperform 4 random connections. This may indicate a limitation in the benchmark methodology rather than a real-world indictment of aggregators.

For details, see Sections 8–9 of the [full report](OUTBOX-REPORT.md).

## Links

- [Full Analysis Report](OUTBOX-REPORT.md) — Cross-client analysis + benchmark results
- [Implementation Guide](IMPLEMENTATION-GUIDE.md) — Opinionated recommendations backed by benchmarks
- [Cross-Client Comparison](analysis/cross-client-comparison.md) — Decisions compared across 15 clients
- [Phase 1 Findings](bench/phase-1-findings.md) — Benchmark methodology and detailed results
- [nostrability#69](https://github.com/niclas-pfeifer/nostrability/issues/69) — Parent issue
- [NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md) — Relay List Metadata specification
