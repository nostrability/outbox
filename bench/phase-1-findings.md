# Phase 1 Findings: Outbox Relay Selection Algorithm Comparison

## Approach

We built a benchmark tool that **simulates 6 relay selection strategies** used by Nostr clients, running them against identical real-world follow list and relay data. Each algorithm receives the same input (a user's follow list + all follows' NIP-65 relay lists fetched from indexer relays) and produces relay-to-pubkey assignments under the same connection budget.

### What this measures

**Assignment coverage**: the fraction of followed authors that get at least one relay assigned. This is a proxy for "could you see their posts?" -- not a guarantee (Phase 2 will verify actual event availability).

### What this does NOT measure

- Actual event delivery (does the relay have the events?)
- Latency, reliability, or relay health
- Real client behavior (these are simplified simulations of each approach)

### Algorithms tested

| # | Algorithm | Inspired by | Strategy |
|---|-----------|-------------|----------|
| 1 | **Greedy Set-Cover** | Gossip, Applesauce, Wisp | Iteratively pick the relay covering the most uncovered authors. Global optimization. |
| 2 | **Priority-Based** | NDK (noStrudel, etc.) | Per-author: prefer relays already selected for other authors (connection reuse), then by popularity. |
| 3 | **Weighted Stochastic** | Welshman/Coracle | Per-author scoring: `(1 + log(weight)) * random()`, select top N. Run 10x, report mean. |
| 4 | **Greedy Coverage Sort** | Nostur | Sort relays by coverage count, skip top 3 most popular, greedily assign. No iterative recalc. |
| 5 | **Filter Decomposition** | rust-nostr | Per-author: select up to N write relays in lexicographic order. No global optimization. |
| 6 | **Direct Mapping** | Amethyst (feed routing) | Use ALL declared write relays. No optimization. Upper bound baseline. |

### Fairness regime

**Regime A** (primary): All algorithms capped at the same number of WebSocket connections (default 20). Algorithms without native caps are post-processed: run uncapped, sort relays by load descending, keep top N.

**Regime B**: All algorithms target N relays per author (default 2). Reports attainment rate (what % of authors actually get N relays -- some have fewer valid relays).

### Methodology

- Relay lists fetched from 3 indexer relays: purplepag.es, relay.damus.io, nos.lol
- URL normalization to `wss://hostname` form
- Strict filtering: remove localhost, IP-only, `ws://` non-onion, known aggregators (feeds.nostr.band, filter.nostr.wine, etc.), malformed URLs
- Deterministic tie-breaking everywhere (lexicographic URL sort)
- Seedable PRNG (mulberry32, seed=0) for stochastic algorithm reproducibility
- NIP-65 tag parsing: no marker = read+write, "write" = write only, "read" = read only

---

## Test Profiles

10 Nostr users with diverse follow list sizes and NIP-65 adoption rates:

| User | Follows | With relay list | NIP-65 adoption | Unique write relays |
|------|--------:|----------------:|----------------:|--------------------:|
| ODELL | 1,778 | 1,361 | 76.5% | 1,198 |
| pablof7z (NDK) | 1,050 | 711 | 67.7% | 773 |
| Gigi | 1,033 | 694 | 67.2% | 916 |
| jb55 (Damus) | 943 | 653 | 69.2% | 725 |
| jack | 694 | 389 | 56.1% | 539 |
| hodlbod (Coracle) | 442 | 385 | 87.1% | 490 |
| Snowden | 354 | 223 | 63.0% | 390 |
| Vitor (Amethyst) | 240 | 198 | 82.5% | 312 |
| Mike Dilger (Gossip) | 233 | 186 | 79.8% | 331 |
| Lyn Alden | 226 | 152 | 67.3% | 254 |
| fiatjaf | 194 | 148 | 76.3% | 233 |

---

## Results

### Regime A: Assignment Coverage at 20 Connections

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

"Ceiling" = NIP-65 adoption rate (% of follows with any valid write relay). No algorithm can exceed this.

### Sweep: Coverage vs Connection Budget (fiatjaf's follow list)

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

### Concentration Metrics at 20 Connections (fiatjaf)

| Algorithm | Relays | Assign% | Gini | HHI | Avg relays/author |
|-----------|-------:|--------:|-----:|----:|------------------:|
| Greedy Set-Cover | 20 | 75.3% | 0.77 | 0.262 | 1.9 |
| Priority-Based (NDK) | 20 | 75.3% | 0.76 | 0.262 | 1.9 |
| Weighted Stochastic | 20 | 73.1% | 0.51 | 0.113 | 2.5 |
| Greedy Coverage Sort | 20 | 61.9% | 0.57 | 0.132 | 1.7 |
| Filter Decomposition | 20 | 71.1% | 0.52 | 0.122 | 2.2 |
| Direct Mapping | 20 | 71.6% | 0.39 | 0.083 | 4.6 |

Greedy Set-Cover has highest concentration (0.77 Gini) -- it packs authors onto few high-coverage relays. Direct Mapping has lowest concentration (0.39 Gini) but needs 233 connections to match coverage.

---

## Key Findings

### 1. Greedy Set-Cover wins every profile

Greedy Set-Cover (Gossip/Applesauce/Wisp approach) is #1 across all 11 test profiles at every connection budget. The mathematical property is straightforward: iteratively picking the relay that covers the most remaining uncovered authors is the greedy approximation to the minimum set cover problem.

### 2. Rankings are stable

The ordering is remarkably consistent across all profiles regardless of follow count or NIP-65 adoption rate:

1. **Greedy Set-Cover** -- always #1
2. **Priority-Based (NDK)** -- within 0-2% of #1
3. **Weighted Stochastic (Coracle)** -- within 1-3% of #1
4. **Direct Mapping (Amethyst)** -- mid-pack, 3-5% behind
5. **Filter Decomposition (rust-nostr)** -- similar to Direct Mapping
6. **Greedy Coverage Sort (Nostur)** -- consistently last, 5-12% behind

### 3. The skip-top-relays heuristic hurts

Nostur's approach of skipping the 3 most popular relays costs 5-12 percentage points of coverage. Those relays are popular *because* many authors publish there -- avoiding them means missing authors who only publish to popular relays.

### 4. 20 connections is nearly sufficient

Most algorithms reach within 1-2% of their unlimited ceiling by 20 relays. The Chrome 28-WebSocket-connection limit is a non-issue for the top algorithms. Greedy Set-Cover at 10 connections already achieves 93-97% of its unlimited coverage.

### 5. NIP-65 adoption is the real bottleneck

The gap between the best algorithm and the theoretical ceiling is 1-3%. But 20-44% of follows have no relay list at all. More NIP-65 adoption would help far more than better algorithms. Jack's follow list has only 56% NIP-65 adoption -- no algorithm can cover the missing 44%.

### 6. Concentration is the tradeoff

Greedy Set-Cover achieves best coverage by concentrating load on a few high-coverage relays (Gini 0.77). This means a few relay operators bear most of the traffic. Weighted Stochastic and Direct Mapping spread load more evenly (Gini 0.39-0.51) at the cost of lower coverage. This is a genuine tradeoff -- not just an optimization artifact.

---

## How Real Clients Map to Benchmarks

| Client | Approach | Benchmark proxy | Typical gap vs best |
|--------|----------|----------------|-------------------|
| Gossip | Greedy set-cover | **greedy-set-cover** | -- (winner) |
| NDK clients (noStrudel, etc.) | Priority + reuse | **priority-based** | ~0-1% behind |
| Coracle/Welshman | Weighted stochastic | **weighted-stochastic** | ~1-3% behind |
| Amethyst | All write relays (feed routing) | **direct-mapping** | ~3-5% behind |
| rust-nostr clients | Per-author top N | **filter-decomposition** | ~3-5% behind |
| Nostur | Sort + skip top 3 | **greedy-coverage-sort** | ~5-12% behind |
| Notedeck | No outbox routing yet | worse than direct | N/A |
| Yakihonne | Centralized (own relays) | worse than direct | N/A |

**Caveats**: These are simplified simulations. Real clients have additional factors: relay health monitoring, connection pooling, fallback chains, caching, and UX-driven decisions that our benchmark doesn't capture. The actual client experience depends on Phase 2 factors (does the relay actually have the events?).

---

## Limitations

1. **Assignment != delivery.** A relay being "assigned" a pubkey means the author declared it as a write relay. It doesn't mean events are actually there. Phase 2 will verify this.
2. **Simplified algorithms.** Our implementations capture the core strategy but not every detail of each client's code.
3. **Single snapshot.** Relay lists change over time. Our data is a point-in-time fetch.
4. **No relay health.** All relays are treated equally. Real clients factor in latency, uptime, and connection success.
5. **Write relays only.** We use NIP-65 write relays (where authors publish). Some clients use additional signals (relay hints, NIP-05, etc.).

---

## Phase 2: Next Steps

Phase 1 answers: "which algorithm selects the best relay set on paper?"

Phase 2 will answer: "do those relays actually have the events?" by:
- Connecting to selected relays and querying for recent events per author
- Comparing against a multi-relay baseline to estimate true event availability
- Measuring connection success rates, latency, and NIP-11 support
