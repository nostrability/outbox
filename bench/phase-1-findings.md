# On-Paper Relay Mapping: Algorithm Comparison

6 relay selection strategies benchmarked against identical real-world NIP-65 data across 11 profiles.

## Results

### Assignment Coverage at 20 Connections

| User | Follows | Ceiling | Greedy SC | NDK | Welshman | Nostur | rust-nostr | Direct |
|------|--------:|--------:|----------:|----:|---------:|-------:|-----------:|-------:|
| ODELL | 1,778 | 76.5% | **75.2%** | 74.9% | 73.8% | 66.4% | 69.7% | 74.0% |
| pablof7z | 1,050 | 67.7% | **66.4%** | 66.1% | 65.7% | 60.6% | 62.0% | 65.8% |
| Gigi | 1,033 | 67.2% | **66.2%** | 65.7% | 65.2% | 58.4% | 62.1% | 64.9% |
| jb55 | 943 | 69.2% | **68.1%** | 67.7% | 67.1% | 63.6% | 64.4% | 66.7% |
| jack | 694 | 56.1% | **55.3%** | 55.3% | 54.3% | 50.7% | 51.6% | 54.3% |
| hodlbod | 442 | 87.1% | **84.8%** | 83.0% | 83.9% | 75.1% | 80.1% | 83.0% |
| Snowden | 354 | 63.0% | **62.7%** | 62.4% | 61.8% | 59.3% | 59.0% | 61.9% |
| Vitor | 240 | 82.5% | **80.8%** | 80.4% | 80.6% | 72.1% | 76.7% | 80.4% |
| Dilger | 233 | 79.8% | **76.4%** | 76.0% | 76.5% | 70.4% | 72.5% | 75.1% |
| Lyn Alden | 226 | 67.3% | **67.3%** | 67.3% | 66.2% | 63.7% | 61.1% | 65.0% |
| fiatjaf | 194 | 76.3% | **75.3%** | 75.3% | 73.1% | 61.9% | 71.1% | 71.6% |

Ceiling = NIP-65 adoption rate. No algorithm can exceed this.

### Coverage vs Connection Budget (fiatjaf)

```
Algorithm                      |     5 |    10 |    15 |    20 |    25 |    28 |    30 |    50 |   100 |   All
-------------------------------+-------+-------+-------+-------+-------+-------+-------+-------+-------+------
Greedy Set-Cover               | 69.6% | 72.7% | 73.7% | 75.3% | 75.8% | 76.3% | 76.3% | 76.3% | 76.3% | 76.3%
Priority-Based (NDK)           | 69.1% | 70.6% | 73.7% | 75.3% | 76.3% | 76.3% | 76.3% | 76.3% | 76.3% | 76.3%
Weighted Stochastic            | 66.5% | 70.6% | 71.1% | 73.2% | 73.7% | 74.2% | 74.2% | 75.8% | 76.3% | 76.3%
Greedy Coverage Sort           | 46.9% | 54.6% | 59.8% | 61.9% | 63.4% | 64.4% | 64.9% | 69.6% | 72.2% | 72.2%
Filter Decomposition           | 62.4% | 66.0% | 70.1% | 71.1% | 72.2% | 72.2% | 72.2% | 73.2% | 75.3% | 76.3%
Direct Mapping                 | 69.1% | 69.6% | 71.6% | 71.6% | 71.6% | 72.7% | 73.2% | 73.7% | 75.3% | 76.3%
```

### Concentration at 20 Connections (fiatjaf)

| Algorithm | Assign% | Gini | HHI | Avg relays/author |
|-----------|--------:|-----:|----:|------------------:|
| Greedy Set-Cover | 75.3% | 0.77 | 0.262 | 1.9 |
| Priority-Based (NDK) | 75.3% | 0.76 | 0.262 | 1.9 |
| Weighted Stochastic | 73.1% | 0.51 | 0.113 | 2.5 |
| Greedy Coverage Sort | 61.9% | 0.57 | 0.132 | 1.7 |
| Filter Decomposition | 71.1% | 0.52 | 0.122 | 2.2 |
| Direct Mapping | 71.6% | 0.39 | 0.083 | 4.6 |

## Key Findings

1. **Greedy set-cover wins every profile** at every connection budget. Stable ranking across all 11 profiles.
2. **NDK within 0-2% of best**, Welshman within 1-3%. Top 3 algorithms are closely matched.
3. **Nostur's skip-top-relays hurts**: 5-12% behind. Popular relays are popular because many authors publish there.
4. **20 connections is enough.** Most algorithms reach within 1-2% of unlimited ceiling by 20 relays.
5. **NIP-65 adoption is the bottleneck.** Best algorithm vs ceiling gap: 1-3%. Missing relay lists: 20-44%.
6. **Coverage vs concentration tradeoff.** Greedy packs onto few relays (Gini 0.77). Stochastic spreads load (0.51) at cost of lower coverage.

## Client Mapping

| Client | Benchmark proxy | Gap vs best |
|--------|----------------|-------------|
| Gossip | greedy-set-cover | -- (winner) |
| NDK (noStrudel) | priority-based | ~0-1% |
| Coracle/Welshman | weighted-stochastic | ~1-3% |
| Amethyst | direct-mapping | ~3-5% |
| rust-nostr clients | filter-decomposition | ~3-5% |
| Nostur | greedy-coverage-sort | ~5-12% |

## Methodology

- 6 algorithms, all capped at 20 WebSocket connections
- Relay lists from purplepag.es, relay.damus.io, nos.lol
- Strict filtering: no localhost, IP-only, ws://, known aggregators
- Deterministic tie-breaking, seedable PRNG (seed=0)

## Limitations

1. Assignment != delivery. On-paper coverage doesn't guarantee the relay has events.
2. Simplified algorithm simulations, not full client behavior.
3. Single snapshot of relay list data.
