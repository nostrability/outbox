# Outbox Implementation Analysis: rust-nostr, Voyage, Nosotros, Wisp, Shopstr

## Summary

| Project | Language | Outbox Maturity | Relay Selection Strategy | Kind 10002 | Persistent Storage |
|---------|----------|----------------|--------------------------|------------|-------------------|
| **rust-nostr** | Rust | Advanced | Bitflag-based gossip graph: write/read/hint/received/NIP-17 per pubkey | Full NIP-65 + NIP-17 parsing | Memory (LRU) + SQLite backends |
| **Voyage** | Kotlin | Advanced | NIP-65 write relays + event-relay tracking; greedy "autopilot" up to 25 relays | Room DB with `Nip65Entity` table | Room (SQLite) persistent |
| **Nosotros** | TypeScript | Moderate | RxJS observable pipeline: per-author relay list lookup with relay stats ranking | Parsed from kind 10002 tags via `parseRelayList()` | SQLite (OPFS) `seen` table + tanstack-query cache |
| **Wisp** | Kotlin | Advanced | Greedy set-cover `RelayScoreBoard` over followed users' write relays (max 75) | `Nip65.parseRelayList()` -> `RelayListRepository` LRU cache | SharedPreferences + LRU in-memory |
| **Shopstr** | TypeScript | Minimal | Static relay list from localStorage; no per-author routing | Fetches kind 10002 for own relay config only | localStorage only |

---

## 1. rust-nostr

**Repository path:** `/tmp/outbox-research/rust-nostr`

### 1.1 Architecture Overview

rust-nostr implements outbox as a dedicated `gossip` subsystem with a trait-based storage abstraction (`NostrGossip`), a filter decomposition engine (`GossipRelayResolver`), and a concurrency-safe semaphore system (`GossipSemaphore`).

Key directories:
- `gossip/nostr-gossip/src/lib.rs` -- trait definition
- `gossip/nostr-gossip-memory/src/store.rs` -- in-memory LRU store
- `gossip/nostr-gossip-sqlite/src/store.rs` -- persistent SQLite store
- `sdk/src/client/gossip/` -- resolver, updater, semaphore

### 1.2 Gossip Data Model (Bitflags)

Each pubkey-relay pair stores a bitflag with five flags:

**File:** `gossip/nostr-gossip/src/flags.rs`
```rust
pub const READ: Self = Self(1 << 0);           // 1  - from kind 10002 read markers
pub const WRITE: Self = Self(1 << 1);          // 2  - from kind 10002 write markers
pub const PRIVATE_MESSAGE: Self = Self(1 << 2); // 4  - from kind 10050 (NIP-17)
pub const HINT: Self = Self(1 << 3);           // 8  - from `p` tag relay hints
pub const RECEIVED: Self = Self(1 << 4);       // 16 - relay that delivered the event
```

The in-memory store tracks per relay: `bitflags`, `received_events` (count), and `last_received_event` (timestamp). Relays are sorted by `received_events DESC, last_received_event DESC` when selecting best relays.

### 1.3 Relay Selection Defaults

**File:** `sdk/src/client/builder.rs`
```rust
impl Default for GossipRelayLimits {
    fn default() -> Self {
        Self {
            read_relays_per_user: 3,
            write_relays_per_user: 3,
            hint_relays_per_user: 1,
            most_used_relays_per_user: 1,
            nip17_relays: 3,
        }
    }
}
```

### 1.4 Filter Decomposition (Break Down Filters)

The `GossipRelayResolver::break_down_filter()` method (`sdk/src/client/gossip/resolver.rs`) splits a nostr filter based on which public keys are involved:

- **`authors` only** (outbox pattern): Maps each author to their WRITE relays + hints + most-received relays. Produces per-relay filters with the subset of authors.
- **`#p` tags only** (inbox pattern): Maps each tagged pubkey to their READ relays + hints + most-received relays.
- **Both `authors` and `#p`**: Union of all pubkeys, fetches ALL relay types, sends the full filter to each.
- **Neither**: Falls back to the client's configured READ relays (`BrokenDownFilters::Other`).

Orphan filters (pubkeys with no known relays) fall back to READ relays.

### 1.5 Event Routing (send_event)

**File:** `sdk/src/client/api/send_event.rs`

The `gossip_prepare_urls()` function determines where to send an event:

1. For **GiftWrap/NIP-17** events: Only sends to `PrivateMessage` relays of the tagged pubkeys.
2. For **regular events**: Combines the author's WRITE relays + hints + most-received relays, PLUS the `#p`-tagged users' READ relays + hints + most-received, PLUS the client's own WRITE relays.
3. For **contact list** events: Only uses the author's outbox relays (no inbox routing for p-tags).

The builder pattern supports `.broadcast()`, `.to(urls)`, `.to_nip17()`, and `.to_nip65()` overrides.

### 1.6 Gossip Data Freshness (Updater)

**File:** `sdk/src/client/gossip/updater.rs`

Before any gossip operation, `ensure_gossip_public_keys_fresh()` checks each pubkey's status (Missing/Outdated/Updated). Outdated detection uses a TTL. The updater:
1. Acquires per-pubkey semaphore permits (deadlock-free via sorted BTreeSet ordering)
2. Syncs via negentropy from DISCOVERY or READ relays
3. Falls back to REQ-based fetching from failed relays
4. Marks missing pubkeys as checked to avoid repeated fetches

### 1.7 Persistent Storage (SQLite - v0.36+)

**File:** `gossip/nostr-gossip-sqlite/src/store.rs`

The SQLite store uses three tables: `public_keys`, `relays`, and `relays_per_user` (with bitflags, received_events, last_received_event). There is also a `lists` table tracking `last_checked_at` per pubkey per list kind. This enables persistent gossip graphs across restarts.

### 1.8 Concurrency Control

**File:** `sdk/src/client/gossip/semaphore.rs`

`GossipSemaphore` uses per-pubkey tokio semaphores to ensure only one gossip update runs per pubkey at a time. Includes RAII-based cleanup and stress tests up to 10,000 concurrent requests.

---

## 2. Voyage

**Repository path:** `/tmp/outbox-research/voyage`

### 2.1 Architecture Overview

Voyage is an Android Kotlin client using Room (SQLite) for persistence. Its outbox implementation centers on `RelayProvider`, which combines NIP-65 data from the `Nip65Entity` table with event-relay tracking via `EventRelayAuthorView`.

### 2.2 Kind 10002 Handling

**File:** `app/src/main/java/com/dluvian/voyage/data/room/entity/lists/Nip65Entity.kt`
```kotlin
@Entity(tableName = "nip65", primaryKeys = ["pubkey", "url"])
data class Nip65Entity(
    val pubkey: PubkeyHex,
    @Embedded val nip65Relay: Nip65Relay,
    val createdAt: Long,
)
```

**File:** `app/src/main/java/com/dluvian/voyage/data/room/dao/Nip65Dao.kt`

Provides queries for read relays, write relays, friends' write relays, popular relays, and filtering known pubkeys.

Upsert logic (`Nip65UpsertDao`) only accepts events newer than the existing `createdAt` per pubkey, then deletes outdated entries.

### 2.3 Constants

**File:** `app/src/main/java/com/dluvian/voyage/core/Constants.kt`
```kotlin
const val MAX_RELAYS = 5
const val MAX_RELAYS_PER_PUBKEY = 2
const val MAX_AUTOPILOT_RELAYS = 25
const val MAX_KEYS = 750
```

### 2.4 Relay Selection - "Autopilot" Algorithm

**File:** `app/src/main/java/com/dluvian/voyage/data/provider/RelayProvider.kt`

The `getObserveRelays(selection: PubkeySelection)` method implements a multi-phase relay selection:

**Phase 1: NIP-65 write relay coverage**
Groups followed users' write relays by URL, then sorts by:
1. Not marked as Spam
2. Appears in event relays (most-used)
3. Already connected
4. Not disconnected

Takes the top `MAX_AUTOPILOT_RELAYS` (25) relays. For each, maps the pubkeys it covers (excluding already-covered ones).

**Phase 2: Event relay coverage (most-used relays)**
Uses `EventRelayAuthorView` (tracking which relay delivered events from which author). Sorts by `relayCount` DESC and connected status. Adds authors to already-selected relays or new relays up to the limit.

**Phase 3: Fallback**
Any uncovered pubkeys get assigned to READ relays plus already-selected relays.

**Phase 4: Redundancy**
Pubkeys mapped to only one relay get added to READ relays for redundancy.

### 2.5 Publish Routing

```kotlin
suspend fun getPublishRelays(publishTo: List<PubkeyHex>): List<RelayUrl> {
    val relays = nip65Dao.getReadRelays(pubkeys = publishTo)
        .groupBy { it.pubkey }
        .flatMap { (_, nip65s) ->
            nip65s.map { it.nip65Relay.url }.preferConnected(MAX_RELAYS_PER_PUBKEY)
        }.toMutableSet()
    relays.addAll(getPublishRelays(addConnected = true))
    return relays.toList()
}
```

When publishing to specific users, Voyage reads those users' READ relays (inbox), picks up to `MAX_RELAYS_PER_PUBKEY` (2) per user preferring connected relays, and adds the user's own write relays.

### 2.6 Lazy Discovery

**File:** `app/src/main/java/com/dluvian/voyage/data/nostr/LazyNostrSubscriber.kt`

`lazySubNip65s()` identifies friends with missing NIP-65 data, queries their write relays for kind 10002, and also fetches the newest NIP-65 updates for already-known pubkeys.

---

## 3. Nosotros

**Repository path:** `/tmp/outbox-research/nosotros`

### 3.1 Architecture Overview

Nosotros is a TypeScript/React client using RxJS observables for relay subscription routing. The outbox implementation uses an observable pipeline that dynamically resolves each author's relay list before subscribing.

### 3.2 Relay List Parsing

**File:** `src/hooks/parsers/parseRelayList.ts`
```typescript
export const READ = 1 << 0   // 1
export const WRITE = 1 << 1  // 2

export function parseRelayList(event: Pick<NostrEvent, 'pubkey' | 'tags'>): Metadata {
    // Parses 'r' and 'relay' tags from kind 10002
    // Groups by URL, OR-combines permissions
    // No marker = READ | WRITE
}
```

### 3.3 Relay Selection

**File:** `src/hooks/parsers/selectRelays.ts`
```typescript
export function selectRelays(data: UserRelay[], ctx: NostrContext, stats?: Record<string, RelayStatsDB>) {
  return data
    .filter((data) => !pool.blacklisted?.has(data.relay))
    .filter((data) => !RELAY_SELECTION_IGNORE.includes(data.relay))
    .filter((data) => !ctx.ignoreRelays?.includes(data.relay))
    .filter((data) => data.relay.startsWith('wss://'))
    .filter((data) => {
      return ctx.permission !== undefined ? !!(data.permission & ctx.permission) || !data.permission : true
    })
    .toSorted((a, b) => {
      const events1 = stats?.[a.relay]?.events || 0
      const events2 = stats?.[b.relay]?.events || 0
      return events2 - events1  // Sort by events DESC (most-used first)
    })
    .slice(0, ctx.maxRelaysPerUser || 3)
}
```

Key behaviors:
- Filters out blacklisted, ignored, and non-wss relays
- Filters by permission (READ for inbox queries, WRITE for outbox queries)
- Sorts by relay stats event count (most events first)
- Slices to `maxRelaysPerUser` (default: 3, configurable 1-14 in settings)

### 3.4 Outbox Subscription (RxJS Observable Pattern)

**File:** `src/hooks/subscriptions/subscribeOutbox.ts`

The `subscribeOutbox()` function is the core of Nosotros's outbox model. It splits a nostr filter by field type:

- **`authors` field**: For each author, fetches their relay list (via tanstack-query with batching), selects WRITE relays using `selectRelays()`, and emits `[relay, { ...filter, authors: [pubkey] }]` tuples.
- **`#p` / `#P` fields**: Same pipeline but selects READ relays (inbox).
- **`ids`, `#e`, `#E`, `#a`, `#A` fields**: Looks up relay hints for each ID, resolves the hinted author's relay list, selects READ or WRITE relays accordingly.
- **No pubkey fields**: Returns `EMPTY` (no outbox routing needed).

If an author has no relay list, FALLBACK_RELAYS are used.

### 3.5 Relay Filters as Observables

**File:** `src/core/NostrSubscriptionBuilder.ts`
```typescript
this.relayFilters = from(options.relayFilters || EMPTY).pipe(
  mergeWith(this.filter ? relaysToRelayFilters(this.relays, this.filter) : EMPTY),
  mergeWith(
    hintsToRelayFilters(this.filter, this.relayHints)
      .filter((x) => !this.relays.includes(x[0]))
      .slice(0, 4),  // Max 4 hint relays
  ),
)
```

The subscription builder merges three relay sources:
1. Outbox-resolved relay-filter pairs (from `subscribeOutbox`)
2. Static relay list (user's configured relays)
3. Relay hints (capped at 4)

### 3.6 Settings

**File:** `src/atoms/settings.atoms.ts`
```typescript
maxRelaysPerUser: 3,  // default, configurable 1-14
```

### 3.7 Database Schema

**File:** `src/db/sqlite/sqlite.schemas.ts`

No dedicated `person_relay` table. Instead:
- `seen` table tracks `(eventId, relay, created_at)` -- which relay delivered which event
- `relayStats` table stores per-relay statistics (events count, connects, etc.)
- `nip05` table caches NIP-05 verification results including relay lists
- Relay lists are stored as kind 10002 events in the `events` table and parsed on demand

### 3.8 Publish Routing

**File:** `src/hooks/subscriptions/subscribeOutbox.ts`
```typescript
export function subscribeEventRelays(event: UnsignedEvent, ctx: NostrContext) {
  const owner = subscribeAuthorsRelayList([event.pubkey], { ...ctx, permission: WRITE })
  const mentions = from(event.tags.filter(isAuthorTag).map((tag) => tag[1])).pipe(
    mergeMap((pubkey) => subscribeAuthorsRelayList([pubkey], { ...ctx, permission: READ })),
  )
  return merge(owner, mentions).pipe(distinct(), toArray(), mergeMap(identity))
}
```

When publishing, it resolves the author's WRITE relays and each mentioned user's READ relays.

---

## 4. Wisp

**Repository path:** `/tmp/outbox-research/wisp`

### 4.1 Architecture Overview

Wisp is a Kotlin Android client with a custom relay management stack. Its standout feature is the `RelayScoreBoard`, which uses a greedy set-cover algorithm to select an optimal relay set for following feeds.

### 4.2 RelayScoreBoard - Greedy Set Cover

**File:** `app/src/main/kotlin/com/wisp/app/relay/RelayScoreBoard.kt`

```kotlin
fun recompute() {
    val follows = contactRepo.getFollowList().map { it.pubkey }
    // Build relay -> authors mapping from known relay lists
    val relayToAuthors = mutableMapOf<String, MutableSet<String>>()
    for (pubkey in follows) {
        val writeRelays = relayListRepo.getWriteRelays(pubkey) ?: continue
        for (url in writeRelays) {
            relayToAuthors.getOrPut(url) { mutableSetOf() }.add(pubkey)
        }
    }

    // Greedy set-cover: pick relay covering most uncovered follows, repeat
    val uncovered = follows.toMutableSet()
    val result = mutableListOf<ScoredRelay>()
    val remainingRelays = relayToAuthors.toMutableMap()

    while (uncovered.isNotEmpty() && result.size < MAX_SCORED_RELAYS && remainingRelays.isNotEmpty()) {
        var bestUrl: String? = null
        var bestCover: Set<String> = emptySet()
        for ((url, authors) in remainingRelays) {
            val cover = authors.intersect(uncovered)
            if (cover.size > bestCover.size) {
                bestUrl = url
                bestCover = cover
            }
        }
        if (bestUrl == null || bestCover.isEmpty()) break
        result.add(ScoredRelay(bestUrl, bestCover.size, bestCover))
        uncovered.removeAll(bestCover)
        remainingRelays.remove(bestUrl)
    }
}
```

`MAX_SCORED_RELAYS = 75`. The algorithm:
1. Builds a map of relay URL -> set of followed authors who write to that relay
2. Greedily picks the relay that covers the most uncovered authors
3. Removes covered authors and repeats until all are covered or limit reached

### 4.3 OutboxRouter

**File:** `app/src/main/kotlin/com/wisp/app/relay/OutboxRouter.kt`

The `OutboxRouter` provides several routing methods:

**`subscribeByAuthors()`**: Groups authors by their write relays (via scoreboard if available, otherwise unconstrained). Sends targeted REQ per relay group. Authors without relay lists fall back to `sendToAll`.

**`publishToInbox()`**: Publishes to own write relays AND the target user's read (inbox) relays. Used for replies, reactions, and reposts.

**`getRelayHint()`**: Returns the best relay hint by preferring overlap between target's inbox and own outbox, then the target's inbox, then own outbox.

**`requestMissingRelayLists()`**: Checks which pubkeys are missing relay lists and sends a kind 10002 request to all general relays.

### 4.4 Relay List Repository

**File:** `app/src/main/kotlin/com/wisp/app/repo/RelayListRepository.kt`

Uses an in-memory `LruCache<String, List<RelayConfig>>(500)` backed by SharedPreferences. Caches parsed kind 10002 events by pubkey, with timestamp-based deduplication.

### 4.5 NIP-65 Parsing

**File:** `app/src/main/kotlin/com/wisp/app/nostr/Nip65.kt`
```kotlin
fun parseRelayList(event: NostrEvent): List<RelayConfig> {
    if (event.kind != 10002) return emptyList()
    return event.tags.mapNotNull { tag ->
        if (tag.size < 2 || tag[0] != "r") return@mapNotNull null
        val url = tag[1].trim()
        val marker = tag.getOrNull(2)
        RelayConfig(
            url = url,
            read = marker == null || marker == "read",
            write = marker == null || marker == "write"
        )
    }
}
```

### 4.6 Relay Discovery (Onboarding)

**File:** `app/src/main/kotlin/com/wisp/app/relay/RelayProber.kt`

On first use, Wisp:
1. Connects to bootstrap relays (`relay.damus.io`, `relay.primal.net`)
2. Harvests up to 500 kind 10002 events
3. Tallies relay URL frequency
4. Filters to "middle tier" (drops top 5 mega-relays, requires frequency >= 3)
5. Probes up to 15 candidates with NIP-11 + ephemeral write test (kind 20242)
6. Selects top 8 by latency

### 4.7 Feed Integration

**File:** `app/src/main/kotlin/com/wisp/app/viewmodel/FeedViewModel.kt`

The FeedViewModel ties it together:
1. Fetches relay lists for followed users
2. On EOSE of relay-list subscription: calls `relayScoreBoard.recompute()`
3. Merges scored relays into the relay pool
4. Uses `outboxRouter.subscribeByAuthors()` for feed subscriptions

---

## 5. Shopstr

**Repository path:** `/tmp/outbox-research/shopstr`

### 5.1 Architecture Overview

Shopstr is a Next.js marketplace client using nostr-tools' `SimplePool`. It has minimal outbox support -- it reads kind 10002 for the user's own relay configuration but does not implement per-author relay routing.

### 5.2 Kind 10002 Handling (Own Relays Only)

**File:** `utils/nostr/nostr-helper-functions.ts`
```typescript
export async function createNostrRelayEvent(nostr: NostrManager, signer: NostrSigner) {
  const relayList = getLocalStorageData().relays;
  const readRelayList = getLocalStorageData().readRelays;
  const writeRelayList = getLocalStorageData().writeRelays;
  // Builds kind 10002 event with 'r' tags
}
```

Shopstr fetches kind 10002 events in `fetchAllRelays()` (`utils/nostr/fetch-service.ts`) to load the user's own relay configuration. It correctly parses read/write markers from `r` tags.

### 5.3 Publishing -- No Outbox Routing

**File:** `utils/nostr/nostr-helper-functions.ts`
```typescript
export async function finalizeAndSendNostrEvent(signer, nostr, eventTemplate) {
    const { writeRelays, relays } = getLocalStorageData();
    const signedEvent = await signer.sign(eventTemplate);
    await cacheEventToDatabase(signedEvent);
    const allWriteRelays = withBlastr([...writeRelays, ...relays]);
    await nostr.publish(signedEvent, allWriteRelays);
}
```

All events are published to the user's own write relays + general relays + `wss://sendit.nosflare.com` (blastr). There is no per-recipient relay routing. The `NostrManager.publish()` method broadcasts to all specified relays uniformly.

### 5.4 Relay Configuration

Relays are stored in `localStorage` with three lists: `relays` (general), `readRelays`, and `writeRelays`. Defaults:
```typescript
["wss://relay.damus.io", "wss://nos.lol", "wss://purplepag.es",
 "wss://relay.primal.net", "wss://relay.nostr.band"]
```

The `withBlastr()` helper always adds `wss://sendit.nosflare.com` as a write-amplification relay.

### 5.5 Database Caching

Kind 10002 events are cached in a PostgreSQL `config_events` table (via API routes), but this is only used for the user's own relay config, not for building a gossip graph.

---

## Cross-Project Comparison

### Relay Selection Strategies

| Aspect | rust-nostr | Voyage | Nosotros | Wisp | Shopstr |
|--------|-----------|--------|----------|------|---------|
| Per-author routing | Yes (filter decomposition) | Yes (autopilot) | Yes (RxJS pipeline) | Yes (scoreboard + router) | No |
| Write relay limit/user | 3 | 2 (publish) / 25 (autopilot) | 3 (configurable 1-14) | 75 (scoreboard) | N/A |
| Read relay limit/user | 3 | 5 | 3 | N/A | N/A |
| Hint relays | Yes (1/user) | No | Yes (max 4) | Yes (getRelayHint) | No |
| Most-used relay tracking | Yes (RECEIVED flag) | Yes (EventRelayAuthorView) | Yes (relay stats events count) | No | No |
| NIP-17 support | Yes (PrivateMessage flag) | No | No | No | No |
| Fallback strategy | READ relays | Default hardcoded list | FALLBACK_RELAYS env var | sendToAll | Static relay list |

### Data Sources for Relay Discovery

| Source | rust-nostr | Voyage | Nosotros | Wisp | Shopstr |
|--------|-----------|--------|----------|------|---------|
| Kind 10002 (NIP-65) | Yes | Yes | Yes | Yes | Own only |
| Kind 10050 (NIP-17) | Yes | No | No | No | No |
| Relay hints (p-tags) | Yes | No | Yes | Yes (getRelayHint) | No |
| Event delivery tracking | Yes (RECEIVED) | Yes (EventRelayAuthorView) | Yes (seen table + stats) | No | No |
| NIP-05 relay lists | No | No | Via nip05 table | No | No |
| Contact list (kind 3) | No (but syncs) | Indirect (friend queries) | No | Via ContactRepository | No |

### Publish Routing

| Client | Author's outbox | Tagged users' inbox | Broadcast fallback |
|--------|----------------|--------------------|--------------------|
| rust-nostr | WRITE + hints + most-received | READ + hints + most-received | Own WRITE relays |
| Voyage | Own write relays | Target READ relays (2/user) | Connected + write relays |
| Nosotros | WRITE relays | READ relays (for #p tags) | OUTBOX_RELAYS env var |
| Wisp | Own write relays | Target read relays (publishToInbox) | sendToAll |
| Shopstr | Own write + general relays | None | blastr + all relays |
