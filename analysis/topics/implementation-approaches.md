# Outbox Model: Implementation Approaches

Cross-cutting synthesis of outbox/inbox relay routing across 14 Nostr projects, from static analysis.

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

**Legend:** Full = production-ready. Partial = infrastructure exists but unused for routing. None = not implemented.

---

## 2. Architecture Patterns

### By Programming Paradigm

**Reactive / Observable-driven:**
- **Amethyst** -- Kotlin `StateFlow` + `combine()`. Kind 10002 changes automatically recompute per-relay subscription filters.
- **Applesauce/noStrudel** -- RxJS `combineLatest` + `switchMap`. Full pipeline from contacts through relay selection. `debounceTime(500)` stabilizes async arrival.
- **Nosotros** -- RxJS `mergeMap` per author. Each author's relay list resolves independently.

**Imperative / Event-driven:**
- **Gossip** -- Rust async with message-passing (Overlord -> Minion channels). RelayPicker recomputed on demand.
- **NDK** -- EventEmitter pattern. `OutboxTracker` emits relay list updates, subscriptions call `refreshRelayConnections()`.
- **Nostur** -- Swift imperative with CoreData queries.
- **rust-nostr** -- Trait-based with async semaphores. `break_down_filter()` is a pure function called before each subscription.
- **Voyage** -- Kotlin coroutines with Room DAO queries. Multi-phase imperative algorithm.
- **Wisp** -- Kotlin imperative. `RelayScoreBoard.recompute()` runs greedy set-cover synchronously.

### By Layer (Library vs Client)

**Libraries (reusable):**
- **Welshman** -- Stateless Router; all relay knowledge injected via callbacks. Clients compose scenarios.
- **NDK** -- Transparent outbox. Any `ndk.subscribe()` with author filters auto-routes.
- **Applesauce** -- Pure functions + RxJS operators. Clients compose pipelines.
- **rust-nostr** -- Trait-based storage abstraction with in-memory and SQLite backends.
- **NostrEssentials** (Swift) -- Pure functions consumed by Nostur.

**Clients (built-in, not easily reusable):**
- **Gossip** -- Tightly integrated with LMDB + Minion architecture.
- **Amethyst** -- Depends on `LocalCache` addressable notes + Kotlin Flow.
- **Voyage** -- Bound to Room DAO queries.
- **Wisp** -- Application-level classes.
- **Nosotros** -- Depends on tanstack-query cache + RxJS context.

### By Storage Model

**Persistent database:**
- **Gossip** -- LMDB `person_relays2` table. Stores read/write/dm booleans, last_fetched, last_suggested.
- **Voyage** -- Room (SQLite) `nip65` table with read/write flag and `createdAt`.
- **rust-nostr** -- SQLite `relays_per_user` with bitflags, received_events count.
- **Nostur** -- CoreData for kind 10002 events, parsed on demand.
- **Nosotros** -- SQLite (OPFS) `seen` table. Kind 10002 stored as regular events.
- **Applesauce/noStrudel** -- `RelayLiveness` persisted to localforage.

**In-memory only:**
- **Amethyst** -- Kind 10002 in `LocalCache`. `HintIndexer` bloom filters (~9.6 MB).
- **NDK** -- LRU cache, 100k entries, 2-min TTL. All gossip data refetched after restart.
- **Welshman/Coracle** -- In-memory Repository + RelayStats. Tracker persisted to IndexedDB.
- **Wisp** -- `LruCache(500)` backed by SharedPreferences.

**No meaningful relay state:** Yakihonne, Shopstr, Notedeck (own account only).

---

## 3. Common vs Divergent Patterns

### Universal Patterns

- **Kind 10002 as primary data source.** Every outbox implementation parses kind 10002 `r` tags with read/write markers. Semantic interpretation is consistent: no marker = both; `"read"` = inbox; `"write"` = outbox.
- **Greedy set-cover for relay selection.** Five independent implementations converge on the same algorithm: Gossip, Applesauce, Wisp, Nostur, NDK (variant). Sort relays by uncovered pubkeys served, pick best, remove covered, repeat.
- **Author-relay grouping.** All implementations produce `Map<relay, Set<pubkey>>` and send each relay a filter with only its assigned authors.
- **Write-side inbox delivery.** All mature implementations send published events to the author's write relays AND tagged pubkeys' READ (inbox) relays.
- **Fallback to general relays.** Every implementation has a fallback for pubkeys with no known relay list.
- **Hardcoded bootstrap relays.** Nearly all clients include hardcoded relay URLs. Common: `relay.damus.io`, `nos.lol`, `purplepag.es`, `relay.primal.net`.

### Key Divergences

- **Relay scoring complexity.** Ranges from none (Amethyst: binary available/offline) to multi-factor with exponential decay (Gossip). Welshman uniquely adds `Math.random()` for load distribution.
- **Connection limits:**

| Project | Max total relays | Relays per author |
|---------|:---:|:---:|
| Gossip | 50 | 2 |
| Welshman/Coracle | No hard cap | 3 (configurable) |
| Amethyst | Dynamic | N/A |
| NDK | No hard cap | 2 |
| Applesauce/noStrudel | 20 (configurable) | 5 (configurable) |
| Nostur | 50 (outbox pool) | N/A |
| rust-nostr | Configurable | 3 read, 3 write, 1 hint |
| Voyage | 25 (autopilot) | 2 (publish) |
| Wisp | 75 | N/A |
| Nosotros | N/A | 3 (configurable 1-14) |

- **Anti-centralization.** Only Nostur explicitly skips top N popular relays (`skipTopRelays: 3`). Welshman uses `Math.log(weight)` to compress hub bias. Most others implicitly favor popular relays via greedy set-cover.
- **Relay hint handling.** Gossip: decaying 0.1 score (7-day halflife). rust-nostr: separate HINT bitflag, max 1 per user. Amethyst: bloom filter `HintIndexer` (~9.6 MB). Nostur: ephemeral 35s connections, opt-in. NDK/Welshman: hints in publish sets only. Nosotros: max 4 hint relays.
- **Reactivity.** Reactive implementations (Amethyst, Applesauce, Nosotros) auto-recompute on kind 10002 changes but risk unnecessary recomputation. Imperative implementations must handle late-arriving relay data explicitly -- NDK does via `refreshRelayConnections()`, others may miss updates.
- **Storage persistence.** Gossip/Voyage/rust-nostr persist per-pubkey-relay data across restarts. NDK's 2-min TTL LRU means full refetch on restart. Amethyst is in-memory only.
- **Kind 10002 validity checking.** Only Nostur detects and discards misconfigured kind 10002 (known-bad relay list). Amethyst blocklists aggregator relays. Others accept all kind 10002 at face value.
- **NIP-17 (DM relay) support.** Full: Gossip, rust-nostr, Welshman, Amethyst. Partial/none: NDK, Nostur, Voyage, Wisp, Nosotros, Shopstr.
- **Privacy bypass.** Amethyst offers a proxy relay system replacing outbox entirely. Nostur gates outbox on VPN detection. No others have privacy-specific routing controls.
- **Event-relay tracking (observed relays).** Gossip, rust-nostr, Voyage, Amethyst, and Nosotros track which relays deliver events from which authors as a secondary signal. NDK, Welshman, Wisp, and Nostur do not use this for relay selection.
