# NIP-77 (Negentropy) Relay Correlation Findings

> Initial results from one profile. More data points needed before drawing strong conclusions.

## Question

Are NIP-77-capable relays better relays? If a relay supports negentropy sync (NIP-77), does that correlate with better performance on the metrics we already measure?

## Method

Partition all relays queried during Phase 2 verification by NIP-77 support (detected from NIP-66 monitor `supported_nips` data). Compare group-level performance: connect latency, query latency, success rate, event delivery rate, timeout rate, mean event count.

No new network calls. Pure data plumbing over existing Phase 2 + NIP-66 data.

```
deno task bench <pubkey> --verify --nip66-filter liveness --algorithms greedy --fast --output table
```

## Results

**Profile: 2c6594... (2,747 follows) | 2026-03-18 | 1d window | NIP-66 liveness filter**

566 relays queried after liveness filter. NIP-66 data from 13 monitors.

| Group | Count | Connect (median) | Query (median) | Success Rate | Delivery Rate | Timeout Rate | Mean Events |
|-------|------:|------------------:|---------------:|-------------:|--------------:|-------------:|------------:|
| NIP-77 | 146 | 581ms | 842ms | 99.3% | 47.3% | 1.4% | 95 |
| Non-NIP-77 | 420 | 613ms | 838ms | 83.1% | 26.0% | 10.5% | 11 |

### Key observations

1. **Success rate gap is large.** NIP-77 relays connect 99.3% vs 83.1%. These relays are better-maintained infrastructure.

2. **Delivery rate nearly 2x.** 47.3% of NIP-77 relays returned events for the queried pubkeys vs 26.0% for non-NIP-77 relays. NIP-77 relays store more content.

3. **Timeout rate 7.5x lower.** 1.4% vs 10.5%. NIP-77 relays are more responsive.

4. **Mean event count ~9x higher.** 95 vs 11 events per relay. NIP-77 relays hold significantly more data per author.

5. **Latency is similar.** Connect: 581ms vs 613ms. Query: 842ms vs 838ms. NIP-77 doesn't predict latency well -- relay location and network path dominate.

### Interpretation

NIP-77 support is a strong signal for relay quality. This makes intuitive sense: implementing negentropy requires a relay operator who (a) runs recent software, (b) actively maintains their relay, and (c) has enough storage to make sync worthwhile. These same traits correlate with uptime, responsiveness, and content availability.

This does NOT mean NIP-77 *causes* better performance. It's a selection effect: serious relay operators adopt NIP-77; serious relay operators also have better infrastructure.

## Implications for relay selection

If NIP-77 support is this strong a quality signal, it could be used as:

1. **Tiebreaker in relay selection.** When two relays cover similar pubkeys, prefer the NIP-77-capable one.
2. **Lightweight health heuristic.** Cheaper than probing -- just check NIP-66 data.
3. **Connection budget optimization.** If NIP-77 relays are more reliable, you can trust them with more pubkey assignments (lower redundancy needed).

These hypotheses need validation across more profiles before acting on them.

## Phase 2: NEG-OPEN Probe — Claimed vs Actual NIP-77 Support

### Method

Send actual `NEG-OPEN` messages to each relay over WebSocket. Compare NIP-66 monitor claims (`supported_nips` includes 77) against real protocol behavior. Categorize failures: `unsupported` (relay doesn't recognize NEG-OPEN), `blocked` (relay knows NIP-77 but rejects), `closed`/`timeout`.

```
deno task bench <pubkey> --verify --nip66-filter liveness --nip77-probe \
  --verify-concurrency 15 --no-phase2-cache --algorithms greedy --fast --output table
```

### Results

**Same profile, same session as Phase 1.**

491 of 566 relays probed (75 could not be probed — failed to connect during WS probe).

| Metric | Count |
|--------|------:|
| Probed | 491 |
| Confirmed NIP-77 | 142 |
| NIP-66 claimed but rejected (NEG-ERR / timeout) | 21 |
| Not claimed by NIP-66 but actually supported | 19 |

### Key observations

1. **NIP-66 detection is 87% accurate.** Of 163 relays that NIP-66 flagged as NIP-77, 142 confirmed via live probe (87.1%). 21 returned NEG-ERR or timed out.

2. **19 relays support NIP-77 but NIP-66 doesn't know.** These are either recently-upgraded relays or relays not covered by all monitors. ~12% false-negative rate.

3. **True NIP-77 count is ~161** (142 confirmed + 19 unclaimed-but-supported), not the 146 NIP-66 reports. NIP-66 over-counts by 4 (false positives) but under-counts by 19 (false negatives), netting out to NIP-66 slightly underestimating actual deployment.

4. **Phase 1 correlation still holds.** The second run reproduced nearly identical group stats (success 98.6% vs 83.8%, delivery 47.9% vs 26.0%, timeouts 1.4% vs 10.5%), confirming the correlation isn't noise from a single run.

### Probe accuracy implications

For relay selection, NIP-66 `supported_nips` is a **useful but imperfect signal**:
- Using it as a tiebreaker is safe — 87% precision means you'll usually be right.
- If you need certainty (e.g., to decide whether to use negentropy sync), a live NEG-OPEN probe is cheap (~1 RTT) and definitive.
- The 19 false-negatives mean relying solely on NIP-66 for NIP-77 detection will miss ~12% of capable relays.

## Phase 3: Reconciliation Benchmark — Does NIP-77 Actually Save Bandwidth?

### Method

After baseline collection (REQ all 566 relays, collect events), reconnect to each confirmed NIP-77 relay and run negentropy reconciliation. For each relay:

1. Build "local set" from events collected from *other* relays for the same pubkeys (simulates what a client would already have cached)
2. Send `NEG-OPEN` with the same filter used in baseline
3. Run multi-round `NEG-MSG` reconciliation loop
4. Track all bytes in both directions

Key metric: `savingsRatio = 1 - negBytesTotal / reqBytesReceived`

```
deno task bench <pubkey> --verify --nip66-filter liveness --nip77-reconcile \
  --nip77-concurrency 5 --verify-concurrency 15 --algorithms greedy --fast --output table
```

### Results: Three time windows

Tested at 1 day, 7 days, and 1 year to understand how event set size affects NIP-77 efficiency.

#### Headline: savings scale dramatically with time window

| Window | Relays | Aggregate Savings | Relays with Positive Savings | Failed |
|---|---:|---:|---:|---:|
| **1 day** | 139 | **-186.5%** (negative) | ~17 | 3 |
| **7 days** | 136 | **mixed** | ~55 | 4 |
| **1 year** | 138 | **+88.5%** | ~100+ | 3 |

At 1 day, negentropy costs more than REQ on aggregate. At 1 year, it saves 88.5% of all bytes transferred.

#### 1-day window: protocol overhead dominates small event sets

139 of 142 relays completed (3 timed out including relay.damus.io).

The data is bimodal. Relays with large event sets save 10-97%, but relays with tiny event sets (1-3 events) see the negentropy handshake (~500-800 bytes) dwarf the REQ data:

| Relay | Overlap | Savings | NEG bytes | REQ bytes |
|---|---:|---:|---:|---:|
| relay.letsfo.com | 100% | **97.5%** | 1.1 KB | 46.9 KB |
| spatia-arcana.com | 88% | **91.8%** | 11.9 KB | 144.8 KB |
| pyramid.fiatjaf.com | 100% | **82.9%** | 23.1 KB | 135.2 KB |
| premium.primal.net | 97% | **66.4%** | 200 KB | 596 KB |
| strfry.openhoofd.nl | 100% | **-17,069%** | ~500 B | ~3 B |
| relay.fundstr.me | 100% | **-12,142%** | ~500 B | ~4 B |

The 1-day window produces mostly small event sets per relay — the wrong scenario for negentropy.

#### 7-day window: the transition zone

136 of 140 relays completed. Many more relays now have enough events for positive savings:

| Relay | Overlap | Savings | NEG bytes | REQ bytes | Rounds |
|---|---:|---:|---:|---:|---:|
| relay.letsfo.com | 100% | **98.5%** | 3.7 KB | 238.7 KB | 1 |
| spatia-arcana.com | 91% | **96.0%** | 18.1 KB | 457.0 KB | 2 |
| herbstmeister.com | 100% | **96.5%** | 940 B | 26.1 KB | 1 |
| pyramid.aaro.cc | 100% | **95.8%** | 1.1 KB | 26.7 KB | 1 |
| nostr.land | 97% | **93.0%** | 81.2 KB | 1.1 MB | 2 |
| premium.primal.net | 95% | **91.5%** | 187.1 KB | 2.1 MB | 2 |
| relay.noderunners.network | 100% | **89.7%** | 31.3 KB | 304.4 KB | 2 |
| theforest.nostr1.com | 93% | **89.7%** | 150.7 KB | 1.4 MB | 3 |
| nostr21.com | 100% | **85.3%** | 168.2 KB | 1.1 MB | 2 |
| relay.mostr.pub | 98% | **84.3%** | 306.4 KB | 1.9 MB | 3 |

At 7 days, relays with >5 KB of REQ data consistently save 80-98%. Relays with tiny event sets still show negative savings.

#### 1-year window: NIP-77 saves 88.5% aggregate

138 of 141 relays completed. **This is the returning-user scenario** — large event sets, high overlap.

| Relay | Overlap | Savings | NEG bytes | REQ bytes | Rounds |
|---|---:|---:|---:|---:|---:|
| chorus.mikedilger.com | 1% | **99.9%** | 615 B | 918 KB | 1 |
| chadf.nostr1.com | 4% | **99.9%** | 2.2 KB | 2.8 MB | 1 |
| no.str.cr | 41% | **99.9%** | 1.0 KB | 859 KB | 1 |
| relay.letsfo.com | 100% | **99.7%** | 3.2 KB | 973 KB | 2 |
| noornode.nostr1.com | 10% | **99.6%** | 8.7 KB | 2.2 MB | 2 |
| nostr.land | 39% | **99.5%** | 43.7 KB | 8.5 MB | 2 |
| eden.nostr.land | 69% | **99.3%** | 47.2 KB | 7.0 MB | 2 |
| theforest.nostr1.com | 31% | **99.2%** | 135.5 KB | 17.6 MB | 3 |
| relay.azzamo.net | 62% | **99.0%** | 11.2 KB | 1.1 MB | 2 |
| 140.f7z.io | 9% | **98.9%** | 35.9 KB | 3.2 MB | 2 |
| basspistol.org | 39% | **98.8%** | 5.6 KB | 466 KB | 1 |
| atlas.nostr.land | 100% | **98.4%** | — | — | — |
| puravida.nostr.land | 59% | **98.4%** | — | — | — |
| nostr21.com | 74% | **98.2%** | — | — | — |
| pyramid.fiatjaf.com | 79% | **96.0%** | 46.4 KB | — | 2 |
| herbstmeister.com | 100% | **95.4%** | — | — | — |
| premium.primal.net | 88% | **94.4%** | 187 KB | 2.1 MB | 2 |
| relay.noderunners.network | 98% | **93.3%** | — | — | — |

Key observations at 1 year:

1. **Even low-overlap relays save 99%+.** chadf.nostr1.com has only 4% overlap but saves 99.9% — because the relay holds 2.8 MB of events, and the negentropy fingerprint is 2.2 KB regardless of overlap. The protocol overhead is negligible at scale.

2. **nostr.land: 43.7 KB NEG vs 8.5 MB REQ (99.5% savings).** This is a real hub relay. A client would transfer 195× less data using negentropy.

3. **theforest.nostr1.com: 135.5 KB NEG vs 17.6 MB REQ (99.2% savings).** The largest successful reconciliation — 130× reduction.

4. **relay.damus.io still timed out** across all three windows. The largest relay can't complete reconciliation. This needs investigation — it's the relay that would benefit most.

### The crossover: when does NIP-77 start saving?

Comparing across windows, the crossover where NIP-77 beats REQ is driven by **REQ data size**, not overlap:

| REQ data per relay | 1d savings | 7d savings | 1yr savings |
|---|---|---|---|
| **<1 KB** (1-3 events) | -170× to -2× | -170× to -2× | Still negative for a few |
| **1-5 KB** (5-20 events) | Marginal | 50-90% | 90-99% |
| **5-50 KB** (20-100 events) | 50-97% | 80-98% | 95-99% |
| **>50 KB** (100+ events) | 60-97% | 85-99% | 98-99.9% |

At 1 year, most relays hold enough events that the protocol overhead is negligible. The few remaining negative-savings relays are those with both tiny event sets AND tiny REQ responses.

### Interpretation

**NIP-77 reconciliation is not a general-purpose optimization.** It's a targeted optimization whose value scales with event set size:

1. **Returning user syncing cached feeds** (1yr+ of events) = **88-99% savings**. This is the killer use case.
2. **Weekly catch-up** (7d) = **80-98% savings** for active relays, still negative for near-empty ones.
3. **Daily feed refresh** (1d, per-relay queries) = **mostly negative**. Protocol overhead dominates small event sets.
4. **Cold start** (no local events) = **no savings**. Use REQ.

The right mental model: negentropy is like `rsync` for events. Syncing a nearly-identical directory is almost free. Syncing from scratch is the same cost as a full copy. The "almost identical" scenario gets more common as the client runs longer.

## Why app developers should care

NIP-77 is a sync protocol. Relay selection is a routing problem. They seem unrelated — but the data shows they're deeply connected, and there are concrete things app devs can do today.

### 1. NIP-77 support is the best free relay quality signal available

Your outbox implementation already has to choose which relays to connect to. The hard part is knowing which relays are reliable *before* connecting. Today most clients either treat all declared write relays equally (wasteful) or use NIP-66 uptime data (requires fetching monitor events).

NIP-77 support in NIP-66 data is a single bit that predicts:
- 99% connection success (vs 83% for non-NIP-77 relays)
- 2x event delivery rate
- 7.5x fewer timeouts
- 9x more stored events per author

If you're already fetching NIP-66 data for liveness filtering (and you should be — it cuts dead relay connections by 40-60%), checking `supported_nips.includes(77)` costs nothing extra. Use it as a tiebreaker when two relays cover similar pubkeys, or as a weight in scoring.

### 2. Fewer wasted connections = faster feed loads

The outbox model's main UX cost is the long tail: slow or dead relays that block connection slots. With 20 relay connections, even 2-3 timeouts (15s each) can add 15-30s of wall-clock delay (timeout tax).

NIP-77 relays timeout at 1.4% vs 10.5%. Preferring them in your relay selection directly reduces the timeout tax. In our benchmark, the greedy algorithm at 20 connections had a 15s timeout tax from a single dead relay. If selection had favored NIP-77 relays, that slot would more likely have been productive.

### 3. NIP-77 enables efficient sync — and the savings are massive for returning users

Phase 3 data across three time windows (1d, 7d, 1yr) shows NIP-77 savings scale dramatically with event set size:

- **1 year of events: 88.5% aggregate savings.** Top relays save 99%+ (nostr.land: 43.7 KB vs 8.5 MB).
- **7 days: 80-98% savings** for relays with >5 KB of events.
- **1 day: mostly negative.** Protocol overhead dominates when relays have 1-3 events.

**When to use negentropy sync:**
- Returning user syncing their feed cache → **yes** (88-99% savings at 1yr)
- Weekly catch-up from regular relays → **yes** (80-98% savings at 7d)
- Background refresh of relays you've been using → **yes**
- First visit to a new profile → **no** (no local events, use REQ)
- Per-author queries during feed construction (1d window) → **no** (small event sets per relay)

**The crossover:**
- <1 KB REQ data: always use REQ
- 1-5 KB: 50-90% savings at 7d+, marginal at 1d
- >5 KB: NIP-77 wins consistently (80-99%)
- >50 KB: NIP-77 saves 95-99.9%

### 4. Concrete recommendations by app type

**Feed-first apps (Damus, Amethyst, Primal):**
- Use NIP-77 support as a relay selection tiebreaker today — zero implementation cost beyond checking one field
- Implement negentropy sync for feed catch-up (biggest bandwidth win for returning users)
- Priority: high. Feed sync is the most common operation and NIP-77 relays are the most reliable

**Social browser apps (noStrudel, Coracle):**
- NIP-77 tiebreaker gives immediate benefit for relay selection
- Negentropy sync less critical since these apps do more ad-hoc profile browsing
- Priority: medium. The quality signal alone justifies checking

**Relay-light apps (Voyage, clients with <10 connections):**
- NIP-77 quality signal is *more* valuable here — every connection slot matters
- With 5-8 connections, picking a relay that times out costs 12-20% of your budget
- Priority: high for selection signal. Lower for sync (fewer relays = less need for efficient sync)

**SDK/library authors (NDK, Welshman, rust-nostr):**
- Expose NIP-77 support in relay scoring APIs so app devs don't have to parse NIP-66 themselves
- Consider adding negentropy reconciliation as a sync strategy option alongside REQ
- Priority: high. This is infrastructure that benefits all downstream apps

### 5. What NOT to do

- **Don't filter out non-NIP-77 relays.** Many good relays don't support it yet. Use it as a tiebreaker, not a gate.
- **Don't assume NIP-66 claims are always right.** 13% of claimed-NIP-77 relays failed our probe. If you need to actually use negentropy, do a quick NEG-OPEN probe first (1 RTT, ~100ms).
- **Don't use NIP-77 sync for cold starts.** No local events = no overlap = no savings. Use REQ for first load, NIP-77 for subsequent syncs.
- **Don't use NIP-77 for small per-relay queries.** If a relay will return <5 KB of events (~20 events at 1d), REQ is cheaper. At 7d+ time windows, the crossover drops significantly.

## Limitations

- **Single profile.** n=1. The correlation could differ for profiles with different follow-graph characteristics.
- **Survivorship bias.** The NIP-66 liveness filter already removed ~1,068 dead relays before this analysis. The non-NIP-77 group still includes many weak relays that passed liveness but are marginal.
- **Correlation, not causation.** See interpretation above.
- **Probe coverage.** 75 of 566 relays couldn't be probed (failed WS connect). These are likely the weakest relays and disproportionately non-NIP-77.
- **relay.damus.io timeout.** The largest relay couldn't complete reconciliation at any time window (1d, 7d, 1yr). This is a significant gap — it's the relay most likely to show large savings. Needs investigation (server-side processing limits, rate limiting, or protocol timeout sensitivity).

## Next steps

- **relay.damus.io investigation.** Debug the timeout — increase per-round timeout, check for rate limiting, try smaller filters. This relay timed out at all three windows.
- **Multi-profile runs.** Run across 5+ profiles to validate the correlation holds.
- **30-day window.** Fill in the gap between 7d and 1yr.
- **Spin-off repo.** Phase 3 reconciliation findings belong in [nostrability/negentropy](https://github.com/nostrability/negentropy), not outbox. The quality signal (Phases 1-2) stays here.

## Reproducibility

```bash
# Phase 1 (correlation only — runs automatically)
deno task bench 2c65940725bbf10b452197fba41c6cb14afd41e28e0be22aab49bf246b0c84e3 \
  --verify --nip66-filter liveness --algorithms greedy --fast --output table

# Phase 2 (adds NEG-OPEN probe)
deno task bench 2c65940725bbf10b452197fba41c6cb14afd41e28e0be22aab49bf246b0c84e3 \
  --verify --nip66-filter liveness --nip77-probe \
  --verify-concurrency 15 --no-phase2-cache --algorithms greedy --fast --output table

# Phase 3 (full reconciliation benchmark — 1d, 7d, 1yr)
deno task bench 2c65940725bbf10b452197fba41c6cb14afd41e28e0be22aab49bf246b0c84e3 \
  --verify --verify-window 86400 --nip66-filter liveness --nip77-reconcile \
  --nip77-concurrency 3 --verify-concurrency 10 --algorithms greedy --fast --output table

deno task bench 2c65940725bbf10b452197fba41c6cb14afd41e28e0be22aab49bf246b0c84e3 \
  --verify --verify-window 604800 --nip66-filter liveness --nip77-reconcile \
  --nip77-concurrency 3 --verify-concurrency 10 --algorithms greedy --fast --output table

deno task bench 2c65940725bbf10b452197fba41c6cb14afd41e28e0be22aab49bf246b0c84e3 \
  --verify --verify-window 31536000 --nip66-filter liveness --nip77-reconcile \
  --nip77-concurrency 3 --verify-concurrency 10 --algorithms greedy --fast --output table
```

Phase 1 runs automatically when `--verify` + NIP-66 data are available. Phase 2 adds `--nip77-probe`. Phase 3 adds `--nip77-reconcile` (implies `--nip77-probe` + `--no-phase2-cache`).

Full run logs saved to `.cache/nip77-phase2-run.log`, `.cache/nip77-phase3-run2.log`, `.cache/nip77-phase3-7d.log`, and `.cache/nip77-phase3-1yr.log`.
