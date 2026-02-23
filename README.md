> **DRAFT** — This document is a work in progress. Findings and framing may change.

# Outbox Model Analysis

**Greedy set-cover — the algorithm most Nostr clients use for relay selection — ranks 7th out of 14 at actually retrieving events.**

15 clients analyzed, 14 relay selection algorithms benchmarked against real follow lists and NIP-65 data. Produced for [nostrability#69](https://github.com/niclas-pfeifer/nostrability/issues/69).

## Key Findings

1. **Randomness wins.** MAB-UCB and Welshman's stochastic scoring get 2–2.5x more events than greedy set-cover at 1 year (41% vs 16% recall). Static optimizers concentrate on popular relays that prune history; stochastic exploration discovers relays that retain it.

2. **NIP-66 liveness data halves the relay pool and doubles success rates.** Pre-filtering dead relays with [NIP-66](https://github.com/nostr-protocol/nips/blob/master/66.md) monitor data removes 43–64% of candidates, lifts connection success from 30–55% to 76–92%, and improves long-window recall by 1–9 pp — with zero loss at short windows. No client uses this yet.

3. **2–3 relays per author is the sweet spot.** Going from 1→2 relays adds 5.5 pp of event recall; 2→3 adds 2.3 pp; beyond 3, returns are flat or negative.

## The Data

Mean event recall across 5–6 profiles, reliable authors, 20-relay budget (%):

| Algorithm | 14d | 30d | 90d | 365d | 1095d |
|-----------|:---:|:---:|:---:|:----:|:-----:|
| **MAB-UCB** | **79.0** | **62.9** | 34.4 | **32.4** | **24.4** |
| Spectral Clustering | 78.5 | 60.2 | 35.6 | 27.7 | 20.4 |
| ILP Optimal | 78.3 | 58.7 | 33.8 | 24.7 | 18.6 |
| Streaming Coverage | 77.6 | 56.6 | 32.1 | 25.6 | 20.7 |
| Direct Mapping | 77.2 | 60.3 | 27.9 | 28.5 | 21.7 |
| Bipartite Matching | 76.3 | 56.5 | **37.3** | 26.6 | 20.1 |
| Greedy Set-Cover | 64.8 | 39.7 | 20.2 | 16.2 | 12.1 |
| NDK Priority | 64.3 | 39.3 | 18.9 | 15.1 | 11.0 |
| Primal Aggregator | 16.8 | 6.9 | 3.5 | 3.4 | 2.0 |

- Research algorithms (top 6) average ~92% event recall at 7d. Client algorithms average ~84%. The gap widens at longer windows.
- Greedy set-cover optimizes on-paper relay mapping, not event retrieval — it ranks 7th–10th at every time window.
- The 90d mark is an inflection point where relay retention drops sharply.

Full results, methodology, and per-profile breakdowns in the [full report](OUTBOX-REPORT.md).

## Running the Benchmark

Prerequisites: [Deno](https://deno.com/) v2+

```bash
cd bench

# On-paper relay mapping (fast, no network after initial fetch)
deno task bench <npub_or_hex>

# Event retrieval verification (connects to relays, slower)
deno task bench <npub_or_hex> --verify

# With NIP-66 dead relay filtering
deno task bench <npub_or_hex> --verify --nip66-filter

# Specific algorithms only
deno task bench <npub_or_hex> --algorithms greedy,ndk,welshman
```

Run `deno task bench --help` for all options.

## Links

- [Full Report](OUTBOX-REPORT.md) — Results, conclusions, implementation landscape, appendix
- [Phase 1 Findings](bench/phase-1-findings.md) — Benchmark methodology and detailed results
- [nostrability#69](https://github.com/niclas-pfeifer/nostrability/issues/69) — Parent issue
- [NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md) — Relay List Metadata specification
