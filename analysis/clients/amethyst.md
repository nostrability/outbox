# Amethyst Outbox Implementation Analysis

## Summary

Amethyst (Android/Kotlin) has a mature, deeply integrated outbox model (NIP-65). The architecture is **reactive and flow-based**: kind 10002 relay lists are stored as addressable notes in an in-memory cache (`LocalCache`), and Kotlin `StateFlow` pipelines automatically recompute per-relay subscription filters whenever a follow's relay list changes. The core outbox logic lives in `OutboxRelayLoader`, which maps each followed pubkey to their declared write relays, then groups subscriptions so each relay gets a filter containing only the authors who write there. When no kind 10002 exists for a user, Amethyst falls back through a layered strategy: relay hints from a bloom-filter-based `HintIndexer`, then observed relays (`UserRelaysCache`), then hard-coded "event finder" relays. On the write side, Amethyst sends events to the union of its own outbox relays plus the **inbox** (read) relays of every tagged/mentioned user, making it a full outbox+inbox publisher. A proxy relay system allows Tor users to bypass per-user relay fan-out entirely, sending all filters through a single trusted relay.

---

## 1. Core Outbox / Relay Selection (`OutboxRelayLoader`)

The heart of the read-side outbox model is `OutboxRelayLoader`. It takes a set of followed pubkeys, looks up each one's kind 10002 `AdvertisedRelayListEvent`, extracts write relays, and returns a map of `relay -> Set<pubkey>`.

**File:** `/tmp/outbox-research/amethyst/amethyst/src/main/java/com/vitorpamplona/amethyst/model/topNavFeeds/OutboxRelayLoader.kt`

```kotlin
class OutboxRelayLoader(
    val rawOutboxRelays: Boolean = false,
) {
    fun authorsPerRelay(
        outboxRelayNotes: Array<NoteState>,
        cache: LocalCache,
    ): Map<NormalizedRelayUrl, Set<HexKey>> =
        mapOfSet {
            outboxRelayNotes.forEach { outboxNote ->
                val authorHex = /* resolved from addressable note or author */

                if (authorHex != null) {
                    val relays =
                        if (rawOutboxRelays) {
                            (outboxNote.note.event as? AdvertisedRelayListEvent)?.writeRelaysNorm() ?: emptySet()
                        } else {
                            (outboxNote.note.event as? AdvertisedRelayListEvent)?.writeRelaysNorm()
                                ?: cache.relayHints.hintsForKey(authorHex).ifEmpty { null }
                                ?: Constants.eventFinderRelays
                        }

                    relays.forEach {
                        // Blocklist: skip known aggregator/filter relays
                        if (!it.url.startsWith("wss://feeds.nostr.band") &&
                            !it.url.startsWith("wss://filter.nostr.wine") &&
                            !it.url.startsWith("wss://nwc.primal.net") &&
                            !it.url.startsWith("wss://relay.getalby.com")
                        ) {
                            add(it, authorHex)
                        }
                    }
                }
            }
        }
```

**Key design decisions:**

- `rawOutboxRelays = false` (default): applies the full fallback chain (kind 10002 -> hint indexer -> `eventFinderRelays`).
- `rawOutboxRelays = true`: only uses declared kind 10002 write relays, returns empty set if none. Used by `DeclaredFollowsPerOutboxRelay` and `FollowListReusedOutboxOrProxyRelays` to compute the pure declared relay set (for display/relay recommendations).
- **Hard-coded blocklist**: Aggregator relays like `feeds.nostr.band`, `filter.nostr.wine`, `nwc.primal.net`, `relay.getalby.com` are always excluded from outbox relay selection.

### Reactive Flow Pipeline

The loader is wired into a reactive pipeline via `toAuthorsPerRelayFlow()`:

```kotlin
fun <T> toAuthorsPerRelayFlow(
    authors: Set<HexKey>,
    cache: LocalCache,
    transformation: (Map<NormalizedRelayUrl, Set<HexKey>>) -> T,
): Flow<T> {
    val noteMetadataFlows = authors.map { pubkeyHex ->
        cache.getOrCreateAddressableNote(
            AdvertisedRelayListEvent.createAddress(pubkeyHex)
        ).flow().metadata.stateFlow
    }
    return combine(noteMetadataFlows) { outboxRelays ->
        transformation(authorsPerRelay(outboxRelays, cache))
    }
}
```

This means: for each followed pubkey, Amethyst observes the addressable note at address `10002:<pubkey>:`. Whenever any follow's kind 10002 event is created or updated, the entire relay-to-author map is recomputed and the subscription filters are rebuilt.

---

## 2. Person-Relay Tracking

Amethyst uses two complementary mechanisms to track which relays a person uses.

### 2a. Kind 10002 (`AdvertisedRelayListEvent`) -- Primary

**File:** `/tmp/outbox-research/amethyst/quartz/src/commonMain/kotlin/com/vitorpamplona/quartz/nip65RelayList/AdvertisedRelayListEvent.kt`

Each user's kind 10002 event is stored as an addressable note in `LocalCache`. The `User` model provides convenience accessors:

**File:** `/tmp/outbox-research/amethyst/commons/src/commonMain/kotlin/com/vitorpamplona/amethyst/commons/model/User.kt`

```kotlin
class User(
    val pubkeyHex: String,
    val nip65RelayListNote: Note,   // addressable note for kind 10002
    val dmRelayListNote: Note,       // addressable note for kind 10050 (DM relay list)
) {
    fun authorRelayList() = nip65RelayListNote.event as? AdvertisedRelayListEvent
    fun outboxRelays() = authorRelayList()?.writeRelaysNorm()
    fun inboxRelays() = authorRelayList()?.readRelaysNorm()
    fun dmInboxRelays() = dmInboxRelayList()?.relays()?.ifEmpty { null } ?: inboxRelays()
    fun bestRelayHint() = authorRelayList()?.writeRelaysNorm()?.firstOrNull() ?: mostUsedNonLocalRelay()
    fun relayHints() = outboxRelays()?.take(3) ?: relays?.mostUsed()?.take(3) ?: emptyList()
}
```

Relay type parsing respects read/write markers:

**File:** `/tmp/outbox-research/amethyst/quartz/src/commonMain/kotlin/com/vitorpamplona/quartz/nip65RelayList/tags/AdvertisedRelayInfoTag.kt`

```kotlin
enum class AdvertisedRelayType(val code: String) {
    BOTH(""),
    READ("read"),
    WRITE("write"),
}
// Tags without a type marker default to BOTH (read + write)
```

### 2b. `UserRelaysCache` -- Observed Relays (Secondary)

**File:** `/tmp/outbox-research/amethyst/commons/src/commonMain/kotlin/com/vitorpamplona/amethyst/commons/model/nip01Core/UserRelaysCache.kt`

```kotlin
class UserRelaysCache {
    var data: Map<NormalizedRelayUrl, RelayInfo> = mapOf()

    fun add(relay: NormalizedRelayUrl, eventTime: Long) { ... }
    fun mostUsed(): List<NormalizedRelayUrl>
    fun mostUsedNonLocalRelay(): NormalizedRelayUrl?
}

data class RelayInfo(var lastEvent: Long, var counter: Int) {
    fun countNewEvent(eventTime: Long) { ... }
}
```

Every time an event from a user is received from a relay, `addRelayBeingUsed()` is called on the `User` object, incrementing the counter. This builds an in-memory frequency map, sorted by `counter desc, lastEvent desc`.

### 2c. No Traditional Database Schema

Amethyst does **not** use a SQL/Room database for person-relay tracking. All relay association data is kept in memory:
- Kind 10002 events stored as addressable notes in `LocalCache`
- `UserRelaysCache` as a runtime frequency map on each `User` object
- `HintIndexer` as bloom filters in memory (see section 9)

---

## 3. Relay Discovery (Fetching Kind 10002 Lists)

### For Follows

**File:** `/tmp/outbox-research/amethyst/amethyst/src/main/java/com/vitorpamplona/amethyst/service/relayClient/reqCommand/account/follows/AccountFollowsLoaderSubAssembler.kt`

This is the assembler that fetches kind 10002 for all follows on startup. It:
1. Iterates all followed users
2. Identifies those without a loaded `authorRelayList()`
3. Calls `pickRelaysToLoadUsers()` to determine which relays to query

```kotlin
fun updateFilterForAllAccounts(accounts: Collection<Account>): List<RelayBasedFilter>? {
    val users = mutableSetOf<User>()
    accounts.forEach { key ->
        key.kind3FollowList.userList.value.forEach { user ->
            if (user.authorRelayList() == null) {
                users.add(user)
            }
        }
    }
    if (users.isEmpty()) return null

    val perRelay = pickRelaysToLoadUsers(users, accounts, ...)
    return perRelay.mapNotNull { (relay, users) ->
        RelayBasedFilter(
            relay = relay,
            filter = Filter(kinds = listOf(AdvertisedRelayListEvent.KIND), authors = users.sorted()),
        )
    }
}
```

### Relay Selection for Discovery (`pickRelaysToLoadUsers`)

**File:** `/tmp/outbox-research/amethyst/amethyst/src/main/java/com/vitorpamplona/amethyst/service/relayClient/reqCommand/account/follows/FilterFindFollowMetadataForKey.kt`

This is a **sophisticated progressive search** that uses multiple relay tiers:

```
For each user without a known kind 10002:
  1. If outbox relays are already known -> query those (then stop)
  2. If relay hints exist -> query those
  3. If hints < 3 -> also query:
     a. Indexer relays (purplepag.es, indexer.coracle.social, user.kindpag.es, directory.yabu.me, profiles.nostr1.com)
     b. Home relays (user's own NIP-65 + private + local relays)
     c. If >300 users, limit indexer queries to 2 per user (load shedding)
  4. If indexer relays < 2 -> also query:
     a. Search relays (nostr.wine, relay.noswhere.com, search.nos.today, etc.)
     b. Connected relays (up to 100, or 20 if >300 users)
  5. If search relays < 2 -> query common/shared outbox relays
```

The `>300 user` threshold is explicitly coded to reduce relay load for users following many accounts:

```kotlin
if (users.size > 300) {
    if (indexRelaysLeftToTry.size >= 2) {
        add(indexRelaysLeftToTry[0], key.pubkeyHex)
        add(indexRelaysLeftToTry[1], key.pubkeyHex)
    }
    // ...
    connectedRelaysLeftToTry.take(20).forEach { add(it, key.pubkeyHex) }
} else {
    indexRelaysLeftToTry.forEach { add(it, key.pubkeyHex) }
    // ...
    connectedRelaysLeftToTry.forEach { add(it, key.pubkeyHex) }
}
```

### Default Indexer Relays

**File:** `/tmp/outbox-research/amethyst/amethyst/src/main/java/com/vitorpamplona/amethyst/model/AccountSettings.kt`

```kotlin
val DefaultIndexerRelayList = setOf(
    Constants.purplepages,   // wss://purplepag.es
    Constants.coracle,       // wss://indexer.coracle.social
    Constants.userkinds,     // wss://user.kindpag.es
    Constants.yabu,          // wss://directory.yabu.me
    Constants.nostr1,        // wss://profiles.nostr1.com
)
```

Users can customize their indexer relay list, stored as a NIP-51 encrypted list event.

---

## 4. Connection Management

### Dynamic Relay Pool

**File:** `/tmp/outbox-research/amethyst/quartz/src/commonMain/kotlin/com/vitorpamplona/quartz/nip01Core/relay/client/NostrClient.kt`

The `NostrClient` maintains a `RelayPool` that dynamically adds/removes relay connections based on the union of:
- Active subscription needs (which relays are needed for current filters)
- Count queries
- Event outbox needs (which relays need events sent to them)

```kotlin
val allRelays = combine(
    activeRequests.desiredRelays,
    activeCounts.relays,
    eventOutbox.relays,
) { reqs, counts, outbox ->
    reqs + counts + outbox
}.sample(300).onEach {
    relayPool.updatePool(it)
}
```

The pool is updated every 300ms at most. `RelayPool.updatePool()` adds new relays and removes unneeded ones:

```kotlin
fun updatePool(newRelays: Set<NormalizedRelayUrl>) {
    val toRemove = relays.keys() - newRelays
    newRelays.forEach { relay -> createRelayIfAbsent(relay) }
    toRemove.forEach { relay -> removeRelayInner(relay) }
}
```

### Reconnection / Backoff

**File:** `/tmp/outbox-research/amethyst/quartz/src/commonMain/kotlin/com/vitorpamplona/quartz/nip01Core/relay/client/single/basic/BasicRelayClient.kt`

- Exponential backoff starting at 500ms, doubling on failure
- After intentional disconnect, waits 60 seconds before reconnecting
- `RelayOfflineTracker` maintains a `cannotConnectRelays` set, and the relay discovery code (`pickRelaysToLoadUsers`) subtracts these from candidate relay sets

### The >300 Follow Threshold

When a user follows more than 300 accounts, Amethyst reduces the number of relays queried per user during discovery:
- Only 2 indexer relays per user (instead of all)
- Only 20 connected relays (instead of up to 100)

This is a practical optimization to avoid opening too many connections and sending too many requests.

### Tor / SOCKS Proxy Support

**File:** `/tmp/outbox-research/amethyst/amethyst/src/main/java/com/vitorpamplona/amethyst/ui/tor/TorSettings.kt`

Amethyst has extensive Tor support with per-category routing controls:
- `onionRelaysViaTor`, `dmRelaysViaTor`, `newRelaysViaTor`, `trustedRelaysViaTor`
- Media, NIP-05, wallet operations can each be independently routed through Tor
- Presets: "Only When Needed", "Default", "Small Payloads", "Full Privacy"

### Proxy Relay Multiplexing

**File:** `/tmp/outbox-research/amethyst/amethyst/src/main/java/com/vitorpamplona/amethyst/model/topNavFeeds/allFollows/AllFollowsByProxyTopNavFilter.kt`

When proxy relays are configured, the outbox model is **completely bypassed**. All follow filters are sent to the proxy relays with the full author list:

```kotlin
class AllFollowsByProxyTopNavFilter(
    val proxyRelays: Set<NormalizedRelayUrl>,
) : IFeedTopNavFilter {
    // forces the use of the Proxy on all connections, replacing the outbox model.
    override fun toPerRelayFlow(cache: LocalCache): Flow<AllFollowsTopNavPerRelayFilterSet> =
        MutableStateFlow(
            AllFollowsTopNavPerRelayFilterSet(
                proxyRelays.associateWith {
                    AllFollowsTopNavPerRelayFilter(
                        authors = authors,
                        hashtags = hashtags,
                        geotags = geotags,
                        communities = communities,
                    )
                },
            ),
        )
}
```

**File:** `/tmp/outbox-research/amethyst/amethyst/src/main/java/com/vitorpamplona/amethyst/model/nip02FollowLists/FollowsPerOutboxRelay.kt`

The proxy takes priority:

```kotlin
val flow: StateFlow<Map<NormalizedRelayUrl, Set<HexKey>>> =
    proxyRelayList.flow.flatMapLatest { proxyRelays ->
        if (proxyRelays.isEmpty()) {
            outboxPerRelayMinusBlockedFlow   // normal outbox model
        } else {
            kind3Follows.flow.map { follows ->
                proxyRelays.associateWith { follows.authors }  // all authors to proxy
            }
        }
    }
```

---

## 5. Write-Side Outbox

### Event Publishing Strategy

**File:** `/tmp/outbox-research/amethyst/amethyst/src/main/java/com/vitorpamplona/amethyst/model/Account.kt`

Amethyst has a sophisticated write-side relay computation in `computeRelayListToBroadcast(event)`:

**For metadata and relay list events:**
```kotlin
if (event is MetadataEvent || event is AdvertisedRelayListEvent) {
    return followPlusAllMineWithIndex.flow.value + client.availableRelaysFlow().value
    // -> published EVERYWHERE
}
```

**For DMs (GiftWrap):**
```kotlin
if (event is GiftWrapEvent) {
    val receiver = event.recipientPubKey()
    // First try: DM inbox relay list (kind 10050)
    // Fallback: computeRelayListForLinkedUser(receiver) -> their NIP-65 read relays
}
```

**For general events:**
1. Start with author's own outbox relays
2. Add relay hints from tagged pubkeys (`PubKeyHintProvider`)
3. Add **inbox relays** of every tagged/linked user
4. Add relay hints from tagged events (`EventHintProvider`)
5. Add relay hints from tagged addresses (`AddressHintProvider`)
6. Add channel relays if applicable

```kotlin
fun computeRelayListToBroadcast(event: Event): Set<NormalizedRelayUrl> {
    val relayList = mutableSetOf<NormalizedRelayUrl>()
    // Own outbox
    relayList.addAll(outboxRelays.flow.value)
    // Tagged users' inbox relays
    event.linkedPubKeys().forEach { pubkey ->
        relayList.addAll(computeRelayListForLinkedUser(pubkey))
    }
    // Linked events' authors' inbox relays
    event.linkedEventIds().forEach { eventId ->
        cache.getNoteIfExists(eventId)?.let { linkedNote ->
            relayList.addAll(computeRelayListForLinkedUser(linkedNote.author))
        }
    }
    // ...
}
```

### Inbox Relay Resolution for Linked Users

```kotlin
private fun computeRelayListForLinkedUser(user: User): Set<NormalizedRelayUrl> =
    if (user == userProfile()) {
        notificationRelays.flow.value
    } else {
        user.inboxRelays()?.ifEmpty { null }?.toSet()
            ?: (cache.relayHints.hintsForKey(user.pubkeyHex).toSet() + user.allUsedRelays())
    }
```

**Fallback chain for linked user relays:**
1. Their kind 10002 **read** (inbox) relays
2. If none: relay hints from bloom filter + all observed relays

### Reaction Publishing (`computeMyReactionToNote`)

Reactions are published to a broad set:
```
own outbox relays
+ original note author's inbox relays
+ inbox relays of all tagged users (from reaction + original note)
+ channel relays
+ reply-to note relays + reply author relays
+ relays the note was received from
```

### Account Outbox Relay State

**File:** `/tmp/outbox-research/amethyst/amethyst/src/main/java/com/vitorpamplona/amethyst/model/nip01UserMetadata/AccountOutboxRelayState.kt`

The user's own outbox relay set is the union of:
```kotlin
nip65.outboxFlow        // kind 10002 write relays
+ privateStorage.flow   // private storage relays
+ local.flow            // local relays
+ broadcast.flow        // broadcast relay list (NIP-51 encrypted)
```

---

## 6. Fallback Behavior

### Read-side Fallback Chain (in `OutboxRelayLoader`)

When `rawOutboxRelays = false`:
1. Kind 10002 `writeRelaysNorm()` -- the user's declared write relays
2. `cache.relayHints.hintsForKey(authorHex)` -- bloom filter hints (relays where we've seen this pubkey mentioned or events from)
3. `Constants.eventFinderRelays` -- hard-coded fallback:

```kotlin
val eventFinderRelays = setOf(wine, damus, primal, mom, nos, bitcoiner, oxtr)
// wss://nostr.wine, wss://relay.damus.io, wss://relay.primal.net,
// wss://nostr.mom, wss://nos.lol, wss://nostr.bitcoiner.social, wss://nostr.oxtr.dev
```

### Write-side Fallback Chain (in `computeRelayListForLinkedUser`)

1. Kind 10002 `readRelaysNorm()` (inbox relays)
2. `cache.relayHints.hintsForKey()` + `user.allUsedRelays()`

### Own Relay List Fallback

**File:** `/tmp/outbox-research/amethyst/amethyst/src/main/java/com/vitorpamplona/amethyst/model/nip65RelayList/Nip65RelayListState.kt`

```kotlin
fun normalizeNIP65WriteRelayListWithBackup(note: Note) =
    nip65Event(note)?.writeRelaysNorm()?.toSet() ?: Constants.eventFinderRelays

fun normalizeNIP65ReadRelayListWithBackup(note: Note) =
    nip65Event(note)?.readRelaysNorm()?.toSet() ?: Constants.bootstrapInbox
```

```kotlin
val bootstrapInbox = setOf(damus, primal, mom, nos, bitcoiner, oxtr, yabu)
```

---

## 7. Relay Health

### `RelayOfflineTracker`

**File:** `/tmp/outbox-research/amethyst/quartz/src/commonMain/kotlin/com/vitorpamplona/quartz/nip01Core/relay/client/accessories/RelayOfflineTracker.kt`

Maintains a `cannotConnectRelays` set. When a relay connects, it is removed from the set. When connection fails, it is added. This set is subtracted from candidate relays in `pickRelaysToLoadUsers()`.

### `RelayStats`

**File:** `/tmp/outbox-research/amethyst/quartz/src/commonMain/kotlin/com/vitorpamplona/quartz/nip01Core/relay/client/stats/RelayStats.kt`

Tracks per-relay statistics via an LRU cache:
- `pingInMs` -- connection latency
- `compression` -- whether relay uses compression
- Bytes sent/received
- Error messages, notices, rejected events, subscription closures

### `BasicRelayClient` Reconnection

- Exponential backoff starting at 500ms
- Doubles delay on consecutive failures
- Resets delay after successful connection
- 60 second wait after intentional disconnect

### Blocked Relay List

**File:** `/tmp/outbox-research/amethyst/amethyst/src/main/java/com/vitorpamplona/amethyst/model/nip51Lists/blockedRelays/BlockedRelayListState.kt`

Users can maintain an encrypted NIP-51 blocked relay list. Blocked relays are subtracted from outbox relay sets at the flow level:

```kotlin
val outboxPerRelayMinusBlockedFlow =
    combine(outboxPerRelayFlow, blockedRelayList.flow) { followList, blockedRelays ->
        followList.minus(blockedRelays)
    }
```

---

## 8. NIP-70 (Protected Events)

**File:** `/tmp/outbox-research/amethyst/quartz/src/commonMain/kotlin/com/vitorpamplona/quartz/nip70ProtectedEvts/EventExt.kt`

```kotlin
fun Event.isProtected() = tags.isProtected()
```

Amethyst has NIP-70 tag parsing support. However, there is **no direct interaction** between the NIP-70 protected events logic and the outbox relay selection system. The `isProtected()` check is available for relay-level enforcement but does not influence which relays events are sent to or fetched from.

---

## 9. Relay Hint Handling

### Bloom Filter-Based `HintIndexer`

**File:** `/tmp/outbox-research/amethyst/quartz/src/commonMain/kotlin/com/vitorpamplona/quartz/nip01Core/hints/HintIndexer.kt`

Amethyst uses a novel **bloom filter** approach for relay hint storage. Instead of storing hints in a database, it uses three large bloom filters:

```kotlin
class HintIndexer {
    private val eventHints = BloomFilterMurMur3(40_000_000, 10)    // ~5MB for events
    private val addressHints = BloomFilterMurMur3(7_000_000, 10)   // ~875KB for addresses
    private val pubKeyHints = BloomFilterMurMur3(30_000_000, 10)   // ~3.75MB for keys

    val relayDB = LargeCache<NormalizedRelayUrl, NormalizedRelayUrl>()

    fun addKey(key: HexKey, relay: NormalizedRelayUrl) = add(key.hexToByteArray(), relay, pubKeyHints)

    fun hintsForKey(key: HexKey) = relayDB.filter { relay, _ ->
        pubKeyHints.mightContain(key.hexToByteArray(), relay.hashCode())
    }
}
```

The bloom filter uses the relay URL's hashcode as a seed differentiator. To query hints for a pubkey, it iterates all known relays and checks which ones "might contain" the pubkey. This has false positives but no false negatives, making it a compact probabilistic index.

### Hint Sources

**File:** `/tmp/outbox-research/amethyst/amethyst/src/main/java/com/vitorpamplona/amethyst/model/LocalCache.kt`

Hints are populated from multiple sources:

1. **NIP-19 references** (nprofile, nevent, naddr): relay hints from bech32 entities
   ```kotlin
   is NProfile -> nip19.relay.forEach { relayHints.addKey(nip19.hex, relayHint) }
   is NEvent -> nip19.relay.forEach { relayHints.addEvent(nip19.hex, relayHint) }
   ```

2. **Event receipt**: when any event arrives from a relay
   ```kotlin
   relayHints.addEvent(event.id, relay)
   if (event is AddressableEvent) relayHints.addAddress(event.addressTag(), relay)
   ```

3. **Event tag hints** (from HintProvider interfaces):
   ```kotlin
   if (event is EventHintProvider) {
       event.eventHints().forEach { relayHints.addEvent(it.eventId, it.relay) }
   }
   if (event is PubKeyHintProvider) {
       event.pubKeyHints().forEach { relayHints.addKey(it.pubkey, it.relay) }
   }
   ```

4. **Implicit hints**: linked event IDs and pubkeys from tags (without explicit relay hint) are associated with the relay the event was received from

### HintProvider Interfaces

**File:** `/tmp/outbox-research/amethyst/quartz/src/commonMain/kotlin/com/vitorpamplona/quartz/nip01Core/hints/HintProviders.kt`

```kotlin
interface EventHintProvider {
    fun eventHints(): List<EventIdHint>    // e-tags with relay hints
    fun linkedEventIds(): List<HexKey>     // e-tags without hints
}
interface PubKeyHintProvider {
    fun pubKeyHints(): List<PubKeyHint>    // p-tags with relay hints
    fun linkedPubKeys(): List<HexKey>      // p-tags without hints
}
interface AddressHintProvider {
    fun addressHints(): List<AddressHint>  // a-tags with relay hints
    fun linkedAddressIds(): List<String>   // a-tags without hints
}
```

---

## 10. Relay List Recommendation Processor

**File:** `/tmp/outbox-research/amethyst/quartz/src/commonMain/kotlin/com/vitorpamplona/quartz/nip65RelayList/RelayListRecommendationProcessor.kt`

Amethyst includes a **relay set minimization algorithm** that computes the smallest set of relays needed to cover all followed users:

```kotlin
fun reliableRelaySetFor(usersAndRelays, relayUrlsToIgnore): Set<RelayRecommendation> {
    // Pass 1: Greedy set cover - pick most popular relay, remove served users, repeat
    do {
        val popularity = transpose(usersToServe, selected)
        val mostPopularRelay = popularity.maxBy { it.value.size }
        selected.add(mostPopularRelay.key)
        mostPopularRelay.value.forEach { usersToServe.remove(it) }
    } while (usersToServe.isNotEmpty())

    // Pass 2: Ensure each user is served by at least 2 relays
    // Same greedy algorithm for users with only 1 serving relay
}
```

This is used for the "Add Outbox Relay List" dialog, suggesting which relays a user should add.

---

## 11. Architecture Summary

### Relay List Types in Amethyst

| List | Kind / Storage | Purpose |
|------|---------------|---------|
| NIP-65 Relay List | kind 10002 | Read/write relay declarations |
| DM Relay List | kind 10050 | DM inbox relays |
| Proxy Relay List | NIP-51 encrypted | Bypass outbox model, send all through proxy |
| Blocked Relay List | NIP-51 encrypted | Exclude relays from outbox |
| Broadcast Relay List | NIP-51 encrypted | Additional write relays |
| Indexer Relay List | NIP-51 encrypted | Where to discover user metadata/relay lists |
| Search Relay List | NIP-51 encrypted | Relays for search queries |
| Trusted Relay List | NIP-51 encrypted | Relays trusted for AUTH |
| Private Storage | NIP-51 encrypted | Private data storage relays |
| Local Relay | local config | Local relay connections |

### Data Flow (Read Side)

```
Kind 3 follow list
  -> For each follow, lookup kind 10002 addressable note
  -> OutboxRelayLoader: extract write relays per user
  -> Fallback: HintIndexer bloom filter -> eventFinderRelays
  -> Group: Map<Relay, Set<Author>>
  -> AllFollowsTopNavPerRelayFilterSet
  -> Per-relay subscription filters (REQ with authors specific to that relay)
  -> Dynamic RelayPool connects/disconnects as needed
```

### Data Flow (Write Side)

```
Event to publish
  -> computeRelayListToBroadcast(event)
  -> Start with own outbox relays (NIP-65 write + private + local + broadcast)
  -> Add inbox relays for all tagged users (NIP-65 read)
  -> Add relay hints from event tags
  -> Add linked event/address relay associations
  -> client.send(event, relaySet)
```
