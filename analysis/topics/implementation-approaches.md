# Outbox Model: Implementation Approaches Across Clients and Libraries

Cross-cutting synthesis of outbox/inbox relay routing implementations across 14 Nostr projects. Data sourced from static analysis of each codebase.

---

## 1. Implementation Maturity Matrix

| Project | Read-Side Outbox | Write-Side Inbox | Kind 10002 Parsing | Per-Author Relay Routing | Relay Scoring | Health Tracking | Connection Management |
|---------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Gossip** | Full | Full | Full (read/write/both) | Full (RelayPicker greedy set-cover) | Multi-factor composite (association * relay quality) | Full (success/failure counts, exclusion timers 15s-10min) | Minion-per-relay, max 50, auto-reassign on disconnect |
| **Welshman/Coracle** | Full | Full | Full (read/write/both via `r`/`relay` tags) | Full (per-pubkey write relay lookup via `FromPubkeys`) | quality * log(weight) * random() | Tiered error thresholds (1/min, 3/hr, 10/day = quality 0) | Lazy connect-on-send, 30s inactivity close, no hard cap |
| **Amethyst** | Full | Full | Full (read/write/both via `AdvertisedRelayListEvent`) | Full (reactive `OutboxRelayLoader` flow) | None (binary: available or offline) | `RelayOfflineTracker` set + per-relay stats (ping, bytes) | Dynamic pool updated every 300ms, exponential backoff |
| **NDK** | Full | Full | Full (read/write via `r`/`relay` tags) | Full (popularity-ranked greedy assignment) | Preference for connected > already-selected > popular | Flapping detection, exponential backoff, system-wide disconnect detection | Temporary relays with 30s auto-disconnect |
| **Applesauce/noStrudel** | Full | Full | Full (cached via Symbol on event object) | Full (greedy set-cover with `maxConnections` cap) | Custom `score` function on coverage ratio | `RelayLiveness` (online/offline/dead states, exponential backoff, persistent) | Lazy relay creation, 60s keepAlive, dead relay exclusion |
| **Nostur** | Full | Full | Full (read/write/both) | Full (`createRequestPlan` greedy, `skipTopRelays`) | Priority cascade (write relay + connection stats + received-from) | Misconfigured kind 10002 detection, special-purpose relay exclusion | 3 pools (persistent, outbox max 50, ephemeral 35s) |
| **rust-nostr** | Full | Full | Full (read/write/both + NIP-17 kind 10050) | Full (bitflag-based filter decomposition) | Sort by received_events DESC, last_received_event DESC | Per-pubkey semaphore freshness checking | Configurable limits (3 read, 3 write, 1 hint per user) |
| **Voyage** | Full | Full | Full (`Nip65Entity` Room table with read/write) | Full (autopilot: NIP-65 + event-relay tracking) | Connected > not-disconnected > event-relay count | Spam relay flagging | Autopilot max 25 relays, 2 per pubkey for publish |
| **Wisp** | Full | Full | Full (`Nip65.parseRelayList`) | Full (`RelayScoreBoard` greedy set-cover, max 75) | Coverage count (greedy set-cover) | None explicit | SharedPreferences + LRU(500) relay list cache |
| **Nosotros** | Full | Full | Full (`parseRelayList` with bitflag permissions) | Full (RxJS observable per-author pipeline) | Sort by relay stats event count DESC | Relay stats DB (events, connects) | Max relays per user configurable 1-14 (default 3) |
| **Yakihonne** | None | None | Partial (decoder exists but unused for routing) | None | None | None | Static constant relays + user's own kind 10002 |
| **Notedeck** | None (planned PR #1288) | None | Full (RelaySpec with read/write markers) | None (flat pool, all relays get all messages) | None | None | Diff-based pool reconciliation, multicast relay |
| **Shopstr** | None | None | Partial (own relay config only) | None | None | None | Static relay list from localStorage |

**Legend:** Full = production-ready implementation. Partial = infrastructure exists but not used for routing. None = not implemented. Planned = in-progress PR or documented roadmap.

---

## 2. Architecture Patterns

### 2.1 By Programming Paradigm

**Reactive / Observable-driven:**
- **Amethyst** -- Kotlin `StateFlow` + `combine()`. Kind 10002 addressable notes emit changes that automatically recompute per-relay subscription filters.
- **Applesauce/noStrudel** -- RxJS `combineLatest` + `switchMap`. Full pipeline from contacts through mailbox enrichment through optimal relay selection is an observable chain. `debounceTime(500)` stabilizes async relay data arrival.
- **Nosotros** -- RxJS `mergeMap` per author. Each author's relay list resolves independently and emits relay-filter tuples into a merged stream.

**Imperative / Event-driven:**
- **Gossip** -- Rust async with message-passing (`Overlord` -> `Minion` channels). RelayPicker is a global singleton recomputed on demand.
- **NDK** -- EventEmitter pattern. `OutboxTracker` emits `user:relay-list-updated`, subscriptions listen and call `refreshRelayConnections()`.
- **Nostur** -- Swift imperative with CoreData queries. `OutboxLoader.load()` fetches kind 10002 from database, builds `PreferredRelays` struct, passes to `ConnectionPool`.
- **rust-nostr** -- Trait-based with async semaphores. `GossipRelayResolver.break_down_filter()` is a pure function called before each subscription.
- **Voyage** -- Kotlin coroutines with Room DAO queries. `RelayProvider.getObserveRelays()` runs a multi-phase imperative algorithm.
- **Wisp** -- Kotlin imperative. `RelayScoreBoard.recompute()` runs the full greedy set-cover synchronously.

### 2.2 By Layer (Library vs. Client)

**Libraries providing outbox as a reusable primitive:**
- **Welshman** (`@welshman/router`) -- Router is stateless; all relay knowledge injected via `RouterOptions` callbacks. Clients compose scenarios.
- **NDK** -- Outbox is transparent. Any `ndk.subscribe()` with author filters automatically routes through the outbox tracker.
- **Applesauce** (`@applesauce/core`) -- Pure functions (`selectOptimalRelays`, `groupPubkeysByRelay`) and RxJS operators (`includeMailboxes`, `ignoreUnhealthyRelaysOnPointers`). Clients compose pipelines.
- **rust-nostr** (`nostr-gossip` crate) -- Trait-based storage abstraction (`NostrGossip`) with in-memory and SQLite backends. SDK layer adds `GossipRelayResolver`.
- **NostrEssentials** (Swift) -- `createRequestPlan()` and `createWritePlan()` as pure functions consumed by Nostur.

**Clients with built-in outbox logic (not easily reusable):**
- **Gossip** -- RelayPicker is tightly integrated with LMDB storage and the Minion architecture.
- **Amethyst** -- `OutboxRelayLoader` depends on `LocalCache` addressable notes and Kotlin Flow infrastructure.
- **Voyage** -- `RelayProvider` is bound to Room DAO queries.
- **Wisp** -- `RelayScoreBoard` and `OutboxRouter` are application-level classes.
- **Nosotros** -- `subscribeOutbox()` depends on the app's tanstack-query cache and RxJS context.

### 2.3 By Storage Model

**Persistent database:**
- **Gossip** -- LMDB `person_relays2` table. Composite key: `pubkey_bytes + url_bytes`. Stores read/write/dm booleans, last_fetched, last_suggested timestamps.
- **Voyage** -- Room (SQLite) `nip65` table. Primary key: `(pubkey, url)`. Stores read/write flag and `createdAt` for upsert deduplication.
- **rust-nostr** (SQLite backend) -- `relays_per_user` table with bitflags, received_events count, last_received_event timestamp. Also `lists` table for freshness tracking.
- **Nostur** -- CoreData (SQLite) for kind 10002 events. Relay associations derived by parsing stored events on demand.
- **Nosotros** -- SQLite (OPFS) `seen` table for event-relay tracking. Kind 10002 events stored as regular events and parsed on access.
- **Applesauce/noStrudel** -- `RelayLiveness` data persisted to localforage. Kind 10002 events in EventStore (in-memory with optional persistence).

**In-memory only:**
- **Amethyst** -- Kind 10002 as addressable notes in `LocalCache`. `UserRelaysCache` frequency map on each `User` object. `HintIndexer` bloom filters (~9.6 MB total).
- **NDK** -- LRU cache with 100,000 max entries and 2-minute TTL per entry.
- **Welshman/Coracle** -- `Repository` in-memory store. `RelayStats` in-memory with batched updates. `Tracker` (event-relay provenance) persisted to IndexedDB.
- **Wisp** -- `LruCache<String, List<RelayConfig>>(500)` backed by SharedPreferences for persistence across restarts.

**No meaningful relay state:**
- **Yakihonne** -- Connects to relays from own kind 10002 at login; no cross-user relay tracking.
- **Shopstr** -- localStorage for own relay config only.
- **Notedeck** -- `AccountRelayData` in memory for own account. No cross-user tracking yet.

---

## 3. Per-Client Summary

**Gossip** is the most principled outbox implementation, designed from the ground up around the concept. Its `RelayPicker` uses a greedy set-cover algorithm with a two-layer scoring system: an association score (1.0 for declared relays via kind 10002/kind 3/NIP-05, 0.2 with 14-day decay for fetched, 0.1 with 7-day decay for hinted) multiplied by an adjusted relay score (rank/9 * success rate * connected bonus * log10(success_count)). Strong/weak relay separation ensures declared relays always dominate. The LMDB `PersonRelay2` table with read/write/dm flags and temporal fields provides the data backbone. No hardcoded fallback relays at runtime.

**Welshman/Coracle** provides a modular TypeScript library where the `Router` is a stateless factory producing `RouterScenario` objects. Relay scoring uses `quality * log(weight) * random()`, which compresses hub bias logarithmically and adds stochastic variation for load distribution. Quality is a hard gate (0 = excluded) based on tiered error thresholds. The default relay limit is 3 per scenario, overridden to 30 for `PublishEvent`. Three fallback policies (`addNoFallbacks`, `addMinimalFallbacks`, `addMaximalFallbacks`) control degradation behavior. Coracle configures it with environment-based default, indexer, and search relay lists.

**Amethyst** builds its outbox model on Kotlin `StateFlow` reactive pipelines. The `OutboxRelayLoader` observes each followed pubkey's kind 10002 addressable note and recomputes the relay-to-author map whenever any note changes. A novel bloom filter-based `HintIndexer` (three filters totaling ~9.6 MB) provides probabilistic relay hint lookups without a traditional database. The write side sends to own outbox relays plus inbox relays of every tagged user. A proxy relay system can completely bypass outbox routing for Tor users. Hard-coded blocklists exclude known aggregator relays (`feeds.nostr.band`, `filter.nostr.wine`).

**NDK** was designed specifically to make outbox transparent to application developers. Any subscription with author filters automatically triggers outbox tracking. The `OutboxTracker` uses an LRU cache (100k entries, 2-min TTL) and fetches kind 10002 in batches of 400 from a dedicated outbox pool (default: `purplepag.es`, `nos.lol`). Relay selection uses a three-priority greedy approach: prefer connected relays, then relays already selected for other authors, then popularity-ranked relays. Late-arriving outbox data triggers `refreshRelayConnections()` to add new relays to active subscriptions without disruption.

**Applesauce/noStrudel** implements a formal greedy set-cover algorithm as a pure function (`selectOptimalRelays`) that takes `ProfilePointer[]` and returns the same array with relays filtered to the optimal set. The algorithm recalculates coverage at each iteration, making it adaptive. noStrudel configures it with `maxConnections=20`, `maxRelaysPerUser=5`, and provides a debug UI showing per-relay coverage statistics, orphaned users, and a color-coded coverage indicator. The `RelayLiveness` class implements an online/offline/dead state machine with exponential backoff (base 5s in noStrudel, 30s in Applesauce) and persistent storage.

**Nostur** (Swift/iOS) implements outbox as an opt-in feature called "Autopilot," disabled by default. The core algorithm in the `NostrEssentials` library uses `createRequestPlan()` which sorts relays by coverage count and applies a `skipTopRelays` parameter (default 3) to avoid centralizing on popular relays -- a unique anti-centralization measure. Three separate connection pools (persistent, outbox max 50, ephemeral 35s) provide clear lifecycle management. Misconfigured kind 10002 events are detected via a hardcoded list of known-bad relay entries (localhost, blastr, filter relays) and discarded entirely. VPN detection gates outbox connections for privacy-conscious users.

**rust-nostr** models the gossip graph using per-pubkey-relay bitflags (READ, WRITE, PRIVATE_MESSAGE, HINT, RECEIVED) stored in either an in-memory LRU or SQLite backend. The `GossipRelayResolver` decomposes filters by field type: `authors`-only filters fan out to WRITE relays (outbox), `#p`-only filters fan out to READ relays (inbox), and combined filters union all relay types. A semaphore system (`GossipSemaphore`) prevents concurrent gossip updates for the same pubkey. Freshness checking uses a TTL-based updater with negentropy sync support.

**Voyage** (Android/Kotlin) uses Room (SQLite) with a `Nip65Entity` table for persistent kind 10002 storage. Its "autopilot" relay selection runs in four phases: NIP-65 write relay coverage (up to 25 relays), event-relay coverage from `EventRelayAuthorView`, fallback to READ relays, and redundancy pass for single-relay pubkeys. Publish routing reads tagged users' READ relays (2 per user, preferring connected). The `LazyNostrSubscriber` handles discovery of missing NIP-65 data for followed users.

**Wisp** (Android/Kotlin) stands out for its `RelayScoreBoard` -- a clean greedy set-cover implementation with a max of 75 scored relays. The `OutboxRouter` provides `subscribeByAuthors()` for read-side routing and `publishToInbox()` for write-side inbox delivery. A novel onboarding flow in `RelayProber` harvests 500 kind 10002 events, filters to "middle tier" relays (drops top 5 mega-relays, requires frequency >= 3), probes candidates with NIP-11 and ephemeral writes, and selects the top 8 by latency.

**Nosotros** (TypeScript/React) uses an RxJS observable pipeline where `subscribeOutbox()` splits filters by field type and resolves each author's relay list independently via tanstack-query with batching. Relay selection sorts by event count from a `relayStats` database and slices to a configurable `maxRelaysPerUser` (default 3, range 1-14). Publishing resolves the author's WRITE relays and each mentioned user's READ relays through the same observable pipeline.

**Yakihonne** (Dart/Flutter) has a NIP-65 decoder (`Nip65.decodeRelaysList`) that correctly parses read/write markers, but this decoder is not connected to any relay routing logic. The client connects to 5 hardcoded constant relays plus the user's own kind 10002 relays at login. All subscriptions are broadcast to all connected relays. The only outbox-adjacent behavior is on-demand event lookup: when an event is not found, Yakihonne fetches the author's kind 10002, temporarily connects to those relays for 2 seconds, fetches the event, and disconnects.

**Notedeck** (Rust) has solid NIP-65 infrastructure: `RelaySpec` with correct `is_readable()`/`is_writable()` semantics, `AccountRelayData` with filter and advertised relay sets, and `harvest_nip65_relays()` for tag parsing. However, the relay pool is currently flat -- all relays receive all messages. PR #1288 is in progress to add outbox routing, building on the existing `FilterStates` per-relay state machine and `send_to()` targeted relay communication.

**Shopstr** (TypeScript/Next.js) has minimal relay awareness. It reads kind 10002 for the user's own relay configuration and publishes to own write relays plus a blastr relay (`sendit.nosflare.com`). No per-author routing or inbox delivery exists.

---

## 4. Key Code Paths

### Gossip (Rust)
- **Relay picker algorithm:** `gossip-lib/src/relay_picker.rs` -- `RelayPicker::pick()`, greedy set-cover loop
- **Score computation:** `gossip-lib/src/relay.rs` -- `get_best_relays_with_score()`, `Relay::adjusted_score()`
- **PersonRelay storage:** `gossip-lib/src/storage/types/person_relay2.rs` -- `PersonRelay2::association_score()`
- **Kind 10002 ingestion:** `gossip-lib/src/storage/mod.rs` -- `set_relay_list()`
- **Event publishing:** `gossip-lib/src/relay.rs` -- `relays_to_post_to()`
- **Relay discovery:** `gossip-lib/src/overlord.rs` -- `start_long_lived_subscriptions()`, `subscribe_discover()`
- **Health/penalty:** `gossip-lib/src/overlord.rs` -- penalty table in `minion_exited()`, `gossip-lib/src/storage/types/relay3.rs` -- `should_avoid()`

### Welshman/Coracle (TypeScript)
- **Router core:** `welshman/packages/router/src/index.ts` -- `Router` class, scenario methods, `RouterScenario.getUrls()`
- **Scoring:** `welshman/packages/router/src/index.ts` -- `scoreRelay()` within `getUrls()`
- **Quality calculation:** `welshman/packages/app/src/relayStats.ts` -- `getRelayQuality()`
- **Kind 10002 parsing:** `welshman/packages/util/src/List.ts` -- `getRelaysFromList()`
- **Relay list fetching:** `welshman/packages/app/src/relayLists.ts` -- `fetchRelayList()`, `loadUsingOutbox()`
- **Pool/connection:** `welshman/packages/net/src/pool.ts` -- `Pool` class
- **Socket policies:** `welshman/packages/net/src/policy.ts` -- connect-on-send, close-inactive, auth-buffer, ping
- **Coracle relay config:** `coracle/src/engine/state.ts` -- `routerContext` overrides

### Amethyst (Kotlin)
- **Outbox relay loader:** `amethyst/src/main/java/.../model/topNavFeeds/OutboxRelayLoader.kt` -- `authorsPerRelay()`
- **Kind 10002 event:** `quartz/src/commonMain/kotlin/.../quartz/nip65RelayList/AdvertisedRelayListEvent.kt`
- **Relay discovery:** `amethyst/src/main/java/.../service/relayClient/reqCommand/account/follows/FilterFindFollowMetadataForKey.kt` -- `pickRelaysToLoadUsers()`
- **Write-side routing:** `amethyst/src/main/java/.../model/Account.kt` -- `computeRelayListToBroadcast()`
- **Hint indexer:** `quartz/src/commonMain/kotlin/.../quartz/nip01Core/hints/HintIndexer.kt` -- bloom filter lookups
- **Dynamic pool:** `quartz/src/commonMain/kotlin/.../quartz/nip01Core/relay/client/NostrClient.kt` -- `allRelays` combine flow
- **Blocked relay subtraction:** `amethyst/src/main/java/.../model/nip51Lists/blockedRelays/BlockedRelayListState.kt`

### NDK (TypeScript)
- **Outbox tracker:** `ndk/core/src/outbox/tracker.ts` -- `OutboxTracker.trackUsers()`
- **Relay selection:** `ndk/core/src/outbox/index.ts` -- `chooseRelayCombinationForPubkeys()`
- **Relay ranking:** `ndk/core/src/outbox/relay-ranking.ts` -- `getTopRelaysForAuthors()`
- **Filter splitting:** `ndk/core/src/relay/sets/calculate.ts` -- `calculateRelaySetsFromFilter()`
- **Publish routing:** `ndk/core/src/relay/sets/calculate.ts` -- `calculateRelaySetFromEvent()`
- **Kind 10002 parsing:** `ndk/core/src/events/kinds/relay-list.ts` -- `NDKRelayList.readRelayUrls`, `.writeRelayUrls`
- **Subscription refresh:** `ndk/core/src/subscription/index.ts` -- `refreshRelayConnections()`

### Applesauce/noStrudel (TypeScript)
- **Set-cover algorithm:** `applesauce/packages/core/src/helpers/relay-selection.ts` -- `selectOptimalRelays()`
- **Mailbox parsing:** `applesauce/packages/core/src/helpers/mailboxes.ts` -- `getInboxes()`, `getOutboxes()`
- **RxJS operator:** `applesauce/packages/core/src/observable/relay-selection.ts` -- `includeMailboxes()`
- **Outbox model:** `applesauce/packages/core/src/models/outbox.ts` -- `OutboxModel()`
- **Relay liveness:** `applesauce/packages/relay/src/liveness.ts` -- `RelayLiveness` class
- **noStrudel pipeline:** `nostrudel/src/models/outbox-selection.ts` -- `outboxSelection()`, `includeOutboxRelays()`
- **noStrudel cache:** `nostrudel/src/services/outbox-cache.ts` -- `OutboxCacheService`

### Nostur (Swift)
- **Outbox loader:** `Nostur/Relays/Network/OutboxLoader.swift` -- `load()`, misconfigured kind 10002 detection
- **Request planning:** `nostr-essentials/Sources/NostrEssentials/Outbox/Outbox.swift` -- `createRequestPlan()`, `createWritePlan()`, `pubkeysByRelay()`
- **Connection pool:** `Nostur/Relays/Network/ConnectionPool.swift` -- `sendToOthersPreferredWriteRelays()`, `sendToOthersPreferredReadRelays()`
- **Relay hint resolution:** `Nostur/Relays/Network/OutboxLoader.swift` -- `resolveRelayHint()`

### rust-nostr (Rust)
- **Gossip trait:** `gossip/nostr-gossip/src/lib.rs` -- `NostrGossip` trait
- **Bitflags:** `gossip/nostr-gossip/src/flags.rs` -- READ, WRITE, PRIVATE_MESSAGE, HINT, RECEIVED
- **Filter decomposition:** `sdk/src/client/gossip/resolver.rs` -- `GossipRelayResolver::break_down_filter()`
- **Event routing:** `sdk/src/client/api/send_event.rs` -- `gossip_prepare_urls()`
- **Freshness updater:** `sdk/src/client/gossip/updater.rs` -- `ensure_gossip_public_keys_fresh()`
- **SQLite store:** `gossip/nostr-gossip-sqlite/src/store.rs`

### Voyage (Kotlin)
- **Relay provider:** `app/src/main/java/.../data/provider/RelayProvider.kt` -- `getObserveRelays()`
- **NIP-65 entity:** `app/src/main/java/.../data/room/entity/lists/Nip65Entity.kt`
- **NIP-65 DAO:** `app/src/main/java/.../data/room/dao/Nip65Dao.kt`
- **Lazy discovery:** `app/src/main/java/.../data/nostr/LazyNostrSubscriber.kt` -- `lazySubNip65s()`

### Wisp (Kotlin)
- **Relay scoreboard:** `app/src/main/kotlin/.../relay/RelayScoreBoard.kt` -- `recompute()`
- **Outbox router:** `app/src/main/kotlin/.../relay/OutboxRouter.kt` -- `subscribeByAuthors()`, `publishToInbox()`
- **NIP-65 parsing:** `app/src/main/kotlin/.../nostr/Nip65.kt` -- `parseRelayList()`
- **Relay prober:** `app/src/main/kotlin/.../relay/RelayProber.kt` -- onboarding relay discovery

### Nosotros (TypeScript)
- **Outbox subscription:** `src/hooks/subscriptions/subscribeOutbox.ts` -- `subscribeOutbox()`, `subscribeEventRelays()`
- **Relay list parsing:** `src/hooks/parsers/parseRelayList.ts` -- `parseRelayList()`
- **Relay selection:** `src/hooks/parsers/selectRelays.ts` -- `selectRelays()`
- **Subscription builder:** `src/core/NostrSubscriptionBuilder.ts` -- relay-filter merging

---

## 5. Common vs. Divergent Patterns

### 5.1 Universal Patterns (shared by most or all mature implementations)

**Kind 10002 as the primary data source.** Every implementation with outbox support parses kind 10002 `r` tags with read/write markers. The semantic interpretation is consistent: no marker means both read and write; `"read"` means inbox only; `"write"` means outbox only. This is the single most standardized aspect across the ecosystem.

**Greedy set-cover for relay selection.** Five independent implementations converge on the same algorithm: Gossip (`RelayPicker`), Applesauce (`selectOptimalRelays`), Wisp (`RelayScoreBoard`), Nostur (`createRequestPlan`), and NDK (a variant that prioritizes connected relays). The pattern is: sort relays by how many uncovered pubkeys they serve, pick the best, remove covered pubkeys, repeat. This convergence is notable because these codebases were developed independently in different languages.

**Author-relay grouping for filter splitting.** All implementations that do per-author routing produce a `Map<relay, Set<pubkey>>` (or equivalent) and send each relay a filter containing only the authors assigned to it. This is the fundamental "fan-out" operation of the outbox model.

**Write-side inbox delivery.** All mature implementations (Gossip, Welshman, Amethyst, NDK, Applesauce, Nostur, rust-nostr, Voyage, Wisp, Nosotros) send published events not only to the author's own write relays but also to the READ (inbox) relays of tagged pubkeys. This dual-sided approach is the full outbox model.

**Fallback to general/default relays.** Every implementation has a fallback path for pubkeys with no known relay list. The specific strategy varies (see divergent patterns), but the concept of fallback relays is universal.

**Hardcoded bootstrap/discovery relays.** Nearly all clients include hardcoded relay URLs for bootstrapping. Common appearances: `relay.damus.io`, `nos.lol`, `purplepag.es`, `relay.primal.net`. These serve as both default relays and indexer/discovery relays.

### 5.2 Significant Divergences

**Relay scoring complexity.** Implementations range from no scoring (Amethyst: binary available/offline) to highly sophisticated multi-factor models (Gossip: association_score with exponential decay * relay quality with success rate and rank). Welshman adds stochastic noise (`Math.random()`) to its scoring to distribute load; no other implementation does this.

**Connection limits and caps.**
| Project | Max total relays | Relays per author |
|---------|:---:|:---:|
| Gossip | 50 | 2 |
| Welshman/Coracle | No hard cap | 3 (configurable) |
| Amethyst | Dynamic (pool resizes) | N/A |
| NDK | No hard cap | 2 |
| Applesauce/noStrudel | 20 (configurable) | 5 (configurable) |
| Nostur | 50 (outbox pool) | N/A |
| rust-nostr | Configurable | 3 read, 3 write, 1 hint |
| Voyage | 25 (autopilot) | 2 (publish) |
| Wisp | 75 | N/A |
| Nosotros | N/A | 3 (configurable 1-14) |

**Anti-centralization measures.** Only Nostur explicitly skips the top N most-popular relays (`skipTopRelays: 3`) in its read-side request planning. Welshman uses `Math.log(weight)` to compress hub bias. Most others implicitly favor popular relays through their greedy set-cover algorithms, since the relay covering the most authors is always picked first.

**Relay hint handling.** The treatment of relay hints (from `p` tags, `e` tags, nprofile/nevent bech32 references) varies widely:
- **Gossip**: Hints contribute a decaying 0.1 score to the association (7-day halflife).
- **rust-nostr**: Hints are a separate bitflag (HINT), selected up to 1 per user.
- **Amethyst**: Bloom filter-based `HintIndexer` (~9.6 MB) provides probabilistic hint lookups. Unique approach.
- **Nostur**: Relay hints create ephemeral 35-second connections. Opt-in via "Follow relay hints" toggle.
- **NDK/Welshman**: Relay hints from tags are included in publish relay sets but do not influence read-side routing.
- **Nosotros**: Max 4 hint relays merged into subscription builder.

**Reactivity model.** The split between reactive (Amethyst, Applesauce/noStrudel, Nosotros) and imperative (Gossip, NDK, Nostur, rust-nostr, Voyage, Wisp) approaches has practical consequences. Reactive implementations automatically recompute relay assignments when kind 10002 events update, but may trigger unnecessary recomputations. Applesauce/noStrudel mitigates this with `debounceTime(500)`. Imperative implementations must explicitly handle the "late-arriving relay data" case -- NDK does this via `refreshRelayConnections()`, others may miss relay updates that arrive after the initial subscription.

**Storage persistence.** Gossip (LMDB), Voyage (Room/SQLite), and rust-nostr (SQLite) persist per-pubkey-relay associations across restarts. NDK uses a 2-minute TTL LRU cache, meaning all gossip data must be refetched after restart. Amethyst keeps everything in memory. This has implications for startup latency and bandwidth consumption.

**Kind 10002 validity checking.** Only Nostur actively detects and discards misconfigured kind 10002 events (checking write relays against a known-bad list). Amethyst has a hard-coded blocklist for aggregator relays in its `OutboxRelayLoader`. Other implementations accept all kind 10002 events at face value.

**NIP-17 (DM relay) integration.** Full support: Gossip (kind 10050 -> dm flag on PersonRelay), rust-nostr (PRIVATE_MESSAGE bitflag), Welshman (RelayMode.Messaging), Amethyst (dmRelayListNote). Partial or none: NDK, Nostur (kind 10050 in wizard but not in routing), Voyage, Wisp, Nosotros, Shopstr.

**Proxy/privacy bypass.** Amethyst is unique in offering a proxy relay system that completely replaces outbox routing -- all filters go to a single trusted proxy instead of fanning out to per-author relays. Nostur gates outbox on VPN detection. Other implementations have no privacy-specific relay routing controls.

**Event-relay tracking (observed relays).** Several implementations track which relays have delivered events from which authors as a secondary signal:
- **Gossip**: `last_fetched` on PersonRelay2 (0.2 base, 14-day halflife decay)
- **rust-nostr**: RECEIVED bitflag + `received_events` count + `last_received_event` timestamp
- **Voyage**: `EventRelayAuthorView` in Room database
- **Amethyst**: `UserRelaysCache` frequency map
- **Nosotros**: `seen` table + `relayStats` event counts
- **NDK, Welshman, Wisp, Nostur**: No event-relay tracking for relay selection

This observed-relay data provides a fallback when kind 10002 is missing and a confidence signal when it exists.
