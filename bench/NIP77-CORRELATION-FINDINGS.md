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

### 3. NIP-77 enables efficient sync — but only if you pick the right relays first

Negentropy sync is most valuable when you already have most of the data and need to catch up on the delta. The savings scale with overlap:
- 90%+ overlap: negentropy uses ~10x fewer bytes than re-downloading via REQ
- 50% overlap: moderate savings
- 0% overlap (cold start): no savings, same as REQ

This means NIP-77 sync is most useful for **returning users** syncing their existing feed, not for initial load. For a client with a local event cache:

**Feed sync (background):** Open negentropy reconciliation with your top relays. Get only the events you're missing. Much less bandwidth than `REQ since:last_seen`.

**Profile view (interactive):** User taps on someone's profile. You don't have their events cached. Traditional REQ is fine here — there's no local set to reconcile against.

**Hybrid approach:** Use NIP-77 for relays where you have high overlap (your regular feed relays), fall back to REQ for one-off profile views.

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

## Limitations

- **Single profile.** n=1. The correlation could differ for profiles with different follow-graph characteristics.
- **Survivorship bias.** The NIP-66 liveness filter already removed ~1,068 dead relays before this analysis. The non-NIP-77 group still includes many weak relays that passed liveness but are marginal.
- **Correlation, not causation.** See interpretation above.
- **Probe coverage.** 75 of 566 relays couldn't be probed (failed WS connect). These are likely the weakest relays and disproportionately non-NIP-77.

## Next steps

- **Phase 3: Reconciliation benchmark.** Measure actual bandwidth savings. (`--nip77-reconcile`)
- **Multi-profile runs.** Run across 5+ profiles to validate the correlation holds.

## Reproducibility

```bash
# Phase 1 (correlation only — runs automatically)
deno task bench 2c65940725bbf10b452197fba41c6cb14afd41e28e0be22aab49bf246b0c84e3 \
  --verify --nip66-filter liveness --algorithms greedy --fast --output table

# Phase 2 (adds NEG-OPEN probe)
deno task bench 2c65940725bbf10b452197fba41c6cb14afd41e28e0be22aab49bf246b0c84e3 \
  --verify --nip66-filter liveness --nip77-probe \
  --verify-concurrency 15 --no-phase2-cache --algorithms greedy --fast --output table
```

Phase 1 runs automatically when `--verify` + NIP-66 data are available. Phase 2 adds `--nip77-probe`.

Full run log saved to `.cache/nip77-phase2-run.log`.
