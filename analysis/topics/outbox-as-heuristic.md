# Outbox as One Heuristic Among Many

## Overview

The term "outbox model" is often used as shorthand for the entire relay routing problem, but in practice it describes just one heuristic -- using NIP-65 write relays to find someone's events. Real implementations combine many heuristics, each suited to a different context. This document catalogs the relay selection heuristics found across the analyzed codebases and examines how they are composed.

---

## 1. Heuristics Taxonomy

### 1a. Outbox (NIP-65 Write Relays)

**Purpose:** Find events authored by a specific pubkey by querying the relays that pubkey has declared as "write" in their kind 10002 event.

**Implementations:**

| Project | Code Reference | Notes |
|---------|---------------|-------|
| Gossip | `PersonRelay2.write` flag set from kind 10002 in `storage/mod.rs` `set_relay_list()` | RelayUsage::Outbox in association_score yields 1.0 weight |
| Welshman | `Router.FromPubkey(pk)` resolves to `RelayMode.Write` in `packages/router/src/index.ts` | Core of `getFilterSelectionsForAuthors()` |
| NDK | `OutboxTracker` stores `writeRelays` per pubkey; `chooseRelayCombinationForPubkeys(ndk, pubkeys, "write")` in `core/src/outbox/index.ts` | Default enabled; tracks relay lists via LRU cache with 2-minute TTL |
| Applesauce | `getOutboxes(event)` in `packages/core/src/helpers/mailboxes.ts`; `includeMailboxes(store, "outbox")` RxJS operator | Reactive pipeline updates when kind 10002 changes |
| noStrudel | Uses Applesauce's `includeMailboxes` via `includeOutboxRelays()` in `src/models/outbox-selection.ts` | Adds health filtering and fallback injection |
| Amethyst | `OutboxRelayLoader.authorsPerRelay()` extracts `writeRelaysNorm()` from `AdvertisedRelayListEvent` in `OutboxRelayLoader.kt` | Reactive flow recomputes when any follow's kind 10002 changes |
| Nostur | `pubkeysByRelay()` builds `findEventsRelays` dict (relay -> pubkeys with write flag) in `Outbox.swift` (NostrEssentials library) | `createRequestPlan()` greedily assigns authors to their write relays |
| rust-nostr | `GossipRelayFlags::WRITE` (bit 1) set from kind 10002; `break_down_filter()` maps authors to WRITE relays in `sdk/src/client/gossip/resolver.rs` | Also includes HINT and RECEIVED relays as supplementary |
| Voyage | `Nip65Dao.getWriteRelays()` queried during autopilot in `RelayProvider.kt` | Greedy coverage algorithm, max 25 autopilot relays |
| Nosotros | `subscribeOutbox()` resolves `authors` field to WRITE relays via `subscribeAuthorsRelayList()` in `subscribeOutbox.ts` | RxJS observable pipeline, per-author |
| Wisp | `RelayScoreBoard.recompute()` builds relay->authors mapping from write relays in `RelayScoreBoard.kt` | Greedy set-cover, max 75 scored relays |

**Not implemented:** Yakihonne (fetches kind 10002 for own account only, not for follows), Notedeck (parses NIP-65 but no per-author routing yet), Shopstr (reads kind 10002 for own relay config only).

### 1b. Inbox (NIP-65 Read Relays)

**Purpose:** Deliver events *to* a specific pubkey by publishing to the relays that pubkey has declared as "read" in their kind 10002 event. Also used to fetch events that tag a user (notifications, mentions).

**Implementations:**

| Project | Code Reference | Notes |
|---------|---------------|-------|
| Gossip | `PersonRelay2.read` flag; `get_all_pubkey_inboxes()` used in `relays_to_post_to()` in `relay.rs` | Publishing to tagged users' read relays |
| Welshman | `Router.ForPubkey(pk)` resolves to `RelayMode.Read`; `PublishEvent` sends to tagged pubkeys' read relays at 0.5 weight | `ForUser()` fetches user's own read relays for notifications |
| NDK | `chooseRelayCombinationForPubkeys(ndk, pTags, "read")` in `relay/sets/calculate.ts` | Only for events with < 5 p-tags |
| Applesauce | `getInboxes(event)` in `packages/core/src/helpers/mailboxes.ts` | `includeMailboxes(store, "inbox")` for inbox routing |
| Amethyst | `user.inboxRelays()` from `readRelaysNorm()` on kind 10002; `computeRelayListForLinkedUser()` in `Account.kt` | Inbox relays of every tagged/linked user added to publish set |
| Nostur | `createWritePlan()` resolves tagged users' read relays from `PreferredRelays.reachUserRelays` in `Outbox.swift` | Greedy assignment of relays covering most tagged users |
| rust-nostr | `GossipRelayFlags::READ` (bit 0); `#p` tag routing in `break_down_filter()` maps to READ relays | Publish also combines tagged users' READ + HINT + RECEIVED |
| Voyage | `nip65Dao.getReadRelays(pubkeys)` in `getPublishRelays()` in `RelayProvider.kt` | MAX_RELAYS_PER_PUBKEY = 2, preferring connected |
| Nosotros | `subscribeOutbox()` for `#p`/`#P` fields selects READ relays; `subscribeEventRelays()` resolves mentioned READ relays | Observable-based publish routing |
| Wisp | `OutboxRouter.publishToInbox()` publishes to target's read relays in `OutboxRouter.kt` | Used for replies, reactions, reposts |

### 1c. DM Inbox (Kind 10050 / NIP-17)

**Purpose:** Route encrypted direct messages (NIP-17 gift wraps) to relays a user has designated specifically for private messaging.

**Implementations:**

| Project | Code Reference | Notes |
|---------|---------------|-------|
| Gossip | `PersonRelay2.dm` flag set from kind 10050 in `process_dm_relay_list()`; `prepare_post_nip17` in `post.rs` routes giftwraps to DM relays | Falls back to write relays if no DM relays |
| Welshman | `RelayMode.Messaging` in `getPubkeyRelays()`; `Router.MessagesForUser()` in router; kind 10050 list via `getMessagingRelayList()` | Coracle loads wraps from messaging relays |
| Amethyst | `user.dmInboxRelays()` returns kind 10050 relays, falling back to inbox relays; `dmRelayListNote` on User model | GiftWrap publishing checks DM inbox first |
| Nostur | Kind 10050 DM relays configurable in `Kind10002ConfigurationWizard.swift` (max 3) | Published as separate kind 10050 event |
| rust-nostr | `GossipRelayFlags::PRIVATE_MESSAGE` (bit 2) from kind 10050; `gossip_prepare_urls()` routes GiftWrap exclusively to PM relays | Separate bitflag from read/write |

**Not implemented:** NDK (no explicit kind 10050 routing), Applesauce/noStrudel (no kind 10050 handling), Voyage, Nosotros, Wisp, Shopstr.

### 1d. Relay Hints (from Event Tags)

**Purpose:** Use relay URLs embedded in `e`, `p`, `a`, `q` tag third fields, or in NIP-19 bech32 entities (nprofile, nevent, naddr), to find specific events or reach specific pubkeys.

**Implementations:**

| Project | Code Reference | Notes |
|---------|---------------|-------|
| Gossip | `PersonRelay2.last_suggested` updated from p-tag relay hints in `process/mod.rs`; scored at 0.1 base with 7-day halflife | Weakest signal source; nprofile hints also processed |
| Welshman | `EventParents()` extracts relay hints from reply/mention tags; `FromRelays(relays)` adds hinted relays in `router/src/index.ts` | Used for thread context fetching |
| NDK | `calculateRelaySetFromEvent()` extracts relay hints from e/a tags (up to 5) in `relay/sets/calculate.ts` | Publish path includes tag hints |
| Amethyst | `HintIndexer` bloom filter stores pubkey-relay, event-relay, address-relay associations; populated from NIP-19 refs, event tags, and event receipt | `hintsForKey()` iterates all known relays checking bloom membership |
| Nostur | `resolveRelayHint()` priority cascade: write relay + connection stats + received-from, down to write relay alone; ephemeral connections (35s timeout) | Opt-in "Follow relay hints" toggle |
| rust-nostr | `GossipRelayFlags::HINT` (bit 3) from p-tag hints; included in relay selection for both outbox and publish routing | 1 hint relay per user by default |
| Nosotros | `hintsToRelayFilters()` resolves hint relays from event tags; capped at 4 hint relays per subscription in `NostrSubscriptionBuilder.ts` | Separate merge stream in subscription builder |
| Wisp | `OutboxRouter.getRelayHint()` prefers overlap between target's inbox and own outbox, then target inbox, then own outbox | Used when composing events with relay hint tags |

**Not implemented:** Voyage (no relay hint extraction), Shopstr, Yakihonne, Notedeck.

### 1e. Search Relays (NIP-50)

**Purpose:** Route full-text search queries to relays that advertise NIP-50 search support.

**Implementations:**

| Project | Code Reference | Notes |
|---------|---------------|-------|
| Welshman | `Router.Search()` returns `getSearchRelays()` from context; `getFilterSelections()` sends search filters to search relays | Coracle configures `nostr.wine, search.nos.today` |
| Amethyst | `DefaultSearchRelayList` including `nostr.wine`, `relay.noswhere.com`, `search.nos.today`; user-customizable NIP-51 encrypted list | Search relays also used in progressive discovery cascade |
| Welshman/app | Default search relay getter filters relays supporting NIP-50 via `r.supported_nips?.includes?.("50")` | Dynamic based on relay NIP-11 info |
| Gossip | `RelayUsage::SEARCH` flag (bitmask) on Relay3 | User-assignable role |

### 1f. Indexer / Aggregator Relays

**Purpose:** Query specialized relays that aggregate metadata (kind 0, 3, 10002, 10050) across the network. Used primarily for relay list discovery.

**Implementations:**

| Project | Code Reference | Notes |
|---------|---------------|-------|
| Welshman | `Router.Index()` returns `getIndexerRelays()`; `getFilterSelectionsForIndexedKinds()` routes kinds 0, 3, 10002, 10050 to indexers | Coracle: `purplepag.es, relay.damus.io, indexer.coracle.social` |
| NDK | `DEFAULT_OUTBOX_RELAYS = ["wss://purplepag.es/", "wss://nos.lol/"]`; separate outbox pool in constructor | Dedicated relay pool for metadata discovery |
| Amethyst | `DefaultIndexerRelayList` with `purplepag.es, indexer.coracle.social, user.kindpag.es, directory.yabu.me, profiles.nostr1.com` | User-customizable via NIP-51 encrypted list |
| noStrudel | `DEFAULT_LOOKUP_RELAYS = ["wss://purplepag.es/"]` in `const.ts` | User-configurable lookup relays |
| Wisp | `RelayProber` harvests kind 10002 from bootstrap relays (relay.damus.io, relay.primal.net) | Not explicit indexer concept, but bootstrap relays serve same role |

### 1g. Discovery Relays

**Purpose:** Fetch relay lists (kind 10002, 10050) for followed pubkeys. Overlaps with indexer relays but can be a distinct role.

**Implementations:**

| Project | Code Reference | Notes |
|---------|---------------|-------|
| Gossip | `RelayUsage::DISCOVER` flag; `subscribe_discover(followed, None)` on startup fetches relay lists from DISCOVER relays | Dedicated relay role, separate from read/write |
| Amethyst | Progressive discovery cascade: outbox relays -> hint relays -> indexer relays -> home relays -> search relays -> connected relays -> shared outbox relays | Tiered strategy with >300 follow threshold for load shedding |

### 1h. Community / Group Relays

**Purpose:** Route events related to NIP-72 communities or NIP-29 groups to the specific relays designated for those communities.

**Implementations:**

| Project | Code Reference |
|---------|---------------|
| Amethyst | Channel relays added to publish set in `computeRelayListToBroadcast()`; community/group relay routing in subscription filters |

This heuristic is underrepresented in the analyzed codebases. Most clients do not yet implement community or group-specific relay routing.

### 1i. Event Delivery Tracking (Observed/Received Relays)

**Purpose:** Track which relays have historically delivered events from a given pubkey, and use this as a supplementary signal for relay selection.

**Implementations:**

| Project | Code Reference | Notes |
|---------|---------------|-------|
| Gossip | `PersonRelay2.last_fetched` updated when events are seen; scored at 0.2 base with 14-day halflife | Weak signal, below declared relays |
| Amethyst | `UserRelaysCache` on each User object tracks relay frequency via `RelayInfo(lastEvent, counter)` | Used as fallback via `mostUsedNonLocalRelay()` |
| rust-nostr | `GossipRelayFlags::RECEIVED` (bit 4); `received_events` count and `last_received_event` timestamp | Relays sorted by received count when selecting "most used" |
| Voyage | `EventRelayAuthorView` tracks which relay delivered events from which author | Phase 2 of autopilot algorithm uses this for coverage |
| Nosotros | `seen` table stores `(eventId, relay, created_at)`; `relayStats` table counts events per relay | `selectRelays()` sorts by events count descending |

### 1j. Zap Receipt Routing

**Purpose:** Route zap receipts to the relay specified in the zap request. This is a specialized relay hint embedded in Lightning payment metadata.

**Implementations:** No explicit zap receipt relay routing was found in the analyzed codebases beyond general relay hint handling. Zap requests embed relay hints in their tags, which are handled by the general relay hint mechanisms described in section 1d.

---

## 2. How Implementations Combine Multiple Heuristics

### 2a. Welshman's Scenario Composition

Welshman's `Router` provides the cleanest example of layered heuristics. Each scenario method returns a `RouterScenario` with weighted `Selection[]` arrays. Multiple scenarios are merged via `this.merge(scenarios)`, which sums weights per relay across all scenarios:

```
PublishEvent = merge([
  FromPubkey(author)              // author's write relays, weight 1.0
  ForPubkey(tagged1).weight(0.5)  // tagged user's read relays, weight 0.5
  ForPubkey(tagged2).weight(0.5)  // another tagged user's read relays, weight 0.5
]).limit(30)
```

The scoring formula `quality * log(weight) * random()` compresses hub bias via logarithm and adds stochastic variation. Different contexts use different scenario compositions:

- **Feed loading:** `FromPubkeys(authors)` for outbox, `ForUser()` with 0.2 weight for own read relays
- **Thread context:** `FromPubkeys(replyAuthors).weight(10)` + `FromPubkeys(mentionedPubkeys)` + `FromRelays(tagHints)`
- **Publishing:** Author's write + tagged users' read (0.5 weight), limit 30
- **Notifications:** `ForUser().policy(addMaximalFallbacks)` -- user's own read relays with aggressive fallback
- **DMs:** `MessagesForUser()` -- kind 10050 messaging relays
- **Metadata discovery:** `Index()` -- indexer relays

The fallback policies (`addNoFallbacks`, `addMinimalFallbacks`, `addMaximalFallbacks`) add another dimension of composition.

### 2b. Gossip's Relay Usage Flags (Bitmask Roles)

Gossip assigns roles to relays via bitmask flags on the `Relay3` record:

```rust
const OUTBOX: u64 = 1 << 1;    // kind 10002 write
const INBOX: u64 = 1 << 2;     // kind 10002 read
const DISCOVER: u64 = 1 << 3;  // relay list discovery
const DM: u64 = 1 << 4;        // kind 10050 DM relays
const READ: u64 = 1 << 5;      // general read relays
const WRITE: u64 = 1 << 6;     // general write relays
const GLOBAL: u64 = 1 << 7;    // global feed relays
const SEARCH: u64 = 1 << 8;    // NIP-50 search
const SPAMSAFE: u64 = 1 << 9;  // known-safe relays
```

A single relay can have multiple roles (e.g., OUTBOX | INBOX | DISCOVER). The `choose_relay_urls(usage, filter)` method selects relays matching a specific usage bitmask. Different operations compose these roles:

- **Startup subscriptions:** DISCOVER relays for relay list fetching, READ relays for inbox, DM + INBOX relays for giftwraps
- **RelayPicker:** Uses OUTBOX-flagged relays for followed pubkeys, composed with relay health scores
- **Publishing:** WRITE relays + tagged users' INBOX relays + DM relays for NIP-17
- **Relay list advertisement:** Any relay matching INBOX | OUTBOX | DISCOVER or having good success rates

### 2c. rust-nostr's Bitflags Per Pubkey-Relay Pair

rust-nostr uses bitflags at the *person-relay pair* level rather than the relay level:

```rust
READ: 1           // kind 10002 read marker
WRITE: 2          // kind 10002 write marker
PRIVATE_MESSAGE: 4 // kind 10050
HINT: 8           // p-tag relay hints
RECEIVED: 16      // observed event delivery
```

The `break_down_filter()` method composes multiple flag types based on the filter structure:

- **`authors` only:** WRITE + HINT + most-RECEIVED relays (outbox pattern)
- **`#p` only:** READ + HINT + most-RECEIVED relays (inbox pattern)
- **Both `authors` and `#p`:** Union of ALL relay types
- **Neither:** Falls back to client's configured READ relays

Each flag type has configurable limits: `write_relays_per_user: 3`, `read_relays_per_user: 3`, `hint_relays_per_user: 1`, `most_used_relays_per_user: 1`, `nip17_relays: 3`.

### 2d. Amethyst's Relay List Types

Amethyst maintains the most distinct relay list types among the analyzed clients:

| List | Kind / Storage | Role |
|------|---------------|------|
| NIP-65 Relay List | kind 10002 | Read/write relay declarations |
| DM Relay List | kind 10050 | DM inbox relays |
| Proxy Relay List | NIP-51 encrypted | Bypass outbox, send all through proxy |
| Blocked Relay List | NIP-51 encrypted | Exclude relays from outbox |
| Broadcast Relay List | NIP-51 encrypted | Additional write relays |
| Indexer Relay List | NIP-51 encrypted | Metadata/relay list discovery |
| Search Relay List | NIP-51 encrypted | NIP-50 search queries |
| Trusted Relay List | NIP-51 encrypted | Relays trusted for NIP-42 AUTH |
| Private Storage | NIP-51 encrypted | Private data storage |
| Local Relay | local config | Local relay connections |

These lists are composed at the flow level using Kotlin's `combine()` and `flatMapLatest()`:

```kotlin
// Own outbox = NIP-65 write + private storage + local + broadcast
val outboxRelays = combine(nip65.outboxFlow, privateStorage.flow, local.flow, broadcast.flow)

// Effective outbox = outbox minus blocked, OR proxy if configured
val effectiveOutbox = proxyRelayList.flow.flatMapLatest { proxyRelays ->
    if (proxyRelays.isEmpty()) outboxPerRelayMinusBlockedFlow
    else kind3Follows.flow.map { follows -> proxyRelays.associateWith { follows.authors } }
}
```

The proxy relay system is particularly notable: when configured, it completely replaces the outbox model, sending all filters through a single trusted relay. This is an explicit fallback for privacy-focused users (especially Tor users) who cannot tolerate the relay fan-out of outbox routing.

---

## 3. The "Skip Top N" Anti-Centralization Heuristic

Nostur's `createRequestPlan()` implements a unique anti-centralization feature: the `skipTopRelays` parameter (default 3 for the Following feed). After sorting relays by coverage count, the top N relays are skipped in the greedy assignment. This forces the algorithm to distribute load across more relays rather than concentrating on mega-hubs like relay.damus.io or nos.lol.

Similarly, Wisp's `RelayProber` explicitly drops the top 5 mega-relays when selecting relay candidates during onboarding: it tallies relay URL frequency from harvested kind 10002 events, then filters to "middle tier" relays (requires frequency >= 3 but not in the top 5). This prevents new users from defaulting to the same few popular relays.

Amethyst takes a blocklist approach: `feeds.nostr.band`, `filter.nostr.wine`, `nwc.primal.net`, and `relay.getalby.com` are unconditionally excluded from outbox relay selection because they are known aggregators or special-purpose relays.

---

## 4. Unsolved Problems

### 4a. Events with t-tags (Hashtags)

No analyzed implementation routes subscriptions for hashtag-filtered events (e.g., `{"#t": ["nostr"]}`) using any relay heuristic beyond the user's own read relays or all connected relays. When a filter has `#t` tags but no `authors`, the outbox model provides no guidance because there is no pubkey to look up.

Welshman's `getFilterSelections()` sends non-author, non-search filters to `ForUser().weight(0.2)` -- the user's own read relays with low weight. This means hashtag queries only reach relays the user already knows about.

The missing heuristic: relays could advertise which hashtags they specialize in (or have high coverage for), enabling a "hashtag relay" discovery mechanism. No analyzed project implements this.

### 4b. Events with g-tags (Geohash/Location)

Geohash-tagged events have the same problem as hashtag events -- there is no pubkey-based routing, and no relay-level geohash specialization discovery. Amethyst includes `geotags` in its subscription filter structure but routes them through the same relay set as the follow feed rather than to geographically-specialized relays.

### 4c. Relay Signaling and Capability Discovery

Most implementations hardcode relay roles (search relays, indexer relays) rather than discovering them dynamically. The partial exceptions:

- **Welshman/app** dynamically identifies search relays by checking `relay.supported_nips?.includes?.("50")` from NIP-11 info documents
- **Wisp's RelayProber** probes relay capabilities via NIP-11 fetch + ephemeral write test during onboarding
- **noStrudel** uses Applesauce's `RelayLiveness` to track health but not capabilities

The unsolved problem: there is no standard mechanism for relays to advertise their coverage, specialization, or capabilities beyond NIP-11's `supported_nips` array. A relay might be excellent for Japanese-language content or for long-form articles, but clients have no way to discover this programmatically.

### 4d. Cross-Heuristic Conflict Resolution

When multiple heuristics disagree about relay selection, implementations use ad hoc priority rules:

- **Gossip** uses the strong/weak relay split: declared relays (score >= 1.0) always beat undeclared ones
- **Welshman** uses weight multiplication with logarithmic compression
- **rust-nostr** uses separate per-flag limits, then unions the results
- **Amethyst** uses a fixed priority cascade in `OutboxRelayLoader`

There is no formal framework for weighting conflicting signals. For example: if a user's kind 10002 says "write to relay A" but relay A has been dead for a month, while relay B has consistently delivered their events, how much should the declared signal override the observed evidence? Gossip's exponential decay model is the most principled approach, but even it treats declared relays as binary (either 1.0 or not).

### 4e. Relay Selection for Replaceable Events vs. Regular Events

All analyzed implementations treat relay selection the same regardless of whether the event being fetched is replaceable (kind 0, 3, 10002) or regular (kind 1, 7). For replaceable events, a single copy from any relay suffices, so the optimal strategy might differ (fewer relays needed, prefer faster/more reliable ones). Only Welshman explicitly routes "indexed kinds" (0, 3, 10002, 10050) to indexer relays as a special case.
