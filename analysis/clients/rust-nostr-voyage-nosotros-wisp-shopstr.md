# Outbox Implementation: rust-nostr, Voyage, Nosotros, Wisp, Shopstr

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

Key directories:
- `gossip/nostr-gossip/src/lib.rs` -- trait definition
- `gossip/nostr-gossip-memory/src/store.rs` -- in-memory LRU store
- `gossip/nostr-gossip-sqlite/src/store.rs` -- persistent SQLite store
- `sdk/src/client/gossip/` -- resolver, updater, semaphore

### Gossip Data Model (Bitflags)

Each pubkey-relay pair stores a bitflag:

**File:** `gossip/nostr-gossip/src/flags.rs`
```rust
pub const READ: Self = Self(1 << 0);           // 1  - from kind 10002 read markers
pub const WRITE: Self = Self(1 << 1);          // 2  - from kind 10002 write markers
pub const PRIVATE_MESSAGE: Self = Self(1 << 2); // 4  - from kind 10050 (NIP-17)
pub const HINT: Self = Self(1 << 3);           // 8  - from `p` tag relay hints
pub const RECEIVED: Self = Self(1 << 4);       // 16 - relay that delivered the event
```

Per relay also tracks: `received_events` (count) and `last_received_event` (timestamp). Relays sorted by `received_events DESC, last_received_event DESC`.

### Relay Selection Defaults

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

### Filter Decomposition

**File:** `sdk/src/client/gossip/resolver.rs`

`break_down_filter()` splits a nostr filter based on pubkey fields:
- **`authors` only** (outbox): maps each author to WRITE relays + hints + most-received. Produces per-relay filters with author subsets.
- **`#p` tags only** (inbox): maps each tagged pubkey to READ relays + hints + most-received.
- **Both `authors` and `#p`**: union of all pubkeys, fetches ALL relay types, sends full filter to each.
- **Neither**: falls back to client's configured READ relays.
- Orphan pubkeys (no known relays) fall back to READ relays.

### Event Routing

**File:** `sdk/src/client/api/send_event.rs`

`gossip_prepare_urls()` determines where to send:
- **GiftWrap/NIP-17**: only `PrivateMessage` relays of tagged pubkeys
- **Regular events**: author's WRITE + hints + most-received, PLUS `#p`-tagged users' READ + hints + most-received, PLUS client's own WRITE relays
- **Contact list events**: only author's outbox relays (no inbox routing for p-tags)

Builder supports `.broadcast()`, `.to(urls)`, `.to_nip17()`, `.to_nip65()` overrides.

### Freshness, Storage, Concurrency

- **Updater** (`sdk/src/client/gossip/updater.rs`): Before any gossip operation, checks each pubkey's status (Missing/Outdated/Updated) via TTL. Syncs via negentropy from DISCOVERY or READ relays, falls back to REQ. Marks missing pubkeys as checked.
- **SQLite** (`gossip/nostr-gossip-sqlite/src/store.rs`): Three tables: `public_keys`, `relays`, `relays_per_user` (bitflags, received_events, last_received_event). `lists` table tracks `last_checked_at` per pubkey. Persists gossip graph across restarts.
- **Semaphore** (`sdk/src/client/gossip/semaphore.rs`): Per-pubkey tokio semaphores, RAII cleanup, stress tested to 10k concurrent requests.

---

## 2. Voyage

**Repository path:** `/tmp/outbox-research/voyage`

Android Kotlin client using Room (SQLite). Outbox centers on `RelayProvider`, combining NIP-65 data from `Nip65Entity` table with event-relay tracking via `EventRelayAuthorView`.

### Kind 10002 and Constants

**File:** `app/src/main/java/com/dluvian/voyage/data/room/entity/lists/Nip65Entity.kt` -- Room entity with `(pubkey, url)` primary key, `createdAt` for upsert dedup.

**File:** `app/src/main/java/com/dluvian/voyage/core/Constants.kt`
```kotlin
const val MAX_RELAYS = 5
const val MAX_RELAYS_PER_PUBKEY = 2
const val MAX_AUTOPILOT_RELAYS = 25
const val MAX_KEYS = 750
```

### Relay Selection -- "Autopilot" Algorithm

**File:** `app/src/main/java/com/dluvian/voyage/data/provider/RelayProvider.kt`

Four phases in `getObserveRelays(selection: PubkeySelection)`:

1. **On-paper mapping (NIP-65 write relays):** Groups followed users' write relays by URL, sorts by: not-spam > appears in event relays > already connected > not disconnected. Takes top 25 relays, maps covered pubkeys.
2. **Event retrieval (most-used relays):** Uses `EventRelayAuthorView` (tracks which relay delivered events from which author). Sorted by `relayCount DESC` + connected status. Adds authors to existing or new relays up to limit.
3. **Fallback:** Uncovered pubkeys assigned to READ relays + already-selected relays.
4. **Redundancy:** Pubkeys mapped to only one relay get added to READ relays.

### Publish Routing

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

Reads tagged users' READ relays (inbox), picks up to 2 per user preferring connected relays, adds user's own write relays.

`lazySubNip65s()` (`LazyNostrSubscriber.kt`) identifies friends with missing NIP-65 data and fetches kind 10002 from their write relays.

---

## 3. Nosotros

**Repository path:** `/tmp/outbox-research/nosotros`

TypeScript/React client using RxJS observables for relay subscription routing.

### Relay List Parsing and Selection

**File:** `src/hooks/parsers/parseRelayList.ts` -- Bitflag permissions (`READ = 1`, `WRITE = 2`). Parses `r` and `relay` tags from kind 10002, groups by URL, OR-combines permissions. No marker = READ | WRITE.

**File:** `src/hooks/parsers/selectRelays.ts`

`selectRelays()` pipeline: filter blacklisted/ignored/non-wss relays -> filter by permission (READ for inbox, WRITE for outbox) -> sort by relay stats event count DESC -> slice to `maxRelaysPerUser` (default 3, configurable 1-14).

### Outbox Subscription (RxJS Observable)

**File:** `src/hooks/subscriptions/subscribeOutbox.ts`

`subscribeOutbox()` splits a nostr filter by field type:
- **`authors`**: fetches each author's relay list (tanstack-query with batching), selects WRITE relays, emits `[relay, { ...filter, authors: [pubkey] }]` tuples
- **`#p` / `#P`**: same pipeline but selects READ relays (inbox)
- **`ids`, `#e`, `#E`, `#a`, `#A`**: looks up relay hints, resolves hinted author's relay list
- **No pubkey fields**: returns `EMPTY`
- Authors without relay list get FALLBACK_RELAYS

Subscription builder merges three sources: outbox-resolved pairs, static relay list, relay hints (capped at 4).

### Publish Routing

`subscribeEventRelays()` (`subscribeOutbox.ts`) resolves author's WRITE relays and each mentioned user's READ relays via the same observable pipeline.

### Settings and Storage

`maxRelaysPerUser`: 3 (default, configurable 1-14). `seen` table tracks `(eventId, relay, created_at)`. `relayStats` tracks per-relay stats. Relay lists stored as kind 10002 events and parsed on demand.

---

## 4. Wisp

**Repository path:** `/tmp/outbox-research/wisp`

Kotlin Android client. Standout feature: `RelayScoreBoard` using greedy set-cover for optimal relay selection.

### RelayScoreBoard -- Greedy Set Cover

**File:** `app/src/main/kotlin/com/wisp/app/relay/RelayScoreBoard.kt`

```kotlin
fun recompute() {
    val follows = contactRepo.getFollowList().map { it.pubkey }
    val relayToAuthors = mutableMapOf<String, MutableSet<String>>()
    for (pubkey in follows) {
        val writeRelays = relayListRepo.getWriteRelays(pubkey) ?: continue
        for (url in writeRelays) {
            relayToAuthors.getOrPut(url) { mutableSetOf() }.add(pubkey)
        }
    }

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

`MAX_SCORED_RELAYS = 75`. Builds relay -> followed authors map, greedily picks relay covering most uncovered authors, repeats until done.

### OutboxRouter

**File:** `app/src/main/kotlin/com/wisp/app/relay/OutboxRouter.kt`

- **`subscribeByAuthors()`**: groups authors by write relays (via scoreboard), sends targeted REQ per relay group. No relay list = `sendToAll`.
- **`publishToInbox()`**: publishes to own write relays AND target user's read (inbox) relays.
- **`getRelayHint()`**: prefers overlap between target's inbox and own outbox, then target's inbox, then own outbox.
- **`requestMissingRelayLists()`**: checks which pubkeys lack relay lists, sends kind 10002 request to all general relays.

### Storage and Onboarding

- **Relay list cache** (`RelayListRepository.kt`): `LruCache<String, List<RelayConfig>>(500)` backed by SharedPreferences, timestamp dedup.
- **Relay prober** (`RelayProber.kt`): On first use, harvests 500 kind 10002 events from bootstrap relays, tallies frequency, drops top 5 mega-relays, probes up to 15 middle-tier candidates (NIP-11 + ephemeral write test), selects top 8 by latency.
- **Feed flow** (`FeedViewModel.kt`): fetches relay lists -> EOSE triggers `relayScoreBoard.recompute()` -> merges scored relays into pool -> `outboxRouter.subscribeByAuthors()` for feed subscriptions.

---

## 5. Shopstr

**Repository path:** `/tmp/outbox-research/shopstr`

Static relay list, no outbox routing. Next.js marketplace using nostr-tools' `SimplePool`.

- Reads kind 10002 for user's own relay config only, not for other users
- Publishes to own write relays + general relays + `wss://sendit.nosflare.com` (blastr). No per-recipient routing.
- Relays stored in `localStorage` with three lists: `relays`, `readRelays`, `writeRelays`
- Defaults: `relay.damus.io`, `nos.lol`, `purplepag.es`, `relay.primal.net`, `relay.nostr.band`
- Kind 10002 events cached in PostgreSQL `config_events` table but only for own relay config
