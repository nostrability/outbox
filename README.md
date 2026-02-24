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
9. **Aggregator results are surprisingly poor.** Primal reaches 28% recall at 7d and <1% at 3yr — worse than Popular+Random at every window. This may reflect benchmark limitations rather than real-world aggregator quality.
10. **Make outbox debuggable — but go beyond assignment coverage.** noStrudel's coverage debugger is the only client that exposes outbox internals. But it only shows the on-paper relay mapping. No client shows event recall ("did I actually get the posts?"). Future debuggers should show per-author delivery success and relay response rates.

## How the Benchmark Works

No apps are involved. The benchmark is a standalone Deno tool ([bench/](bench/)) that reimplements relay selection logic extracted from client source code, then tests it against real data.

The core problem is [maximum coverage](https://en.wikipedia.org/wiki/Maximum_coverage_problem): each relay "covers" the authors who publish there. Given a budget of K connections, pick the K relays that cover the most authors. This is NP-hard, which is why 3 clients independently converged on the standard greedy approximation.

1. **Fetch real data.** Given a pubkey, pull their follow list and every followed user's kind 10002 relay list from indexer relays.
2. **Run 14 relay selection algorithms.** Each answers: "given a budget of K connections, which relays should I open to see posts from the most follows?" 8 are reimplemented from real client codebases (Gossip, NDK, Welshman, Nostur, rust-nostr, Amethyst, Wisp, Primal). 6 are standard CS optimization techniques adapted to the same problem.
3. **Phase 1 — assignment coverage (no network).** If every relay were perfectly online and kept every event forever, how many of your follows would be reachable from the relays this algorithm picked? Pure math on NIP-65 data — no WebSocket is ever opened.
4. **Phase 2 — event recall (connects to real relays).** Connect to each algorithm's selected relays and query for kind-1 notes across time windows (7d to 3yr). Compare events returned against a baseline built by querying *all* declared write relays. This is the "did you actually get the posts?" score — relays go down, prune old events, or require auth, so the on-paper score can be very different from reality.

The central finding: these two phases diverge sharply. An algorithm can win on paper and lose in practice.

## Algorithm Comparison

**Deployed in clients:**

| Algorithm | Client | Strategy | Cap | Per-Pubkey |
|-----------|--------|----------|:---:|:----------:|
| Greedy Set-Cover | Gossip, Applesauce, Wisp | Iterative max-uncovered | 50 | 2 |
| Priority-Based | NDK | Connected > selected > popular | None | 2 |
| Weighted Stochastic | Welshman/Coracle | `quality * (1 + log(weight)) * random()` | None | 3 |
| Greedy Coverage Sort | Nostur | Sort by count, skip top 3 | 50 | 2 |
| Filter Decomposition | rust-nostr | Per-author top-N write relays | None | 3w+3r |
| Direct Mapping | Amethyst (feeds) | All declared write relays | Dynamic | All |
| Primal Aggregator | Primal | Single aggregator relay | 1 | N/A |
| Popular+Random | — | Top popular + random fill | — | — |

**Theoretical (benchmark only — not in any client):**

| Algorithm | Strategy | Cap |
|-----------|----------|:---:|
| ILP Optimal | Brute-force best answer (slow, 3s timeout). Upper bound for comparison | 20 |
| Bipartite Matching | Prioritizes relays that serve hard-to-reach pubkeys (few relay options) | 20 |
| Spectral Clustering | Groups relays by author overlap, picks one representative per group | 20 |
| MAB-UCB | Learns which relays add the most new coverage over 500 simulated rounds | 20 |
| Streaming Coverage | Single pass: keep K best relays, swap one out if a new relay improves coverage | 20 |
| Stochastic Greedy | Like greedy but samples random subsets each step instead of scanning all | 20 |

## Benchmark Results

On-paper assignment coverage results (26 profiles, 14 algorithms) are in the [full report](OUTBOX-REPORT.md#81-academic-assignment-coverage).

### Event Recall (Real Relays)

*Connects to real relays and queries for real events. Answers "did you actually get the posts?" — which depends on relay uptime, retention policies, event propagation, auth requirements, etc.*

Percentage of baseline events actually retrievable from selected relays. Events per (relay, author) pair capped at 10,000 to prevent a single prolific relay from dominating the baseline.

**Time-window degradation (fiatjaf):**

| Algorithm | 3yr | 1yr | 90d | 30d | 14d | 7d |
|-----------|:---:|:---:|:---:|:---:|:---:|:---:|
| **MAB-UCB** *(not in any client)* | **22.8%** | **40.8%** | **65.9%** | **74.6%** | 82.3% | 93.5% |
| Welshman Stochastic | 21.1% | 37.8% | 59.7% | 68.6% | 82.8% | 93.2% |
| NDK Priority | 11.2% | 18.7% | 36.1% | 61.4% | 76.5% | 92.3% |
| Filter Decomposition | 10.6% | 19.0% | 39.0% | 63.1% | 77.5% | 88.1% |
| Greedy Set-Cover | 9.8% | 16.3% | 35.8% | 61.8% | 77.5% | 93.5% |
| Direct Mapping | 9.4% | 16.8% | 38.5% | 63.9% | 79.9% | 89.9% |
| Coverage Sort (Nostur) | 7.4% | 13.3% | 30.8% | 53.5% | 65.6% | 67.6% |
| Primal Aggregator | 0.9% | 1.6% | 3.7% | 8.3% | 14.5% | 28.3% |

MAB-UCB (not yet in any client) is included as the learning reference point. At short windows (7d), most algorithms cluster at 88–94%. At longer windows, MAB-UCB's adaptive exploration dominates — it discovers relays that retain historical events. Greedy degrades sharply past 14 days (16% at 1yr vs MAB's 41%). Full results for all 14 algorithms in the [full report](OUTBOX-REPORT.md#82-event-recall).

Rankings hold across all 6 tested profiles (194–1,779 follows). Full cross-profile data in the [full report](OUTBOX-REPORT.md#82-event-recall).

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

## What to Build

See [IMPLEMENTATION-GUIDE.md](IMPLEMENTATION-GUIDE.md) for concrete
recommendations with code examples — relay selection, health tracking,
delivery measurement, and learning-based approaches.

## Links

- [Full Analysis Report](OUTBOX-REPORT.md) — Cross-client analysis + benchmark results
- [Implementation Guide](IMPLEMENTATION-GUIDE.md) — Opinionated recommendations backed by benchmarks
- [Cross-Client Comparison](analysis/cross-client-comparison.md) — Decisions compared across 15 clients
- [Phase 1 Findings](bench/phase-1-findings.md) — Benchmark methodology and detailed results
- [nostrability#69](https://github.com/niclas-pfeifer/nostrability/issues/69) — Parent issue
- [NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md) — Relay List Metadata specification
