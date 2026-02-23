> **DRAFT** — This document is a work in progress. Findings and framing may change.

# Outbox Model Report

**How 15 Nostr clients implement NIP-65 relay routing — and which algorithms actually retrieve events.**

15 codebases across 5 languages (Rust, TypeScript, Kotlin, Swift, Dart). 14 algorithms benchmarked against real follow lists and relay data. The central finding: the algorithm most clients use (greedy set-cover) ranks 7th at actual event retrieval.

*Produced for [nostrability#69](https://github.com/niclas-pfeifer/nostrability/issues/69)*

| Maturity | Projects |
|----------|----------|
| **Full outbox** (read + write routing, scoring, health tracking) | Gossip, Welshman/Coracle, Amethyst, NDK, Applesauce/noStrudel, Nostur, rust-nostr, Voyage, Wisp, Nosotros |
| **Partial / planned** | Yakihonne (parser exists, unused), Notedeck (NIP-65 infra, PR #1288 pending) |
| **Minimal / none** | Shopstr (own relay config only) |

---

## 1. Results

### 1.1 On-Paper Relay Mapping

**What this measures:** Given NIP-65 relay lists, how many follows get assigned to at least one relay? No relay connections — just the quality of the mapping on paper.

26 profiles tested (105–1,779 follows, 52–91% NIP-65 adoption). Top 8 shown; full 26-profile tables in [Appendix A](#appendix-a-full-on-paper-mapping-tables).

**Client algorithms at 20 connections:**

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

- Greedy set-cover wins 23 of 26 profiles. Rankings are stable regardless of follow count or NIP-65 adoption rate.
- Research algorithms (ILP, Streaming, Spectral) frequently hit the theoretical ceiling — the gap between greedy and optimal is 1–4%.
- "Ceiling" = NIP-65 adoption rate. No algorithm can exceed it. 10–48% of follows lack any relay list — better algorithms cannot fix missing data.

### 1.2 Event Retrieval

**What this measures:** Connects to real relays and queries for real events. "Did you actually get the posts?" — depends on relay uptime, retention, event propagation, and auth requirements. Events per (relay, author) pair capped at 10,000.

**Multi-window cross-profile event recall (mean of 5–6 profiles, reliable authors, %):**

| Algorithm | 14d | 30d | 90d | 365d | 1095d |
|-----------|:---:|:---:|:---:|:----:|:-----:|
| **MAB-UCB** | **79.0** | **62.9** | 34.4 | **32.4** | **24.4** |
| Spectral Clustering | 78.5 | 60.2 | 35.6 | 27.7 | 20.4 |
| ILP Optimal | 78.3 | 58.7 | 33.8 | 24.7 | 18.6 |
| Streaming Coverage | 77.6 | 56.6 | 32.1 | 25.6 | 20.7 |
| Direct Mapping | 77.2 | 60.3 | 27.9 | 28.5 | 21.7 |
| Bipartite Matching | 76.3 | 56.5 | **37.3** | 26.6 | 20.1 |
| Welshman Stochastic | 67.9 | 48.6 | 25.5 | 20.4 | 15.1 |
| Pop+Random | 67.1 | 45.9 | 24.7 | 20.4 | 15.1 |
| Greedy Set-Cover | 64.8 | 39.7 | 20.2 | 16.2 | 12.1 |
| NDK Priority | 64.3 | 39.3 | 18.9 | 15.1 | 11.0 |
| Filter Decomposition | 63.5 | 46.6 | 23.7 | 22.4 | 17.3 |
| Nostur Coverage Sort | 54.3 | 39.6 | 20.2 | 17.6 | 12.8 |
| Stochastic Greedy | 51.9 | 31.6 | 12.9 | 11.7 | 9.5 |
| Primal Aggregator | 16.8 | 6.9 | 3.5 | 3.4 | 2.0 |

**Relays-per-author sweep (Greedy Set-Cover, fiatjaf, 7d):**

| Relays per Author | Event Recall | Author Recall |
|:-----------------:|:-----------:|:------------:|
| 1 | 86.1% | 98.7% |
| 2 | 91.6% | 96.2% |
| 3 | 93.9% | 96.3% |
| 4 | 94.3% | 96.3% |
| 5 | 93.7% | 96.3% |

- MAB-UCB dominates at 14d–30d (winning 4 of 6 profiles). At longer windows, the winner varies by profile: MAB for hodlbod, Spectral for Derek Ross, Direct Mapping for ODELL, Streaming for jb55.
- Greedy set-cover (used by most clients) ranks 7th–10th at every window. It optimizes on-paper mapping, not event retrieval.
- The 90d mark is an inflection point where relay retention drops sharply — most algorithms lose 40–60% of their 14d recall by 90d.

### 1.3 NIP-66 Liveness Filtering

Pre-filtering dead relays using [NIP-66](https://github.com/nostr-protocol/nips/blob/master/66.md) monitor data (kind 30166/1066) and the [nostr.watch](https://api.nostr.watch) API. Union of both sources: ~1,036 unique "alive" relays.

**Relay pool reduction:**

| Profile | Follows | Unfiltered Relays | NIP-66 Relays | Reduction |
|---------|---------|-------------------|---------------|-----------|
| fiatjaf | 194 | 233 | 133 | 43% |
| hodlbod | 442 | 487 | 252 | 48% |
| jb55 | 943 | 729 | 296 | 59% |
| ODELL | 1,774 | 1,201 | 437 | 64% |

**Connection success rate:**

| Profile | NIP-66 Filtered | Unfiltered | Lift |
|---------|:-----------:|:----------:|:----:|
| fiatjaf | 88–92% | 53–55% | +35 pp |
| hodlbod | 82–83% | 45–46% | +37 pp |
| jb55 | 82–83% | 35% | +48 pp |
| ODELL | 76% | 30–31% | +46 pp |

**Event recall delta (NIP-66 filtered minus unfiltered, pp, 4-profile average):**

| Algorithm | 7d | 365d | 3yr |
|-----------|:---:|:----:|:---:|
| Greedy Set-Cover | -0.6 | +1.1 | +3.9 |
| ILP Optimal | +0.4 | +1.8 | +3.8 |
| MAB-UCB | +2.5 | +5.1 | +3.1 |
| NDK Priority | +0.4 | +0.2 | +0.7 |
| Welshman Stochastic | +2.1 | +8.6 | +4.4 |
| Direct Mapping | +2.0 | +6.1 | +5.4 |

**Recommendation:** Consume NIP-66 data or the nostr.watch API to pre-filter dead relays before running relay selection. One fetch at startup (cached for hours), pool shrinks ~50%, connection success doubles, long-window recall improves 1–9 pp. Zero recall loss at short windows. Stochastic algorithms (Welshman, MAB-UCB) benefit most because their random exploration is most likely to waste picks on dead relays.

---

## 2. Conclusions

1. **On-paper mapping ≠ event retrieval.** Greedy set-cover wins relay assignment coverage but ranks 7th of 14 at actual event recall (84% vs 92% mean at 7d). At 1 year: 16% recall vs MAB-UCB's 41%. The relay that *should* have the event often doesn't — retention policies, downtime, and access restrictions dominate.

2. **Add randomness — it discovers relays that retain history.** Welshman's `quality * (1 + log(weight)) * random()` isn't just anti-centralization — it's the best archival strategy among deployed client algorithms (38% at 1yr). MAB-UCB's exploration-exploitation achieves the same effect (41%). Pure greedy concentrates on mega-relays that prune old events.

3. **2–3 relays per author.** 7 of 9 implementations default to 2 or 3. Empirical testing confirms: 1→2 adds 5.5 pp event recall, 2→3 adds 2.3 pp, beyond 3 is flat or negative as the fixed connection budget thins out.

4. **Pre-filter dead relays with NIP-66.** Halves the candidate pool, doubles connection success rates (30–55% → 76–92%), improves long-window recall by 1–9 pp. No client uses this yet.

5. **NIP-65 adoption is the real bottleneck.** 10–48% of follows have no relay list at all. The gap between the best algorithm and the ceiling is 1–3%. More relay list adoption helps far more than better algorithms.

6. **20 connections is enough.** Most algorithms reach within 1–2% of their unlimited ceiling at 20 relays. Greedy at 10 connections already achieves 93–97% of its unlimited coverage.

7. **No client measures actual event delivery.** noStrudel's coverage debugger shows the on-paper view (assignment coverage). No client answers "did I actually get the posts?" — our central finding is that these two views diverge sharply.

---

## 3. Known Limitations

**NIP-42 auth-required relays.** The benchmark does not implement NIP-42 authentication. ~15–20 relays require auth before accepting reads and return zero events (nostr1.com cluster, creatr.nostr.wine, aggr.nostr.land, pantry.zap.cooking). Some relays have structural barriers beyond auth: personalized filter relays (filter.nostr.wine/npub...) only serve the owner, WoT relays require graph membership, some disable reads entirely.

**Impact:** Event recall numbers are conservative lower bounds. Adding NIP-42 support would unlock ~15–20 additional relays. Relative algorithm rankings are unlikely to change since all algorithms are equally affected.

**Rate limiting.** Some relays throttle concurrent requests. Running parallel benchmarks may exacerbate this.

---

## 4. Implementation Landscape

Per-client architecture, scoring formulas, discovery pipelines, fallback chains, and heuristic composition are documented in the analysis files:

- **Per-client deep dives:** [`analysis/clients/`](analysis/clients/) (6 files, ~4,000 lines)
- **Cross-cutting topics:** [`analysis/topics/`](analysis/topics/) (6 files — algorithms, bootstrapping, challenges, heuristics, measurement, implementation approaches)

### Client-to-Algorithm Mapping

| Client | Algorithm | Benchmark Proxy |
|--------|-----------|-----------------|
| Gossip | Greedy set-cover | [`greedy-set-cover.ts`](bench/src/algorithms/greedy-set-cover.ts) |
| Applesauce/noStrudel | Greedy set-cover | [`greedy-set-cover.ts`](bench/src/algorithms/greedy-set-cover.ts) |
| Wisp | Greedy set-cover | [`greedy-set-cover.ts`](bench/src/algorithms/greedy-set-cover.ts) |
| Amethyst (recs) | Greedy set-cover | [`greedy-set-cover.ts`](bench/src/algorithms/greedy-set-cover.ts) |
| Amethyst (feeds) | Direct mapping | [`direct-mapping.ts`](bench/src/algorithms/direct-mapping.ts) |
| NDK | Priority-based | [`priority-based.ts`](bench/src/algorithms/priority-based.ts) |
| Welshman/Coracle | Weighted stochastic | [`weighted-stochastic.ts`](bench/src/algorithms/weighted-stochastic.ts) |
| Nostur | Greedy coverage sort | [`greedy-coverage-sort.ts`](bench/src/algorithms/greedy-coverage-sort.ts) |
| rust-nostr | Filter decomposition | [`filter-decomposition.ts`](bench/src/algorithms/filter-decomposition.ts) |
| Voyage | Multi-phase greedy | — |
| Nosotros | Observable pipeline | — |
| Yakihonne | None (static relays) | — |
| Notedeck | None (planned) | — |
| Shopstr | None (own relays) | — |

### Connection Limits

| Project | Max Total | Per Author |
|---------|:---------:|:----------:|
| Gossip | 50 | 2 |
| noStrudel | 20 | 5 |
| Nostur | 50 | 2 |
| Wisp | 75 | No limit |
| Voyage | 25 | 2 |
| Welshman | None (3/scenario) | 3 |
| NDK | None | 2 |
| Nosotros | None | 3 |
| rust-nostr | None | 3w+3r+1h+1m |

### Bootstrap Relay Dependencies

| Relay | Projects | Role |
|-------|:--------:|------|
| `relay.damus.io` | 8/13 | Universal bootstrap |
| `purplepag.es` | 6/13 | Primary kind 10002 indexer |
| `nos.lol` | 5/13 | Secondary bootstrap |
| `relay.primal.net` | 5/13 | Common fallback |
| `nostr.wine` | 3/13 | Search + fallback |

---

## Appendix A: Full On-Paper Mapping Tables

### Client Algorithms at 20 Connections (26 profiles)

| User (follows) | Ceiling | Greedy | NDK | Welshman | Nostur | rust-nostr | Direct |
|----------------|--------:|-------:|----:|---------:|-------:|-----------:|-------:|
| ODELL (1,779) | 76.6% | **75.3%** | 74.9% | 73.7% | 66.4% | 69.8% | 74.1% |
| Derek Ross (1,328) | 80.8% | **79.6%** | 79.3% | 78.2% | 69.8% | 73.9% | 78.5% |
| pablof7z (1,050) | 67.7% | **66.4%** | 66.1% | 65.7% | 60.9% | 62.0% | 65.8% |
| Gigi (1,033) | 67.2% | **66.2%** | 65.7% | 65.2% | 58.4% | 62.1% | 64.9% |
| jb55 (943) | 69.2% | **68.1%** | 67.7% | 67.1% | 63.6% | 64.4% | 66.7% |
| verbiricha (938) | 82.2% | **80.3%** | 78.8% | 79.6% | 71.4% | 75.5% | 79.7% |
| miljan (811) | 76.4% | **75.2%** | 74.8% | 73.9% | 66.2% | 68.1% | 74.0% |
| Calle (718) | 69.8% | **68.2%** | 66.6% | 67.7% | 61.0% | 63.8% | 62.7% |
| jack (694) | 56.1% | **55.3%** | **55.3%** | 54.3% | 50.7% | 51.6% | 54.3% |
| Karnage (581) | 88.5% | **87.6%** | 87.4% | 87.1% | 76.6% | 81.2% | 86.2% |
| NVK (502) | 65.7% | **64.9%** | **64.9%** | 64.1% | 61.4% | 59.2% | 63.7% |
| hodlbod (442) | 87.1% | **84.8%** | 83.0% | 83.9% | 75.1% | 80.1% | 83.0% |
| Alex Gleason (434) | 84.3% | **83.4%** | 82.7% | 82.6% | 74.2% | 78.1% | 82.7% |
| Semisol (421) | 87.2% | **85.0%** | 84.8% | 84.8% | 81.0% | 82.2% | 84.6% |
| Martti Malmi (395) | 72.4% | **71.6%** | 70.9% | 70.4% | 66.1% | 67.6% | 70.6% |
| hzrd149 (388) | 84.0% | **82.7%** | 82.2% | 81.4% | 74.7% | 77.6% | 81.7% |
| Kieran (377) | 80.4% | **79.3%** | 79.0% | 78.5% | 75.1% | 74.3% | 78.5% |
| Preston Pysh (369) | 52.3% | **51.8%** | **51.8%** | 51.4% | 50.7% | 49.9% | 50.9% |
| Tony Giorgio (361) | 72.0% | 70.6% | **71.2%** | 70.1% | 67.3% | 67.3% | 69.8% |
| Snowden (354) | 63.0% | **62.7%** | 62.4% | 61.8% | 59.3% | 59.0% | 61.9% |
| Vitor (240) | 82.5% | **80.8%** | 80.4% | 80.6% | 72.1% | 76.7% | 80.4% |
| Dilger (233) | 80.3% | 76.8% | 76.4% | **77.0%** | 70.8% | 73.0% | 75.5% |
| Lyn Alden (226) | 67.3% | **67.3%** | **67.3%** | 66.2% | 63.7% | 61.1% | 65.0% |
| fiatjaf (194) | 76.3% | **75.3%** | **75.3%** | 73.2% | 61.9% | 71.1% | 71.6% |
| Ben Arc (137) | 70.8% | **69.3%** | **69.3%** | 66.7% | 62.8% | 62.8% | 67.2% |
| Rabble (105) | 90.5% | **90.5%** | **90.5%** | 89.5% | 75.2% | 85.7% | 88.6% |

### Research Algorithms vs. Greedy (20 connections, 26 profiles)

| User (follows) | Ceiling | Greedy | ILP | Bipartite | Streaming | Spectral | MAB | StochGrdy |
|----------------|--------:|-------:|----:|----------:|----------:|---------:|----:|----------:|
| ODELL (1,779) | 76.6% | 75.3% | **75.5%** | 75.3% | 75.4% | 75.4% | 75.0% | 73.9% |
| Derek Ross (1,328) | 80.8% | 79.6% | **80.0%** | 79.9% | 79.9% | 79.9% | 79.2% | 78.9% |
| pablof7z (1,050) | 67.7% | 66.4% | **66.9%** | 66.7% | 66.6% | 66.4% | 65.7% | 65.7% |
| Gigi (1,033) | 67.2% | 66.2% | **66.7%** | **66.7%** | 66.5% | 66.6% | 66.2% | 65.9% |
| jb55 (943) | 69.2% | 68.1% | **68.6%** | **68.6%** | **68.6%** | 68.5% | 67.9% | 67.7% |
| verbiricha (938) | 82.2% | 80.3% | **80.6%** | 80.3% | 80.4% | 80.5% | 79.7% | 80.1% |
| miljan (811) | 76.4% | 75.2% | **76.1%** | 75.6% | **76.1%** | 76.0% | 75.3% | 75.1% |
| Calle (718) | 69.8% | 68.2% | **69.1%** | 68.7% | **69.1%** | 69.0% | 67.5% | 68.0% |
| jack (694) | 56.1% | 55.3% | **56.1%** | 55.7% | **56.1%** | 56.0% | 54.9% | 54.8% |
| Karnage (581) | 88.5% | 87.6% | **88.5%** | 88.2% | **88.5%** | **88.5%** | 86.5% | 87.4% |
| NVK (502) | 65.7% | 64.9% | **65.7%** | 65.3% | **65.7%** | **65.7%** | 63.5% | 64.7% |
| hodlbod (442) | 87.1% | 84.8% | **86.0%** | 85.5% | **86.0%** | 85.9% | 84.6% | 84.3% |
| Alex Gleason (434) | 84.3% | 83.4% | **84.3%** | 83.6% | **84.3%** | **84.3%** | 78.1% | 82.6% |
| Semisol (421) | 87.2% | 85.0% | **87.2%** | 86.4% | **87.2%** | 86.9% | 85.0% | 85.0% |
| Martti Malmi (395) | 72.4% | 71.6% | **72.4%** | 72.0% | **72.4%** | **72.4%** | 69.6% | 70.6% |
| hzrd149 (388) | 84.0% | 82.7% | **84.0%** | 83.4% | **84.0%** | **84.0%** | 82.1% | 82.0% |
| Kieran (377) | 80.4% | 79.3% | **80.4%** | 80.1% | **80.4%** | **80.4%** | 78.7% | 79.0% |
| Preston Pysh (369) | 52.3% | 51.8% | **52.3%** | 52.2% | **52.3%** | **52.3%** | 51.0% | 51.5% |
| Tony Giorgio (361) | 72.0% | 70.6% | **72.0%** | 71.6% | **72.0%** | **72.0%** | 70.3% | 70.4% |
| Snowden (354) | 63.0% | 62.7% | **63.0%** | 62.9% | **63.0%** | **63.0%** | 60.1% | 61.9% |
| Vitor (240) | 82.5% | 80.8% | **82.5%** | 81.4% | **82.5%** | **82.5%** | 79.9% | 80.8% |
| Dilger (233) | 80.3% | 76.8% | **80.3%** | 79.4% | **80.3%** | **80.3%** | 77.4% | 77.1% |
| Lyn Alden (226) | 67.3% | **67.3%** | **67.3%** | 67.0% | **67.3%** | **67.3%** | 64.0% | 66.4% |
| fiatjaf (194) | 76.3% | 75.3% | **76.3%** | 75.9% | **76.3%** | **76.3%** | 72.3% | 73.4% |
| Ben Arc (137) | 70.8% | 69.3% | **70.8%** | 70.6% | **70.8%** | **70.8%** | 66.9% | 67.9% |
| Rabble (105) | 90.5% | **90.5%** | **90.5%** | **90.5%** | **90.5%** | **90.5%** | 86.0% | 89.8% |

---

## Appendix B: Full Event Recall Tables

### Time-Window Degradation (fiatjaf)

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
| Stochastic Greedy | 67.1% | 56.8% | 43.3% | 23.9% | 11.6% | 12.6% |
| Coverage Sort (Nostur) | 67.6% | 65.6% | 53.5% | 30.8% | 13.3% | 7.4% |
| Primal Aggregator | 28.3% | 14.5% | 8.3% | 3.7% | 1.6% | 0.9% |

### Cross-Profile Event Recall (7d, reliable authors)

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
| Filter Decomposition | 88.1% | 74.7% | 81.7% | 74.0% | 71.4% | 72.1% | 77.0% |
| Stochastic Greedy | 67.1% | 73.0% | 76.8% | 64.7% | 46.3% | 72.5% | 66.7% |
| Coverage Sort (Nostur) | 67.6% | 63.7% | 79.6% | 62.4% | 54.5% | 61.0% | 64.8% |
| Primal Aggregator | 28.3% | 37.3% | 34.8% | 25.2% | 33.6% | 30.2% | 31.6% |

### Winner Per Profile Per Window

| Profile | 14d | 30d | 90d | 365d | 1095d |
|---------|-----|-----|-----|------|-------|
| fiatjaf | Streaming (94.9%) | — | — | MAB (41.5%) | MAB (24.9%) |
| hodlbod | ILP (80.7%) | MAB (72.2%) | MAB (63.3%) | MAB (53.4%) | MAB (36.2%) |
| Kieran | MAB (76.6%) | MAB (57.6%) | Spectral (27.6%) | MAB (17.4%) | Streaming (14.8%) |
| jb55 | MAB (84.1%) | MAB (72.6%) | Bipartite (54.7%) | Streaming (42.2%) | Streaming (33.0%) |
| ODELL | Direct (74.2%) | Direct (63.6%) | Direct (43.2%) | Direct (35.1%) | Direct (28.3%) |
| Derek Ross | Spectral (78.0%) | Spectral (69.3%) | Bipartite (24.6%) | Spectral (36.5%) | Spectral (27.7%) |

---

## Appendix C: Source Code References

### Per-Client Analysis Files
- [`analysis/clients/gossip.md`](analysis/clients/gossip.md)
- [`analysis/clients/welshman-coracle.md`](analysis/clients/welshman-coracle.md)
- [`analysis/clients/amethyst.md`](analysis/clients/amethyst.md)
- [`analysis/clients/ndk-applesauce-nostrudel.md`](analysis/clients/ndk-applesauce-nostrudel.md)
- [`analysis/clients/nostur-yakihonne-notedeck.md`](analysis/clients/nostur-yakihonne-notedeck.md)
- [`analysis/clients/rust-nostr-voyage-nosotros-wisp-shopstr.md`](analysis/clients/rust-nostr-voyage-nosotros-wisp-shopstr.md)

### Cross-Cutting Topic Analyses
- [`analysis/topics/implementation-approaches.md`](analysis/topics/implementation-approaches.md)
- [`analysis/topics/relay-selection-algorithms.md`](analysis/topics/relay-selection-algorithms.md)
- [`analysis/topics/challenges-and-tradeoffs.md`](analysis/topics/challenges-and-tradeoffs.md)
- [`analysis/topics/outbox-as-heuristic.md`](analysis/topics/outbox-as-heuristic.md)
- [`analysis/topics/bootstrapping-and-fallbacks.md`](analysis/topics/bootstrapping-and-fallbacks.md)
- [`analysis/topics/effectiveness-measurement.md`](analysis/topics/effectiveness-measurement.md)

### Benchmark Algorithms

All 14 implementations in [`bench/src/algorithms/`](bench/src/algorithms/):

| Algorithm | Source | Based On |
|-----------|--------|----------|
| Greedy Set-Cover | [`greedy-set-cover.ts`](bench/src/algorithms/greedy-set-cover.ts) | Gossip, Applesauce, Wisp |
| Priority-Based | [`priority-based.ts`](bench/src/algorithms/priority-based.ts) | NDK |
| Weighted Stochastic | [`weighted-stochastic.ts`](bench/src/algorithms/weighted-stochastic.ts) | Welshman/Coracle |
| Greedy Coverage Sort | [`greedy-coverage-sort.ts`](bench/src/algorithms/greedy-coverage-sort.ts) | Nostur |
| Filter Decomposition | [`filter-decomposition.ts`](bench/src/algorithms/filter-decomposition.ts) | rust-nostr |
| Direct Mapping | [`direct-mapping.ts`](bench/src/algorithms/direct-mapping.ts) | Amethyst (feeds) |
| Primal Aggregator | [`primal-baseline.ts`](bench/src/algorithms/primal-baseline.ts) | Baseline |
| Popular+Random | [`popular-plus-random.ts`](bench/src/algorithms/popular-plus-random.ts) | Baseline |
| ILP Optimal | [`ilp-optimal.ts`](bench/src/algorithms/ilp-optimal.ts) | Maximum coverage (exact) |
| Stochastic Greedy | [`stochastic-greedy.ts`](bench/src/algorithms/stochastic-greedy.ts) | Lazier-than-lazy greedy |
| MAB-UCB | [`mab-relay.ts`](bench/src/algorithms/mab-relay.ts) | Combinatorial bandits |
| Streaming Coverage | [`streaming-coverage.ts`](bench/src/algorithms/streaming-coverage.ts) | Streaming submodular max |
| Bipartite Matching | [`bipartite-matching.ts`](bench/src/algorithms/bipartite-matching.ts) | Weighted matching |
| Spectral Clustering | [`spectral-clustering.ts`](bench/src/algorithms/spectral-clustering.ts) | Community detection |

Phase 2 verification: [`bench/src/phase2/`](bench/src/phase2/)
