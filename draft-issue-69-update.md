### Overview

Outbox (and inbox) refers to the technical implementation of finding events of interest not found on the relays user is subscribed to.

### Meme

https://github.com/user-attachments/assets/ffc898b9-a549-4337-81b0-322c4ae4efc4

### Visual Explainer

https://how-nostr-works.pages.dev/#/outbox

### Benefit
1) non-💩 user experience (missing events; missed opportunities for excellent, positive interactions)
2) improved censorship resistance

### Benchmark & Implementation Guide

https://github.com/nostrability/outbox — 25 algorithms benchmarked across 7 real profiles (194-2,784 follows), 6 time windows, with and without NIP-66 liveness filtering. Per-client analysis, code examples, and upgrade paths.

---

### Implementation Status

Having outbox ✅ is not enough — algorithm quality determines whether events are actually found. The **1yr recall** column shows the percentage of events an algorithm finds at a 1-year time window across benchmarked profiles ([source](https://github.com/nostrability/outbox)). 7-day recall masks retention problems — most algorithms look fine at 7d (77-94%) but diverge sharply at 1yr (8-30%). Thompson Sampling: 39% [26-45] at 1yr after learning (+9pp over baseline, 10-run validated); 84-92% at 7d (+4-7pp over baseline — 7d baseline is already 79-90%).

| App / Library | Outbox | Inbox | Algorithm | 1yr Recall | Comment |
|---|:---:|:---:|---|:---:|---|
| amethyst | ✅ | ✅ | direct mapping (unlimited conns) | 30% [17–40] | [full outbox PR](https://github.com/vitorpamplona/amethyst/pull/1388). >300 follows is the scaling cliff |
| coracle | ✅ | ✅ | welshman stochastic | 24% [12–38] | best stateless deployed algo for archival. ~80 LOC Thompson upgrade: 39% [26-45] 1yr, 84-92% 7d. [Details](https://github.com/nostrability/outbox/blob/main/analysis/clients/welshman-coracle.md) |
| nostrudel | ✅ | ✅ | greedy set-cover (applesauce) | 16% [12–20] | full outbox via [applesauce](https://github.com/hzrd149/applesauce). [analysis](https://github.com/nostrability/outbox/blob/main/analysis/clients/ndk-applesauce-nostrudel.md) |
| nostur | ✅ | ✅ | coverage sort + skipTopRelays | 16% [9–22] | skipTopRelays costs 5-12% coverage. random relays limited to follows or relay hints. [analysis](https://github.com/nostrability/outbox/blob/main/analysis/clients/nostur-yakihonne-notedeck.md) |
| gossip | ✅ | ✅ | greedy set-cover | 16% [12–20] | per-pubkey scoring with temporal decay. [analysis](https://github.com/nostrability/outbox/blob/main/analysis/clients/gossip.md) |
| NDK | ✅ | ✅ | priority-based | 16% [12–19] (31% [14–39] with Thompson, 10-run mean) | connected > selected > popular. Thompson upgrade benchmarked: +11pp mean (6 profiles, 10-run validated), high variance. [analysis](https://github.com/nostrability/outbox/blob/main/analysis/clients/ndk-applesauce-nostrudel.md) |
| rust-nostr | ✅ | ✅ | filter decomposition | 25% [19–32] | per-author top-N write relays. inbox merged in v0.35. [analysis](https://github.com/nostrability/outbox/blob/main/analysis/clients/rust-nostr-voyage-nosotros-wisp-shopstr.md) |
| voyage | ✅ | ✅ | multi-phase greedy | — | lexicographic boolean tuple scoring. autopilot max 25 relays |
| wisp | ✅ | ✅ | greedy coverage | 16% [12–20] | max 75 scored relays. [relay scoreboard](https://github.com/barrydeen/wisp/blob/main/app/src/main/kotlin/com/wisp/app/relay/RelayScoreBoard.kt) |
| nosotros | ✅ | ✅ | event-count sort | — | observable pipeline, configurable 1-14 relays/user |
| primal | ? | ? | ? | — | unique/first to nostr indexer approach used today |
| yakihonne (web) | ✅ | ✅ | NDK outbox (`enableOutboxModel: true`) | — | NDK handles per-author read routing. Write-side: publishes replies/reactions to recipient's kind 10002 read relays (top 2). Manages kind 10050 inbox relays. 5 platform default relays + user relays |
| yakihonne (mobile) | ⚠️ | ✅ | optional gossip mode (off by default) | — | Flutter/Dart. Write-side inbox always on (`broadcastRelays` → recipient's read relays, top 2). Read-side outbox only when gossip mode enabled in settings (`calculateRelaySet` from contacts' outbox relays). Gossip off by default. [analysis](https://github.com/nostrability/outbox/blob/main/analysis/clients/nostur-yakihonne-notedeck.md) covers mobile with gossip off |
| shopstr | ❌ | ❌ | none (localStorage list) | N/A | own relay config only. [analysis](https://github.com/nostrability/outbox/blob/main/analysis/clients/rust-nostr-voyage-nosotros-wisp-shopstr.md) |
| damus (iOS) | ❌ | ❌ | none | N/A | [experimental outbox PR](https://github.com/damus-io/damus/pull/3291) |
| notedeck | ❌ | ❌ | none (planned) | N/A | NIP-65 infra exists, [outbox PR #1288](https://github.com/damus-io/notedeck/pull/1288) pending. [analysis](https://github.com/nostrability/outbox/blob/main/analysis/clients/nostur-yakihonne-notedeck.md) |
| [Dart NDK](https://github.com/relaystr/ndk) | ✅ | ? | ? | — | used by [yana](https://github.com/frnandu/yana), [camelus](https://github.com/leo-lox/camelus) |
| futr | ✅ | ? | ? | — | https://github.com/futrnostr/futr/pull/41 |
| [nostrSDK](https://github.com/nostr-sdk) | ? | ? | ? | — | planned @tyiu |

**Not yet implemented by any client:** [Thompson Sampling](https://github.com/nostrability/outbox#thompson-sampling) — ~80 LOC upgrade that learns from relay delivery. At 1yr: 39% [26-45] after 3-5 sessions (+9pp over 30% stochastic baseline, 10-run validated). At 7d: 84-92% after learning (+4-7pp over 79-90% baseline). 1yr gains limited by relay retention. Works on top of Welshman, filter decomposition, or hybrid approaches.

---

### Key Findings from Benchmarks

**Key learning: how much does Thompson Sampling actually help?** It depends on the time window. At 7d (most relays have events), the stochastic baseline is already 79-90% and Thompson adds +4-7pp. At 1yr (relay retention becomes the binding constraint), Thompson adds +9pp (30% → 39%, 10-run validated, 6-profile mean). At 3yr, +7pp — but the hard ceiling is retention, not selection. Per-profile gains range 0 to +15pp; profiles with diverse relay graphs benefit most.

**1. Relay list pollution is worse than expected.** NIP-11 probes of 13,867 relay-user pairs across 36 profiles: only **37% point to functional content relays**. 34% are offline, 11% are paid/restricted, 17% have no NIP-11 (likely OK). The most common dead relays (relay.nostr.band, nostr.orangepill.dev, nostr.zbd.gg) appear in 32-34 of 36 profiles. 20-44% of follows don't have a kind 10002 at all. ([source](https://github.com/nostrability/outbox#relay-list-pollution-is-worse-than-expected))

**2. NIP-66 liveness filtering gives a 45% wall-clock speedup.** Dead relays waste ~15 seconds of timeout each. Filtering them out raises relay success rate from ~30% to ~75%. This is a latency/efficiency win — it removes relays that would never respond. No client currently does this. ([NIP-66 comparison report](https://github.com/nostrability/outbox/blob/main/bench/NIP66-COMPARISON-REPORT.md)) ([NIP-66 discussion](https://github.com/nostrability/nostrability/issues/69#issuecomment-2689166816))

**3. Learning beats static optimization.** Thompson Sampling — tracking which relays actually deliver events — is the single biggest available upgrade. At 1yr: +9pp gain (30% → 39% [26-45], 10-run validated). At 7d: +4-7pp gain (79-90% → 84-92%). 1yr gains limited by relay retention. No client implements it yet. ([Thompson Sampling details](https://github.com/nostrability/outbox#thompson-sampling))

**4. 20 relay connections is sufficient.** All algorithms reach within 1-2% of unlimited ceiling by 20 connections. Diminishing returns above that.

**5. Bootstrap centralization risk.** `relay.damus.io` appears in 8/13 implementations, `purplepag.es` in 6/13 as the primary kind 10002 indexer. If purplepag.es went offline, relay discovery for NDK, Coracle, noStrudel, Amethyst, Shopstr, and Notedeck would degrade.

**6. >300 follows is a scaling cliff** for full outbox ([Amethyst finding](https://njump.me/nevent1qqsxypzqlu7d70ur2lum8t2wp9pyg4cvsetnzfzc3pv35vpyhyvyxpqnr0jl2)). Vitor suggests breaking down contact lists and distinguishing "contacts" (WoT) from "follows" (feed).

**7. Hybrid outbox is a viable low-effort path.** ~80 LOC, no routing layer rewrite. Keep app relays for the main feed, add outbox queries only for profile views, event lookups, and thread traversal. Good for apps that can't change their feed path. 1yr recall under re-benchmarking. ([details](https://github.com/nostrability/outbox#two-ways-to-add-outbox))

---

### Answered Questions

> Is it technically possible to measure the effectiveness of various outbox implementations, as measured by notes not found?

**Yes.** 25 algorithms benchmarked across 7 profiles, 6 time windows, with real relay connections and real events. Full methodology and reproduction instructions: [Benchmark-recreation.md](https://github.com/nostrability/outbox/blob/main/Benchmark-recreation.md)

> For those who have implemented, in what conditions does your algo fail?

**Documented.** Primary failure modes: dead relays (46% of relay-user pairs), retention pruning on popular relays, auth-gated/paid relays, missing kind 10002 (20-44% of follows), stale relay selections. ([OUTBOX-REPORT.md](https://github.com/nostrability/outbox/blob/main/OUTBOX-REPORT.md))

> Has anyone measured and compared the success/failure rate across implementations?

**Yes.** Head-to-head benchmarks across all 10 client algorithms plus 15 experimental/academic/baseline algorithms. Results: greedy set-cover wins on-paper relay assignment (23/26 profiles) but degrades to 16% event recall at 1yr. Stochastic variants reach 24%. Thompson Sampling: 39% [26-45] at 1yr, 84-92% at 7d (6-profile genuine data). ([full results](https://github.com/nostrability/outbox/blob/main/OUTBOX-REPORT.md))

---

### Related to
#86 (NIP-66)
#158 (rate limiting)
#180
#234 (defunct relays)
