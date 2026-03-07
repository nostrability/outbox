# Outbox Model: What Actually Works

## If you read nothing else

1. **Filter dead relays first** ([NIP-66](https://github.com/nostr-protocol/nips/blob/master/66.md)) — only 37% of relay-user pairs in NIP-65 lists point to normal content relays ([NIP-11 survey](#relay-list-pollution-is-worse-than-expected)). The rest are offline, paid, restricted, or missing. Removing them stops you wasting connection budget on relays that will never respond (success rate goes from ~30% to ~75%), and each dead relay wastes 15 seconds of timeout. Zero algorithmic changes needed.
2. **Add randomness to relay selection** — deterministic algorithms (greedy set-cover) pick the same popular relays every time. Those relays prune old events. Stochastic selection discovers relays that keep history. 1.5× better recall at 1 year across 6 profiles.
3. **Learn from what relays actually return** — no client tracks "did this relay deliver events?" Track it, feed it back into selection. At 1yr, recall goes from 30% (stochastic) to 39% [26-45] after 3-5 sessions (+9pp mean, 10-run validated). At 7d, gains are smaller (+4-7pp) because the baseline is already 79-90%. ([Thompson Sampling](#thompson-sampling)).
4. **Use EOSE-race for feeds** — query 20 relays in parallel, stop 2 seconds after the first one finishes. You'll have 86-99% of your events in under 3 seconds total. Show events as they stream in. ([Latency data](#4-latency-when-to-stop-waiting-for-relays))

## What each step buys you

Each technique adds incremental value. You don't need to implement everything at once:

| Step | What you do | 1yr recall | Feed TTFE | Effort |
|:---:|---|:---:|:---:|---|
| 0 | **Hardcode big relays** (damus + nos.lol) | 8% [5–12] | 530-670ms, instant completeness | Zero |
| 1a | **Basic outbox** (greedy set-cover from NIP-65 data) | 16% [12–20] | 530-670ms, 86-99% at +2s | Medium — ~200 LOC, fetch relay lists + implement set-cover |
| 1b | **Hybrid outbox** (keep app relays + add author write relays for profiles/threads) | †† | 530-670ms, app events instant | Low — ~80 LOC, no routing layer changes ([details](#two-ways-to-add-outbox)) |
| 2 | **Stochastic scoring** (Welshman's `random()` factor) | 24% [12–38] | same | Low — ~50 LOC, replace greedy with weighted random |
| 3 | **Filter dead relays** (NIP-66 liveness data) | neutral | -45% wall-clock (removes 15s timeouts) | Low — ~30 LOC, fetch kind 30166, exclude dead relays |
| 4 | **Learn from delivery** (Thompson Sampling) | 39% [26–45]† | same | Low — ~80 LOC + DB table, replace `random()` with `sampleBeta()` |
| 4+ | **Learn relay speed** (latency discount) | same | +10-16pp completeness @2s | 1 line — `score *= 1/(1 + latencyMs/1000)` on top of Step 4 |

*Steps 1a and 1b are alternative entry points — 1a replaces your routing layer, 1b augments it. Step 1b already includes Thompson Sampling (it's the same ~80 LOC). Steps 2-4 are incremental enhancements that apply to the 1a path. †Thompson 1yr recall = 39% (Welshman+Thompson 10-run grand mean +/- 2.7 SE; per-profile std 1-8pp). FD+Thompson = 37% +/- 2.8 SE. NDK+Thompson = 31% +/- 3.8 SE. At 7d: 84-92% after learning (+4-7pp over 79-90% baseline; HJO benchmark). The 1yr gain over stochastic is +9pp mean, limited by relay retention. ††Hybrid 1yr recall is under re-benchmarking. [min–max] ranges show the spread across tested profiles — your recall depends on your follow graph size and relay diversity. All stateless values are 6-profile means. Feed TTFE = time to first event (all algorithms share the same fast relay). "+2s" = EOSE-race grace period; "instant completeness" = all events arrive with first EOSE (1-2 relay setups). 1yr recall is the more informative metric — 7d masks relay retention problems that dominate real-world performance. Latency data from 7 cross-profile benchmarks (194–2,784 follows).*

## Already using a client library?

If you're building on an existing library, here's where you stand and what to do next:

| If you use… | You're at step… | Next upgrade | Details |
|---|:---:|---|---|
| **Welshman/Coracle** | 2 (stochastic) | Add Thompson Sampling — replace `random()` with `sampleBeta()` | [analysis/clients/welshman-coracle.md](analysis/clients/welshman-coracle.md) |
| **NDK** | 1 (priority-based) | Add Thompson Sampling — +11pp mean event recall (10-run mean, high variance, 6 profiles) | [analysis/clients/ndk-applesauce-nostrudel.md](analysis/clients/ndk-applesauce-nostrudel.md) |
| **Applesauce/noStrudel** | 1 (greedy set-cover) | Add stochastic factor, then Thompson | [analysis/clients/ndk-applesauce-nostrudel.md](analysis/clients/ndk-applesauce-nostrudel.md) |
| **Gossip** | 1 (greedy set-cover) | Add stochastic factor or Thompson | [analysis/clients/gossip.md](analysis/clients/gossip.md) |
| **rust-nostr** | 1 (filter decomp) | Add FD+Thompson — same per-author structure, learns from delivery | [analysis/clients/rust-nostr-voyage-nosotros-wisp-shopstr.md](analysis/clients/rust-nostr-voyage-nosotros-wisp-shopstr.md) |
| **Amethyst** | 1 (direct mapping) | Add NIP-66 filtering — unlimited connections already give high recall | [analysis/clients/amethyst.md](analysis/clients/amethyst.md) |
| **Nostur** | 1 (coverage sort) | Remove skipTopRelays, add stochastic factor | [analysis/clients/nostur-yakihonne-notedeck.md](analysis/clients/nostur-yakihonne-notedeck.md) |
| **Ditto-Mew** | 0 (4 app relays) | Add hybrid outbox — keep app relays, add author write relays for profiles/threads | [details below](#two-ways-to-add-outbox) |
| **Nothing yet** | 0 | Start with hybrid outbox or big relays, then add full outbox when ready | [IMPLEMENTATION-GUIDE.md](IMPLEMENTATION-GUIDE.md) |

*Each link goes to a per-client cheat sheet with specific code paths, current behavior, and upgrade recommendations.*

## The problem in one sentence

Your relay picker optimizes for "who publishes where" on paper, but the relay that *should* have the event often doesn't — due to retention policies, downtime, silent write failures, or auth restrictions.

## What we tested

25 relay selection algorithms (10 from real clients, 6 experimental-actionable, 7 academic, 2 baselines — plus 2 latency-aware variants), tested against 7 real Nostr profiles (194-2,784 follows), across 6 time windows (7 days to 3 years), with and without NIP-66 liveness filtering. Every algorithm connected to real relays and queried for real events. Latency benchmarks across all 7 profiles measure TTFE, EOSE-race convergence, and profile-view timing.

Full methodology: [OUTBOX-REPORT.md](OUTBOX-REPORT.md) | Reproduce results: [Benchmark-recreation.md](Benchmark-recreation.md) | Produced for [nostrability#69](https://github.com/nostrability/nostrability/issues/69)

*Benchmark data collected February 2026. Relay state changes continuously — relative algorithm rankings should be stable; absolute recall percentages will vary on re-run.*

## What matters for app devs

### Two ways to add outbox

There are two architecturally distinct approaches to outbox routing. Both benefit from Thompson Sampling (+9pp at 1yr, reaching 39% [26-45]; +4-7pp at 7d, reaching 84-92%), but they differ in where changes land and what tradeoffs they impose.

**Full outbox routing** — replace your relay selection layer. For each followed author, route queries to their NIP-65 write relays instead of broadcasting to a fixed relay set. This is what Welshman/Coracle, rust-nostr, NDK, and Gossip do.

**Hybrid outbox enrichment** — keep your existing relay infrastructure for the main feed and add parallel outbox queries only for long-tail paths: profile views, event lookups, and thread traversal. The main feed stays on your app relays (fast, predictable latency). Profile views additionally query the viewed author's write relays. Event lookups use relay hints and author write relays as fallback tiers.

| | Full outbox | Hybrid outbox |
|---|---|---|
| **1yr event recall** | 39% [26–45] | — |
| **7d event recall** | 84-92% (79-90% before learning) | — |
| **Main feed latency** | Depends on per-author relay quality | Unchanged (app relays) |
| **What changes** | Routing layer (NostrProvider / pool router) | Individual hooks (profile, event, thread) |
| **Connection count** | 20+ (capped budget shared across all follows) | 4 app relays + 3 per viewed profile |
| **Cold start** | Random relay selection (session 1) | Same as current app behavior (session 1) |
| **Engineering effort** | Rewrite relay routing (~200-500 LOC) | Add outbox queries to 3-4 hooks (~80 LOC) |
| **Best for** | Clients building relay routing from scratch, or with existing per-author routing | Clients with hardcoded app relays or fixed relay sets that can't change the feed path |

*Note: Hybrid+Thompson 1yr recall is still under re-benchmarking — the original numbers were collected with a [phase2 cache bug](#methodology-note-phase2-cache-bug). The relative comparison (hybrid vs full outbox architecture) is directionally valid. Full outbox Welshman+Thompson = 39% [26-45] at 1yr (10-run mean). The hybrid approach queries fewer outbox relays per author (top 3) but compensates with the app relay safety net.*

**Decision tree:**

```text
Do you have a routing layer that selects relays per-author?
├─ Yes → Add Thompson Sampling to it (Step 4)
│        +9pp at 1yr (39% [26-45]); +4-7pp at 7d (84-92%)
│
└─ No (fixed app relays / broadcast)
   │
   ├─ Can you rewrite your routing layer?
   │  └─ Yes → Implement full outbox (Step 1a → Step 4)
   │           Best recall, but biggest engineering investment
   │
   └─ No, or need to preserve feed latency guarantees?
      └─ Add hybrid outbox (Step 1b)
         ~80 LOC, no routing layer changes; 1yr recall under re-benchmarking
         Profile views: fetch author's kind 10002, query top 3 write relays in parallel
         Event lookups: rank relay hints by Thompson score, NIP-65 fallback
         Thread loading: propagate relay hints from e-tags
```

### Key learning: how much does Thompson actually help?

Thompson Sampling is a ~80 LOC upgrade that tracks relay delivery and feeds it back into selection. The gain depends entirely on the time window — because the binding constraint at longer windows is relay retention (events pruned), not relay selection (events misrouted).

| Window | Baseline (stochastic) | Thompson (after 5 sessions) | Absolute | Relative | What limits it |
|:---:|:---:|:---:|:---:|:---:|---|
| **7d** | 79-90% | 84-92% | +4-7pp | +5-8% | Already high — most relays have recent events |
| **1yr** | 30% | 39% ± 2.7 SE | +9pp | **+30%** | Relay retention: relays prune events >6-12mo |
| **3yr** | 19% | 26% | +7pp | **+37%** | Severe retention: most relays have nothing >2yr |

*Per-profile 7d gains (HJO, 6 profiles, S1→S5): fiatjaf -1pp, Gato +2pp, hodlbod +4pp, jb55 +7pp, ODELL +7pp, Telluride +7pp. Per-profile 1yr gains (10-run validated): fiatjaf +0pp, Gato +3pp, hodlbod +15pp, jb55 +15pp, ODELL +15pp, Telluride +4pp. 3yr paired deltas: WT +7.2pp (SE 1.1), FD +8.6pp (SE 1.0), NDK +8.8pp (SE 1.7) — all statistically significant.*

**The honest picture:** In absolute terms, +9pp at 1yr sounds modest. In relative terms, Thompson finds **30% more events** than stochastic at 1yr and **37% more at 3yr** — the gain grows with window length because the baseline drops faster than Thompson does. At 7d the baseline is already strong so relative gains are small (+5-8%).

**Thompson's value appears largest in a middle range of follow counts.** The per-profile spread at 1yr is wide (0 to +15pp / 0 to +60% relative), and the pattern across our 6 benchmarked profiles suggests two different ceilings that limit Thompson at opposite ends:

- **Small follow graphs** (fiatjaf, 194 follows → ~140 unique relays): a 20-connection budget already samples a large fraction of the relay space each session, leaving Thompson little to learn (~0% gain, ±8.0 std — noisy and inconsistent).
- **Mid-range follow graphs** (hodlbod 442, jb55 943, ODELL 1,779): the relay graph is diverse enough that random selection consistently misses good relays, but 20 connections is still enough to make meaningful coverage improvements when Thompson steers selection (+55-60% relative gain).
- **Very large follow graphs** (Telluride, 2,784 follows → 500+ unique relays): even with perfect learning, 20 connections can only cover a fraction of the relay space. The connection cap itself becomes the binding constraint — Thompson reliably learns the best 20 relays (±0.9 std — very consistent) but the best 20 simply aren't enough (+11% gain).

This is based on 6 EN profiles — whether this inverted-U pattern holds for other profiles and relay ecosystems is an open question we're testing with [additional profiles](#in-progress-jp-profile-expansion) (84–1,746 follows, JP relay graph).

### 1. Learning beats static optimization

The relay that's "best on paper" isn't always the one that delivers events. Greedy set-cover (used by Gossip, Applesauce, Wisp) wins on-paper relay assignments but drops to 16% event recall at 1 year — while algorithms with randomness or per-author diversity reach 24-25%. This is inherent to the algorithm: greedy set-cover is a static, one-shot computation — it picks relays based on declared write lists and never learns whether those relays actually delivered.*

**What to do:** Track which relays return events. Feed that data back into selection. Thompson Sampling does this with ~80 lines of code on top of Welshman/Coracle's existing algorithm ([code below](#thompson-sampling)).

*\*Greedy set-cover solves "which relays cover the most authors?" but the answer doesn't change between sessions. A relay that failed to deliver events last time gets picked again next time if it still covers the most authors on paper. Learning algorithms (Thompson, MAB) update their beliefs after each session.*

| Profile (follows) | Stochastic (no learning) | Thompson (S5, 10-run mean) | Gain |
|---|---|---|---|
| fiatjaf (194) | 39.2% | 39.3 +/- 8.0 | **+0pp** |
| hodlbod (442) | 29.4% | 44.6 +/- 2.8 | **+15pp** |
| jb55 (943) | 27.0% | 42.2 +/- 4.3 | **+15pp** |
| ODELL (1,779) | 25.1% | 39.9 +/- 3.6 | **+15pp** |
| Gato (399) | 23.4% | 25.9 +/- 1.9 | **+3pp** |
| Telluride (2,784) | 38.4% | 42.0 +/- 0.9 | **+4pp** |
| **6-profile mean** | **30.4%** | **39.0 +/- 2.7 SE** | **+9pp** |

*1yr data from 10 independent runs (6 profiles x 5 sessions each, NIP-66 liveness, `--no-phase2-cache`). Thompson column shows mean +/- standard deviation across 10 runs; 6-profile mean shows +/- standard error. Per-profile variance ranges from 0.9pp (Telluride) to 8.0pp (fiatjaf), confirming Thompson gains are robust for most profiles but noisy for small follow graphs. At 7d, gains are larger: 84-92% after learning (HJO benchmark). The 1yr gap is limited by relay retention — relays prune old events, so learning which relay to ask can't recover events that no longer exist.*

**NDK-specific Thompson Sampling results** (NDK's priority-based algorithm + Thompson, 5 learning sessions, 1yr, NIP-66 liveness, cap@20, `--no-phase2-cache`, 10 independent runs):

| Profile (follows) | NDK baseline | NDK+Thompson S5 (10-run mean) | Gain |
|---|---|---|---|
| fiatjaf (194) | 32.1% | 14.4 +/- 1.3 | **-18pp** |
| hodlbod (855) | 13.7% | 38.8 +/- 3.0 | **+25pp** |
| jb55 (1,218) | 19.5% | 34.6 +/- 5.8 | **+15pp** |
| ODELL (1,562) | 17.9% | 32.9 +/- 1.6 | **+15pp** |
| Gato (399) | 13.6% | 26.0 +/- 11.1 | **+12pp** |
| Telluride (2,784) | 22.7% | 38.1 +/- 2.5 | **+15pp** |
| **6-profile mean** | **19.9%** | **30.8 +/- 3.8 SE** | **+11pp** |

NDK+Thompson shows high variance across profiles. fiatjaf regresses consistently (14.4 +/- 1.3 across 10 runs) because NDK's priority cascade happens to concentrate on relay.damus.io, which works well for that specific follow graph — Thompson's exploration disrupts this lucky alignment. For the other 5 profiles, gains range from +12pp to +25pp. The mean gain (+11pp) is comparable to Welshman+Thompson (+9pp), but NDK+Thompson's variance is higher due to the priority cascade constraining Thompson to the third scoring tier.

*10-run variance study confirms the fiatjaf regression is consistent (14.4% +/- 1.3, well below baseline 32.1% in every run), not a single-run artifact. Follower counts differ from the adjacent Welshman+Thompson table because the NDK benchmark was run on a different date with a different follower-graph snapshot.*

### 2. Dead relay filtering saves your connection budget

NIP-66 publishes relay liveness data. Filtering out dead relays before running any algorithm means you stop wasting connections on relays that will never respond. The benefit is **efficiency** — fewer wasted slots in your 20-connection budget — not a coverage guarantee. Event recall impact is roughly neutral: stochastic algorithms gain ~+5pp, while Thompson Sampling and Greedy show negligible or slightly negative impact (likely noise from stochastic selection variance and intermittently available relays).

**What to do:** Fetch NIP-66 monitor data (kind 30166), classify relays as online/offline/dead, exclude dead ones before relay selection ([code below](#nip-66-pre-filter)).

| Profile (follows) | Relay success without NIP-66 | With NIP-66 | Relays removed |
|---|---|---|---|
| fiatjaf (194) | 56% | 87% | 93 (40%) |
| Gato (399) | 26% | 80% | 454 (66%) |
| Telluride (2,784) | 30% | 74% | 1,057 (64%) |

*Relay success rate = % of selected relays that actually respond to queries. This is an efficiency improvement (fewer wasted connections), not necessarily more events retrieved.*

**Speed impact:** Across 10 profiles (4,587 relay queries), NIP-66 pre-filtering reduces feed load time by 45% (40s → 22s). Dead relays each burn a 15-second timeout that blocks a concurrency slot from querying live relays.

**Relay list pollution is worse than expected.** NIP-11 probing across 36 profiles (13,867 relay-user pairs) shows 46% of relay-user pairs point to relays that won't serve content — offline (34%), paid (7%), restricted (4%), or auth-gated (0.5%). Another 17% lack NIP-11 but are likely functional (NIP-11 is voluntary — ~500 relays don't serve it, per nostr.watch). Nearly half of all unique relay URLs in NIP-65 lists are offline. The most common dead relays (`relay.nostr.band`, `nostr.orangepill.dev`, `nostr.zbd.gg`) appear in 32-34 of 36 tested profiles. Use NIP-66 liveness (WebSocket connectivity) rather than NIP-11 to filter dead relays. See [Section 5.3](OUTBOX-REPORT.md#53-misconfigured-relay-lists) for the full breakdown.

### 3. Per-author relay diversity beats popularity-based selection

At 1 year, greedy set-cover gets only 16% event recall. Welshman's stochastic scoring gets 24% — 1.5× better. Filter Decomposition (rust-nostr, deterministic) does even better at 25%. (All 6-profile means.) The winning factor isn't randomness vs determinism — it's **relay diversity**. Algorithms that give each author their own relay picks (FD's per-author top-N, Welshman's random perturbation) discover small/niche relays that retain events well. Algorithms that concentrate on popular relays (greedy, popularity-weighted) fill the 20-relay budget with the same high-volume relays that prune old events aggressively. FD's median per-author recall (87.5% on ODELL/1,779 follows) vs Welshman's (50.0%) shows the effect: FD gives equitable coverage across authors, while popularity weighting gets high recall for authors on popular relays but zero for authors on niche ones. At 7 days all algorithms cluster at 83-84% — the differences only emerge at longer windows where relay retention diverges. Note: stochastic results have meaningful run-to-run variance (±2–8pp depending on profile size).

**What to do:** If you use greedy set-cover, switch to per-author relay selection (Filter Decomposition) or stochastic scoring (Welshman). Either way, upgrade to Thompson Sampling for the biggest gains — learning steers toward relays that actually deliver, regardless of popularity.

### 4. Latency: when to stop waiting for relays

Feed queries to 20 outbox relays produce the first event in **530-670ms** across all tested profiles (194–2,784 follows). The algorithm doesn't matter — TTFE depends on which relay responds fastest, and all algorithms include at least one fast relay. What matters is when to *stop* waiting for the rest.

**The EOSE-race tradeoff.** When your fastest relay finishes (sends EOSE), you have a fraction of your total recall. Each additional second of waiting adds more events from slower relays. Across 7 profiles:

| Grace after first EOSE | Completeness (% of eventual recall) | What you lose |
|:---:|:---:|---|
| **+0ms** (stop immediately) | 0–62% | Most events. Only works for 1-2 relay setups. |
| **+500ms** | 5–93% | Highly variable. Small profiles OK, large profiles still low. |
| **+1s** | 5–93% | Better but still unreliable for large follow sets (jb55, Telluride at 5–42%). |
| **+2s** | 86–99% | **Sweet spot.** Even the largest profile (2,784 follows) gets 86-87%. |
| **+5s** | 89–100% | Nearly complete. Only Telluride (2,784 follows) below 100% due to timeouts. |

**Coverage and latency are directly opposed.** More relays = more events found, but longer to collect them all. This is the fundamental tradeoff:

| Relays queried | Recall ceiling | At first EOSE | At +2s | At +5s |
|:---:|:---:|:---:|:---:|:---:|
| 2 (Big Relays) | 50–77% | 100% | 100% | 100% |
| 4 (Ditto-Mew) | 62–86% | 8–84% | 85–100% | 85–100% |
| 20 (Outbox) | 81–98% | 0–62% | 86–99% | 89–100% |

Two relays finish instantly but miss half the events. Twenty relays find nearly everything but take 2-5s to converge. **Hybrid outbox side-steps this**: show app relay events immediately (2-4 relay speed), stream in outbox events in the background (20-relay coverage). The user sees *something* in <600ms and *everything* within 2-5s.

**Profile-view latency.** Querying an author's top 3 NIP-65 write relays for a profile view takes **750-920ms median** (96-100% hit rate). This is algorithm-independent — every profile view does the same outbox lookup.

**Practical timeout settings:**
- **EOSE-race grace period**: 2s for feeds (86-99% completeness), 5s for archival/search
- **Individual relay timeout**: 15s (matches most relay EOSE timeouts)
- **Profile-view timeout**: 3s (covers p95 of 1.7-2.5s)
- **Dead relay cost**: Each dead relay burns a full 15s timeout. NIP-66 filtering removes 40-66% of dead relays — this is as much a latency optimization as a connection budget one.

**Showing late-arriving events.** The EOSE-race means your feed renders in <1s but more events arrive over the next 2-5s. Use a "N new posts" banner (like Twitter) to buffer late events without reflowing the user's reading position. For profile views, use shimmer placeholders that resolve as relays respond. See [IMPLEMENTATION-GUIDE.md § Showing late-arriving events](IMPLEMENTATION-GUIDE.md#showing-late-arriving-events-in-the-ui) for visual examples and code.

*Latency data from 7 cross-profile benchmarks (194–2,784 follows, 178–1,234 relays). See [OUTBOX-REPORT.md § 8.7](OUTBOX-REPORT.md#87-latency-simulation) for full data.*

### 5. Make your feed fill in faster by learning relay speed

TTFE (first event) is fast and algorithm-independent — 530-670ms regardless of algorithm. But *how fast the full feed populates* is improvable. Adding a latency discount to Thompson scoring steers selection toward fast relays, so more events arrive within the first 2 seconds.

**The change:** Multiply each relay's Thompson score by `1 / (1 + latencyMs / 1000)`. Learn `latencyMs` from your own connect+query measurements using an exponential moving average (EWMA, α=0.3). Cold start = no latency data = discount of 1.0 (identical to base Thompson).

```typescript
// After Thompson scoring, add one line:
const latencyMs = relayStats.get(relay)?.latencyMs;  // EWMA from past queries
const discount = latencyMs !== undefined ? 1 / (1 + latencyMs / 1000) : 1.0;
const score = quality * (1 + Math.log(weight)) * sampleBeta(alpha, beta) * discount;
```

The discount is hyperbolic, not exponential — a slow-but-reliable relay at 2s still competes (discount 0.33) if it has strong delivery. A fast relay at 200ms gets 0.83. A 5s relay is near-excluded at 0.17.

**Cross-profile results (6 profiles × 5 sessions, 7d window, Welshman+Thompson+Latency):**

| Profile size | Completeness @2s gain | Recall cost | Verdict |
|:---:|:---:|:---:|---|
| < 500 follows | **+10-11pp** | −0.5 to −1pp | Clear win — near-free improvement |
| 500–1000 follows | **+16pp** | −8pp | Best sweet spot — biggest @2s gain |
| 1000+ follows | +5-6pp | −11 to −14pp | Steep tradeoff — tune or skip |

**What to do:** For apps targeting typical users (< 500 follows), add the latency discount unconditionally — it's a 1-line change with near-zero recall cost. For apps targeting power users (1000+ follows), either make the discount strength tunable or skip it if total recall matters more than feed population speed.

**Why learn latency yourself:** Your measured connect+query times reflect your users' actual experience. Each relay's performance varies by client location, time of day, and load. The EWMA adapts to this naturally — a relay that gets slow gets deprioritized, one that speeds up gets promoted. Persist the EWMA alongside your Thompson Sampling stats (same DB table, one extra column).

*Data: 6 profiles (194–2,795 follows), 5 learning sessions each, 7d window, NIP-66 liveness filtered, cap@20. FD+Thompson+Latency shows the same pattern with ~2× the recall cost — Welshman variant is strictly safer. See [OUTBOX-REPORT.md § 8.6](OUTBOX-REPORT.md#86-latency-aware-thompson-sampling) for per-profile tables and session progression.*

### 6. 20 relay connections is enough

All algorithms reach within 1-2% of their unlimited ceiling at 20 relays.

**What to do:** Cap at 20 connections. For the ~3-5% of active follows without relay lists, use fallback strategies (relay hints from tags, indexer queries, hardcoded popular relays).

## Algorithm quick reference

All deployed client algorithms plus key experimental ones:

| Algorithm | Used by | 1yr recall | 7d recall | Verdict |
|---|---|:---:|:---:|---|
| **Welshman+Thompson** | *not yet deployed* | 39% [26–45] | 88% [84–92] | Upgrade path for Coracle — learns from delivery (10-run mean) |
| **FD+Thompson** | *not yet deployed* | 37% [25–44] | 85% [77–91] | Upgrade path for rust-nostr — learns from delivery (10-run mean) |
| **Hybrid+Thompson** | *not yet deployed* | ‡ | — | Upgrade path for app-relay clients — no routing changes |
| **Filter Decomposition** | rust-nostr | 25% [19–32] | 77% [71–88] | Per-author top-N write relays; strong at long windows |
| **Welshman Stochastic** | Coracle | 24% [12–38] | 83% [75–93] | Best stateless deployed algorithm for archival — 1.5× Greedy at 1yr |
| **Greedy Set-Cover** | Gossip, Applesauce, Wisp | 16% [12–20] | 84% [77–94] | Best on-paper coverage; degrades sharply for history |
| **NDK+Thompson** | *not yet deployed* | 31% [14–39] | — | Upgrade path for NDK — learns from delivery (10-run mean). High variance: -18pp to +25pp gain vs NDK baseline. |
| **NDK Priority** | NDK | 16% [12–19] | 83% [77–92] | Similar to Greedy; connected > selected > popular |
| **Coverage Sort** | Nostur | 16% [9–22] | 65% [55–80] | Skip-top-relays heuristic costs 5-12% coverage |

**Baselines** (for comparison, not recommendations):

| Baseline | 1yr recall | 7d recall | What it is |
|---|:---:|:---:|---|
| Direct Mapping\*\* | 30% [17–40] | 88% [86–91] | All declared write relays — unlimited connections |
| Ditto-Mew (4 app relays) | 6% [5–7] | 62% | 4 hardcoded app relays — broadcast, no per-author routing |
| Big Relays | 8% [5–12] | 61% [45–70] | Just damus+nos.lol — the "do nothing" baseline |
| Primal Aggregator\*\*\* | <1% [0.2–1.6] | 32% [25–37] | Single caching relay — 100% assignment but low actual recall |

*1yr and 7d recall: 6-profile means from cross-profile benchmarks (Section 8.2 of [OUTBOX-REPORT.md](OUTBOX-REPORT.md)). [min–max] ranges show the spread across tested profiles (194–2,784 follows). All testable-reliable authors, 20-connection cap except Direct Mapping. Thompson 1yr = 10-run grand mean, S5 converged, NIP-66 liveness filtered, `--no-phase2-cache`. Thompson 7d from HJO benchmark (6 profiles × 5 sessions). ‡Hybrid+Thompson 1yr under re-benchmarking. NDK+Thompson 1yr = 31% [14–39] (10-run mean, genuine, `--no-phase2-cache`). Welshman+Thompson and FD+Thompson converge within 3-5 sessions. NDK+Thompson converges by session 3-4 (slower due to the priority cascade limiting Thompson's influence) and shows high variance (-18pp to +25pp gain, +11pp mean). Stochastic algorithms have additional run-to-run variance on top of the cross-profile range (see [variance analysis](OUTBOX-REPORT.md#82-approximating-real-world-conditions-event-verification)). Ditto-Mew baseline = 4-profile mean with NIP-66.*

*\*\*Direct Mapping uses unlimited connections (all declared write relays, typically 50-200+). Its high recall reflects connection count, not algorithmic superiority.*

*\*\*\*Primal's low recall may reflect a benchmark methodology limitation (querying a caching aggregator as if it were a standard relay) rather than a definitive measure of aggregator quality. App devs using Primal should test against their own use cases.*

<details>
<summary>All 25 algorithms</summary>

**Deployed in clients:**

| Algorithm | Client | Strategy |
|---|---|---|
| Greedy Set-Cover | Gossip, Applesauce, Wisp | Iterative max-uncovered |
| Priority-Based | NDK | Connected > selected > popular |
| Weighted Stochastic | Welshman/Coracle | `quality * (1 + log(weight)) * random()` |
| Greedy Coverage Sort | Nostur | Sort by count, skip top 3 |
| Filter Decomposition | rust-nostr | Per-author top-N write relays |
| Direct Mapping | Amethyst (feeds) | All declared write relays |
| Primal Aggregator | Primal | Single aggregator relay |
| Jumble Coverage Pruning | Jumble | Coverage-weighted pruning |
| Voyage Multi-Phase | Voyage | Lexicographic boolean tuple scoring, autopilot max 25 relays |
| Ditto-Mew (4 app relays) | Ditto (broadcast) | 4 hardcoded app relays, no per-author routing |

**Baselines:**

| Algorithm | Strategy |
|---|---|
| Popular+Random | Top popular + random fill |
| Big Relays | Just damus+nos.lol — the "do nothing" baseline |

**Experimental — actionable** (not yet in any client, but deployable):

| Algorithm | Strategy |
|---|---|
| Welshman+Thompson | Welshman scoring with `sampleBeta(α,β)` instead of `random()` — learns from delivery |
| FD+Thompson | Filter Decomposition scoring with `sampleBeta(α,β)` — learns without popularity bias |
| NDK+Thompson (Priority) | NDK priority cascade + Thompson scoring in popularity tier — learns from delivery |
| NDK+Thompson (Unified) | NDK with soft selected-relay bonus (1.5x) + Thompson scoring — all tiers scored |
| Ditto+Outbox Thompson | App relays + per-author outbox (top 3 write relays by Thompson) — no routing layer changes |
| Greedy+ε-Explore | Greedy with 5% chance of picking a random relay instead of the best |

**Academic** (benchmark ceilings only — not practical for real clients):

| Algorithm | Strategy | Why not practical |
|---|---|---|
| ILP Optimal | Brute-force best answer | NP-hard, requires solver, exponential worst-case |
| MAB-UCB | 500 simulated rounds of explore/exploit | Too slow — defines ceiling, not shippable |
| Bipartite Matching | Weighted matching for hard-to-reach pubkeys | O(V²E), complex, marginal gains |
| Spectral Clustering | Eigendecomposition of relay-author matrix | Requires linear algebra library |
| Streaming Coverage | Single-pass submodular maximization | Marginal gains over simpler greedy |
| Stochastic Greedy | Random subset sampling per step | Worse than standard greedy at this scale |
| Hybrid Greedy+Explore | Greedy base + stochastic exploration slots | Complex, marginal gains over greedy+ε |

**Full benchmark data:** [OUTBOX-REPORT.md Section 8](OUTBOX-REPORT.md#8-benchmark-results)

</details>

## How to implement

### Thompson Sampling

Replace `random()` in Welshman's scoring with `sampleBeta(successes, failures)` per relay. This keeps the beneficial randomness, adds learning, and is ~80 lines of code. **If you use rust-nostr/Filter Decomposition**, use [FD+Thompson](#fdthompson-for-rust-nostr) instead — same idea but without the popularity weight, which fits Filter Decomposition's per-author structure better.

```typescript
// Current Welshman (stateless):
const score = quality * (1 + Math.log(weight)) * Math.random();

// With Thompson Sampling (learns from delivery):
function sampleBeta(a: number, b: number): number {
  const x = gammaVariate(a);
  return x / (x + gammaVariate(b));
}
const alpha = stats.eventsDelivered + 1;  // successes + prior
const beta = stats.eventsExpected - stats.eventsDelivered + 1;  // failures + prior
const score = quality * (1 + Math.log(weight)) * sampleBeta(alpha, beta);
```

Track per-relay stats in a small table (~100 bytes per relay):

```sql
CREATE TABLE relay_stats (
  relay_url TEXT PRIMARY KEY,
  times_selected INTEGER DEFAULT 0,
  events_delivered INTEGER DEFAULT 0,
  events_expected INTEGER DEFAULT 0,
  last_selected_at INTEGER,
  latency_ms REAL           -- optional: EWMA of connect+query time (§5)
);
```

The full integration loop:

```typescript
// On app startup:
const relayStats = await db.loadRelayStats(); // {relay → (delivered, expected)}

// When building a feed subscription:
function selectRelays(candidates: RelayCandidate[], budget: number): string[] {
  const scored = candidates.map(r => {
    const stats = relayStats.get(r.url) ?? { delivered: 0, expected: 0 };
    const alpha = stats.delivered + 1;  // Beta prior: successes + 1
    const beta = stats.expected - stats.delivered + 1;  // failures + 1
    return {
      url: r.url,
      score: r.quality * (1 + Math.log(r.weight)) * sampleBeta(alpha, beta)
    };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, budget).map(r => r.url);
}

// After receiving events, update stats:
function updateStats(selectedRelays: string[], eventsPerRelay: Map<string, number>) {
  for (const relay of selectedRelays) {
    const stats = relayStats.get(relay) ?? { delivered: 0, expected: 0 };
    const delivered = eventsPerRelay.get(relay) ?? 0;
    stats.delivered += delivered > 0 ? 1 : 0;  // binary: did it deliver anything?
    stats.expected += 1;
    relayStats.set(relay, stats);
  }
  db.saveRelayStats(relayStats);  // persist for next session
}
```

### FD+Thompson (for rust-nostr)

If you use Filter Decomposition (rust-nostr's `break_down_filter()`), FD+Thompson is a drop-in upgrade: score each author's write relays by `sampleBeta(α, β)` instead of lexicographic order. No popularity weight — the score is purely learned delivery performance:

```typescript
// Current Filter Decomposition (stateless):
// Sort write relays lexicographically, take top N
const selected = authorWriteRelays.sort().slice(0, writeLimit);

// With FD+Thompson (learns from delivery):
const scored = authorWriteRelays.map(relay => {
  const stats = relayStats.get(relay) ?? { delivered: 0, expected: 0 };
  const alpha = stats.delivered + 1;
  const beta = stats.expected - stats.delivered + 1;
  return { relay, score: sampleBeta(alpha, beta) };
});
const selected = scored.sort((a, b) => b.score - a.score)
  .slice(0, writeLimit).map(r => r.relay);
```

Same `sampleBeta()`, same stats table, same update loop as [Thompson Sampling above](#thompson-sampling). The only difference: no `(1 + Math.log(weight))` multiplier. This avoids biasing toward popular relays that many authors declare but that prune aggressively — scoring purely from observed delivery.

**1yr cross-profile results after 5 learning sessions (cap@20, NIP-66 filtered):**

| Profile (follows) | FD+Thompson (S5) | Welshman+Thompson (S5) | Gap |
|---|:---:|:---:|:---:|
| fiatjaf (194) | 44.0% | 41.5% | +2.5pp |
| hodlbod (442) | 40.3% | 46.3% | -6.0pp |
| jb55 (943) | 43.3% | 46.6% | -3.3pp |
| ODELL (1,779) | 42.4% | 41.6% | +0.8pp |
| Gato (399) | 27.2% | 28.2% | -1.0pp |
| Telluride (2,784) | 43.5% | 47.1% | -3.6pp |
| **6-profile mean** | **40.1%** [27–44] | **41.9%** [28–47] | **-1.8pp** |

*Single-run data shown above for per-profile detail. 10-run variance study confirms: FD+Thompson 37.2% +/- 2.8 SE, Welshman+Thompson 39.0% +/- 2.7 SE, gap ~2pp. The FD controlled comparison at 1yr shows +14pp mean gain over FD baseline. Both converge within 3-5 sessions. At 7d (HJO data), Welshman+Thompson leads by ~2-5pp. See [Section 8.4](OUTBOX-REPORT.md#84-fdthompson-filter-decomposition-with-thompson-sampling) for the full comparison.*

### Hybrid outbox (for app-relay clients)

If your client uses a fixed set of app relays (like Ditto-Mew's 4 relays, or any client with hardcoded relay URLs), you can add outbox routing to profile views and event lookups without changing your feed routing. The app relays handle the main feed. Outbox relays handle long-tail content.

The pattern has three parts:

**1. Profile views** — when loading a user's profile, fetch their kind 10002 relay list, pick top 3 write relays by Thompson score, and query them in parallel with your app relays:

```typescript
// Profile feed: app relays (fast path) + outbox relays (parallel enrichment)
async function fetchProfileFeed(nostr, pubkey, filter) {
  // Fast path: query app relays as usual
  const appPromise = nostr.query([filter]);

  // Parallel: look up author's write relays, score, query top 3
  const outboxPromise = fetchOutboxEvents(nostr, pubkey, filter);

  const [appEvents, outboxEvents] = await Promise.all([appPromise, outboxPromise]);

  // Merge and deduplicate
  const seen = new Set();
  const merged = [];
  for (const ev of [...appEvents, ...outboxEvents]) {
    if (!seen.has(ev.id)) { seen.add(ev.id); merged.push(ev); }
  }
  return merged;
}

async function fetchOutboxEvents(nostr, pubkey, feedFilter) {
  const relayList = await nostr.query([{ kinds: [10002], authors: [pubkey], limit: 1 }]);
  if (!relayList.length) return [];

  const writeRelays = relayList[0].tags
    .filter(([name, , marker]) => name === 'r' && marker !== 'read')
    .map(([, url]) => url).filter(Boolean);

  const top3 = scorer.rank(writeRelays).slice(0, 3);
  const events = await nostr.group(top3).query([feedFilter]);

  for (const url of top3) scorer.update(url, events.length > 0);
  scorer.persist();
  return events;
}
```

**2. Event lookups** — rank relay hints and NIP-65 write relays by Thompson score before querying:

```typescript
// Tier 2: sort relay hints by Thompson score
const rankedHints = scorer.rank(relayHints);
const hintEvents = await nostr.group(rankedHints).query(filter);

// Tier 3: author's write relays, top 3 by Thompson
const writeRelays = extractWriteRelays(authorRelayList);
const ranked = scorer.rank(writeRelays);
const events = await nostr.group(ranked.slice(0, 3)).query(filter);
```

**3. Thread traversal** — propagate relay hints from `e` tags so each ancestor lookup uses the hint from the child event:

```typescript
// NIP-10 e-tag: ["e", <event-id>, <relay-url>, <marker>, <pubkey>]
const parentRef = getParentEventRef(event); // { id, relay?, author? }
// Pass relay hint and author hint to useEvent for the parent lookup
useEvent(parentRef.id, parentRef.relay ? [parentRef.relay] : undefined, parentRef.author);
```

**1yr benchmark results (4-profile mean, cap@20, NIP-66, 5 sessions):**

*⚠️ Methodology note: These 1yr multi-session numbers were collected with a phase2 cache bug that inflated S2+ verification recall. Re-benchmarking in progress. See [methodology note](#methodology-note-phase2-cache-bug).*

| | Ditto-Mew baseline | Hybrid+Thompson | Delta |
|---|--:|--:|--:|
| **Event recall** | 6.2% [5–7] | ‡ | — |
| **Author recall** | 62.2% | ‡ | — |

*‡1yr hybrid recall under re-benchmarking. Converges by session 2. See [OUTBOX-REPORT.md § 8.5](OUTBOX-REPORT.md#85-hybrid-outbox-app-relay-broadcast--per-author-thompson) for per-profile data and [bench/src/algorithms/ditto-outbox.ts](bench/src/algorithms/ditto-outbox.ts) for the benchmark implementation.*

### NIP-66 pre-filter

Fetch relay liveness from NIP-66 monitors and exclude dead relays before running your selection algorithm:

```typescript
// Fetch NIP-66 monitor data (kind 30166) and classify relays
async function filterLiveRelays(candidateRelays: string[]): Promise<string[]> {
  const monitorEvents = await pool.querySync(
    ["wss://relay.nostr.watch"], // NIP-66 monitor relay
    { kinds: [30166] }
  );
  const alive = new Set(monitorEvents.map(e => e.tags.find(t => t[0] === "d")?.[1]).filter(Boolean));
  return candidateRelays.filter(url => alive.has(url));
}

// Use it before any relay selection algorithm:
const liveRelays = await filterLiveRelays(allDeclaredRelays);
const selected = runYourAlgorithm(liveRelays, budget);
```

### Delivery check (self-healing)

Periodically verify that your outbox relays are actually returning events. When gaps are found, add fallback relays automatically:

```typescript
async function checkDelivery(author: string, outboxRelays: string[]) {
  const fromOutbox = await queryEvents(outboxRelays, { authors: [author], limit: 50 });
  const fromIndexer = await queryEvents(["wss://relay.nostr.band"], { authors: [author], limit: 50 });
  const missing = fromIndexer.filter(e => !fromOutbox.has(e.id));
  if (missing.length > 5) {
    addFallbackRelay(author, fromIndexer.bestRelay);
  }
}
```

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

# Specific algorithms
deno task bench <npub_or_hex> --algorithms greedy,welshman,welshman-thompson,mab

# Multi-session Thompson Sampling (5 learning sessions)
bash run-benchmark-batch.sh
```

Run `deno task bench --help` for all options. See [Benchmark-recreation.md](Benchmark-recreation.md) for full reproduction instructions.

## Help wanted: benchmark from your location

All data in this report was collected from a single observer. Relay latency,
success rates, and timeout behavior are location-dependent — someone in Brazil,
Southeast Asia, or on a VPN will see different numbers. We need benchmark runs
from different locations to validate whether findings generalize.

**What to run** (takes ~30 min, needs Deno v2+ and internet):

```bash
cd bench
deno task bench 3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d \
  --verify --verify-window 604800 \
  --nip66-filter liveness --no-phase2-cache \
  --output both
```

**What to share:** Open an issue with your JSON file from `bench/results/`,
your approximate location (country/region), and connection type (home, VPN,
cloud, mobile).

**What should vary by location:** TTFE, relay success rates, timeout counts,
NIP-66 RTT correlation strength (NIP-66 monitors are in specific locations —
correlation from your vantage point may be stronger or weaker).

**What should be stable:** Relative algorithm rankings, relay retention
patterns, which algorithms benefit from NIP-66 filtering.

## Repo structure

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

## Methodology note: phase2 cache bug

The phase2 baseline cache (`bench/src/phase2/cache.ts`, fixed in schema v2) had a lossy serialization bug: it stored the **union** of event IDs across all relays but lost per-relay mappings. When loaded in sessions 2+, the full union was assigned to every relay that had events, inflating verification recall. A deterministic algorithm like NDK baseline jumped from ~16% (S1, genuine) to ~96% (S2+, inflated) despite selecting the same relays.

**What was affected:** All multi-session 1yr/3yr Thompson claims from the original `run-benchmark-batch.sh` (Welshman+Thompson, FD+Thompson, Hybrid+Thompson). The batch script did not use `--no-phase2-cache`.

**What was always trustworthy:**
- **Session 1 data** — no cache on first session, always genuine
- **7d HJO data** — 6 profiles × 5 sessions × 4 Thompson algorithms, genuine multi-session
- **NDK+Thompson 1yr** — collected with `--no-phase2-cache`, genuine
- **All stateless algorithm numbers** — unaffected (no learning, no cache dependency)

**Resolution:** Cache code fixed (schema v2 stores per-relay event IDs). Batch script updated to use `--no-phase2-cache`. 1yr Thompson re-benchmarked across 6 profiles x 5 sessions with genuine methodology — results now reflected in all tables above. The original inflated claims (84-89% 1yr) were replaced with genuine numbers (39% [26-45] 1yr, 10-run mean).

**10-run variance study (March 2026).** To quantify Thompson Sampling's stochastic variance, we ran 10 independent 5-session benchmarks for each of 3 algorithm variants (Welshman+Thompson, FD+Thompson, NDK+Thompson) across 6 profiles at 1yr. Results: Welshman+Thompson 39.0% +/- 2.7 SE (per-profile std 0.9-8.0pp), FD+Thompson 37.2% +/- 2.8 SE, NDK+Thompson 30.8% +/- 3.8 SE. All Thompson gains over their respective baselines are statistically significant and consistent across runs. The fiatjaf regression in NDK+Thompson is confirmed as systematic (14.4% +/- 1.3, well below NDK baseline 32.1% in every run). FD controlled comparison at 1yr shows +14pp mean gain. 3yr baselines: Welshman 19.2%, FD 16.6%, Greedy 13.6%, NDK 13.3%. 3yr Thompson paired deltas: WT +7.2pp, FD +8.6pp, NDK +8.8pp (all significant). The 3yr results show Thompson gains persist and even increase at longer time windows where relay retention diverges further.

## Links

- [Full Analysis Report](OUTBOX-REPORT.md) — 15-client cross-analysis + complete benchmark data
- [Implementation Guide](IMPLEMENTATION-GUIDE.md) — Detailed recommendations with code examples
- [Cross-Client Comparison](analysis/cross-client-comparison.md) — How 15 clients make each decision
- [Benchmark Recreation](Benchmark-recreation.md) — Reproduce all results
- [nostrability#69](https://github.com/nostrability/nostrability/issues/69) — Parent issue
- [NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md) — Relay List Metadata specification
- [Building Nostr](https://building-nostr.coracle.social) — Protocol architecture guide (relay routing, content migration, bootstrapping)
- [replicatr](https://github.com/coracle-social/replicatr) — Event replication daemon for relay list changes (negentropy sync)
