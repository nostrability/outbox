# Amethyst Outbox Implementation Analysis

## Key Findings

- **Reactive relay selection**: Kotlin `StateFlow` pipelines recompute per-relay subscription filters automatically when any follow's kind 10002 changes.
- **Bloom filter hint index**: Three bloom filters (~9.6MB total) provide probabilistic relay hints for pubkeys, events, and addresses -- no database needed.
- **Proxy relay bypass**: When Tor proxy relays are configured, the outbox model is completely bypassed -- all filters go through a single trusted relay.
- **>300 follow threshold**: Users following >300 accounts get reduced relay fan-out (2 indexer relays instead of all, 20 connected relays instead of 100).
- **Full inbox publisher**: Write-side sends events to own outbox relays + inbox (read) relays of every tagged/mentioned user.
- **Hard-coded blocklist**: Aggregator relays (`feeds.nostr.band`, `filter.nostr.wine`, `nwc.primal.net`, `relay.getalby.com`) always excluded from outbox selection.
- **10 distinct relay list types** (see table below), most stored as NIP-51 encrypted lists.

### Relay List Types

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

---

## Relay Selection

### `OutboxRelayLoader` -- Core Read-Side Logic

**File:** `/tmp/outbox-research/amethyst/amethyst/src/main/java/com/vitorpamplona/amethyst/model/topNavFeeds/OutboxRelayLoader.kt`

Maps each followed pubkey to their declared write relays, groups subscriptions so each relay gets a filter containing only the authors who write there.

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

- `rawOutboxRelays = false` (default): full fallback chain (kind 10002 -> hint indexer -> `eventFinderRelays`)
- `rawOutboxRelays = true`: only declared kind 10002 write relays, empty set if none. Used for relay recommendation display.

### Reactive Flow Pipeline

The loader is wired into `StateFlow` via `toAuthorsPerRelayFlow()`. For each followed pubkey, Amethyst observes the addressable note at `10002:<pubkey>:`. Any kind 10002 create/update recomputes the entire relay-to-author map and rebuilds subscription filters.

### Read-Side Fallback Chain

1. Kind 10002 `writeRelaysNorm()` -- declared write relays
2. `cache.relayHints.hintsForKey(authorHex)` -- bloom filter hints
3. `Constants.eventFinderRelays` -- hard-coded: `nostr.wine, relay.damus.io, relay.primal.net, nostr.mom, nos.lol, nostr.bitcoiner.social, nostr.oxtr.dev`

### Discovery: Fetching Kind 10002 Lists

**File:** `/tmp/outbox-research/amethyst/amethyst/src/main/java/com/vitorpamplona/amethyst/service/relayClient/reqCommand/account/follows/FilterFindFollowMetadataForKey.kt`

Progressive 5-tier search for users without a known kind 10002:

```
1. Outbox relays already known -> query those (stop)
2. Relay hints exist -> query those
3. If hints < 3 -> also query:
   a. Indexer relays (purplepag.es, indexer.coracle.social, user.kindpag.es, directory.yabu.me, profiles.nostr1.com)
   b. Home relays (user's own NIP-65 + private + local)
   c. If >300 users, limit indexer queries to 2 per user
4. If indexer relays < 2 -> also query:
   a. Search relays (nostr.wine, relay.noswhere.com, search.nos.today, etc.)
   b. Connected relays (up to 100, or 20 if >300 users)
5. If search relays < 2 -> query common/shared outbox relays
```

The >300 user threshold is explicit load shedding:

```kotlin
if (users.size > 300) {
    if (indexRelaysLeftToTry.size >= 2) {
        add(indexRelaysLeftToTry[0], key.pubkeyHex)
        add(indexRelaysLeftToTry[1], key.pubkeyHex)
    }
    connectedRelaysLeftToTry.take(20).forEach { add(it, key.pubkeyHex) }
} else {
    indexRelaysLeftToTry.forEach { add(it, key.pubkeyHex) }
    connectedRelaysLeftToTry.forEach { add(it, key.pubkeyHex) }
}
```

Users can customize their indexer relay list, stored as a NIP-51 encrypted list event.

### Person-Relay Tracking

- **Primary**: Kind 10002 stored as addressable notes in `LocalCache`. `User` model exposes `outboxRelays()`, `inboxRelays()`, `dmInboxRelays()`, `bestRelayHint()`.
- **Secondary**: `UserRelaysCache` -- runtime frequency map on each `User`. Every event received from a relay increments a counter. Sorted by `counter desc, lastEvent desc`.
- **No SQL/Room database** for relay tracking. All in-memory: addressable notes, `UserRelaysCache`, and bloom filter `HintIndexer`.

---

## Connection Management

### Dynamic Relay Pool

**File:** `/tmp/outbox-research/amethyst/quartz/src/commonMain/kotlin/com/vitorpamplona/quartz/nip01Core/relay/client/NostrClient.kt`

The `RelayPool` dynamically adds/removes connections based on the union of active subscription needs, count queries, and event outbox needs. Pool updated every 300ms max.

### Reconnection

- Exponential backoff starting at 500ms, doubling on failure
- 60 second wait after intentional disconnect
- `RelayOfflineTracker` maintains a `cannotConnectRelays` set, subtracted from candidate relays during discovery

### Blocked Relay List

**File:** `/tmp/outbox-research/amethyst/amethyst/src/main/java/com/vitorpamplona/amethyst/model/nip51Lists/blockedRelays/BlockedRelayListState.kt`

Users maintain an encrypted NIP-51 blocked relay list. Blocked relays subtracted from outbox relay sets at the flow level.

### Proxy Relay Multiplexing

**File:** `/tmp/outbox-research/amethyst/amethyst/src/main/java/com/vitorpamplona/amethyst/model/topNavFeeds/allFollows/AllFollowsByProxyTopNavFilter.kt`

When proxy relays are configured, the outbox model is completely bypassed. All follow filters go to proxy relays with the full author list:

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

### Tor / SOCKS Proxy Support

**File:** `/tmp/outbox-research/amethyst/amethyst/src/main/java/com/vitorpamplona/amethyst/ui/tor/TorSettings.kt`

Per-category routing: `onionRelaysViaTor`, `dmRelaysViaTor`, `newRelaysViaTor`, `trustedRelaysViaTor`. Media, NIP-05, wallet operations independently routed. Presets: "Only When Needed", "Default", "Small Payloads", "Full Privacy".

---

## Publishing & Fallbacks

### Write-Side Strategy

**File:** `/tmp/outbox-research/amethyst/amethyst/src/main/java/com/vitorpamplona/amethyst/model/Account.kt`

For general events, `computeRelayListToBroadcast(event)` builds the relay set:
1. Author's own outbox relays (NIP-65 write + private + local + broadcast)
2. Relay hints from tagged pubkeys
3. **Inbox relays** of every tagged/linked user
4. Relay hints from tagged events and addresses
5. Channel relays if applicable

Special cases:
- **Metadata/relay list events**: published to ALL relays (follow list + all connected)
- **DMs (GiftWrap)**: DM inbox relay list (kind 10050), fallback to NIP-65 read relays
- **Reactions**: broad set -- own outbox + original author inbox + all tagged user inboxes + channel relays + relays event was received from

### Write-Side Fallback for Linked Users

1. Kind 10002 read (inbox) relays
2. If none: bloom filter hints + all observed relays

### Own Relay List Fallback

**File:** `/tmp/outbox-research/amethyst/amethyst/src/main/java/com/vitorpamplona/amethyst/model/nip65RelayList/Nip65RelayListState.kt`

- Missing write relays -> `eventFinderRelays` (damus, primal, mom, nos, bitcoiner, oxtr, wine)
- Missing read relays -> `bootstrapInbox` (damus, primal, mom, nos, bitcoiner, oxtr, yabu)

---

## Bloom Filter Hint Indexer

**File:** `/tmp/outbox-research/amethyst/quartz/src/commonMain/kotlin/com/vitorpamplona/quartz/nip01Core/hints/HintIndexer.kt`

Three bloom filters instead of a database:

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

Uses relay URL hashcode as seed differentiator. To query hints for a pubkey, iterates all known relays and checks which "might contain" the pubkey. False positives possible, no false negatives.

Hint sources:
- NIP-19 references (nprofile, nevent, naddr): relay hints from bech32 entities
- Event receipt: when any event arrives from a relay
- Event tag hints via `EventHintProvider`, `PubKeyHintProvider`, `AddressHintProvider` interfaces
- Implicit: linked event IDs/pubkeys from tags associated with the relay the event was received from

---

## Relay Set Minimization

**File:** `/tmp/outbox-research/amethyst/quartz/src/commonMain/kotlin/com/vitorpamplona/quartz/nip65RelayList/RelayListRecommendationProcessor.kt`

Greedy set cover for the "Add Outbox Relay List" dialog:

- Pass 1: Pick most popular relay, remove served users, repeat until all covered
- Pass 2: Ensure each user is served by at least 2 relays (same greedy algorithm for users with only 1)

---

## Data Flow

**Read Side:**
```
Kind 3 follow list
  -> For each follow, lookup kind 10002 addressable note
  -> OutboxRelayLoader: extract write relays per user
  -> Fallback: HintIndexer bloom filter -> eventFinderRelays
  -> Group: Map<Relay, Set<Author>>
  -> Per-relay subscription filters (REQ with authors specific to that relay)
  -> Dynamic RelayPool connects/disconnects as needed
```

**Write Side:**
```
Event to publish
  -> computeRelayListToBroadcast(event)
  -> Own outbox relays (NIP-65 write + private + local + broadcast)
  -> Add inbox relays for all tagged users (NIP-65 read)
  -> Add relay hints from event tags
  -> client.send(event, relaySet)
```
