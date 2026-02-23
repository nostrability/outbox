# Bootstrapping and Fallback Strategies

## Overview

Every outbox implementation faces a chicken-and-egg problem: to find someone's events you need their relay list, but to find their relay list you need to know which relays to query. This document catalogs how each project handles bootstrapping from zero state, discovers relay lists, falls back when relay lists are missing, and manages the transition from new-user to fully-connected state.

---

## 1. Default / Bootstrap Relays

### Hardcoded Bootstrap Relay Lists

Every project ships with at least one hardcoded relay list. These serve as the initial contact points for network discovery.

#### Gossip

**File:** `gossip-bin/src/ui/wizard/setup_relays.rs`

36 relays presented in the setup wizard:
```
wss://nostr.mom/, wss://e.nos.lol/, wss://relay.primal.net/, wss://nos.lol/,
wss://relay.nostr.band/, wss://relay.damus.io/, ... (30 more)
```

Gossip is notable for having **no hardcoded fallback relays at runtime**. The wizard suggests relays, but once past setup, the system is entirely data-driven. If a user has no relay data for a followed person, they may not see that person's events until relay discovery completes.

#### Welshman / Coracle

**File:** `coracle/.env.template`

```
VITE_DEFAULT_RELAYS=relay.damus.io,nos.lol
VITE_INDEXER_RELAYS=relay.damus.io,purplepag.es,indexer.coracle.social
VITE_SEARCH_RELAYS=nostr.wine,search.nos.today
VITE_SIGNER_RELAYS=relay.nsec.app,ephemeral.snowflare.cc,bucket.coracle.social
VITE_DVM_RELAYS=relay.nsec.app,ephemeral.snowflare.cc,bucket.coracle.social
```

Welshman's `@welshman/app` also provides a dynamic default: all known relays sorted by quality, capped at 5. But Coracle overrides this with the static env lists above.

#### NDK

**File:** `core/src/ndk/index.ts`

```typescript
DEFAULT_OUTBOX_RELAYS = ["wss://purplepag.es/", "wss://nos.lol/"]
```

These form a dedicated outbox pool used only for fetching kind 10002 relay lists. The main relay pool is configured by the consuming application.

#### noStrudel

**File:** `src/const.ts`

```typescript
DEFAULT_LOOKUP_RELAYS = ["wss://purplepag.es/"]
DEFAULT_FALLBACK_RELAYS = ["wss://relay.primal.net/", "wss://relay.damus.io/"]
```

Minimal defaults -- only one lookup relay and two fallback relays.

#### Amethyst

**File:** `amethyst/src/main/java/com/vitorpamplona/amethyst/model/AccountSettings.kt`

Indexer relays:
```kotlin
DefaultIndexerRelayList = setOf(
    "wss://purplepag.es",
    "wss://indexer.coracle.social",
    "wss://user.kindpag.es",
    "wss://directory.yabu.me",
    "wss://profiles.nostr1.com"
)
```

Event finder relays (fallback when no kind 10002):
```kotlin
eventFinderRelays = setOf(
    "wss://nostr.wine", "wss://relay.damus.io", "wss://relay.primal.net",
    "wss://nostr.mom", "wss://nos.lol", "wss://nostr.bitcoiner.social", "wss://nostr.oxtr.dev"
)
```

Bootstrap inbox relays (fallback when no read relays):
```kotlin
bootstrapInbox = setOf(
    "wss://relay.damus.io", "wss://relay.primal.net", "wss://nostr.mom",
    "wss://nos.lol", "wss://nostr.bitcoiner.social", "wss://nostr.oxtr.dev",
    "wss://directory.yabu.me"
)
```

Amethyst maintains the largest and most differentiated set of default relays, with separate lists for indexing, event finding, and inbox fallback.

#### Nostur

**File:** `Nostur/Relays/Network/OutboxLoader.swift`

Special-purpose relay exclusion list:
```swift
SPECIAL_PURPOSE_RELAYS = ["wss://nostr.mutinywallet.com", "wss://filter.nostr.wine", "wss://purplepag.es"]
```

Nostur does not have a single bootstrap list; instead the user configures relays during initial setup, and the outbox system discovers additional relays from kind 10002 data.

#### rust-nostr

rust-nostr itself does not hardcode bootstrap relays. The SDK provides the framework; consuming applications supply the relay list. Discovery relays and read relays are configured by the SDK consumer.

#### Voyage

**File:** `app/src/main/java/com/dluvian/voyage/core/Constants.kt`

No explicit bootstrap relay list was documented, but the autopilot algorithm falls back to READ relays for uncovered pubkeys, and the publish routing adds the user's own write relays.

#### Wisp

**File:** `app/src/main/kotlin/com/wisp/app/relay/RelayProber.kt`

Bootstrap relays for onboarding:
```kotlin
"wss://relay.damus.io", "wss://relay.primal.net"
```

These are used exclusively during the relay probing phase.

#### Nosotros

Fallback relays configured via environment variable `FALLBACK_RELAYS`. Specific defaults were not documented in the analysis, but the system uses these for any author without a known relay list.

#### Shopstr

```typescript
["wss://relay.damus.io", "wss://nos.lol", "wss://purplepag.es",
 "wss://relay.primal.net", "wss://relay.nostr.band"]
```

Plus `wss://sendit.nosflare.com` (blastr) always added to write relays via `withBlastr()`.

#### Yakihonne

```dart
constantRelays = [
    "wss://nostr-01.yakihonne.com",
    "wss://nostr-02.yakihonne.com",
    "wss://nostr-03.dorafactory.org",
    "wss://nostr-02.dorafactory.org",
    "wss://relay.damus.io"
]
```

These cannot be removed by the user and are always connected. Yakihonne is the most centralized in this regard.

#### Notedeck

```rust
bootstrap_relays = [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://nostr.wine",
    "wss://purplepag.es"
]
```

Used when no local or advertised relays are available.

### Common Relays Across Projects

The following relays appear in multiple projects' bootstrap/default lists:

| Relay | Appears In |
|-------|-----------|
| `wss://relay.damus.io` | Gossip, Coracle, noStrudel, Amethyst, Wisp, Shopstr, Yakihonne, Notedeck |
| `wss://nos.lol` | Gossip, Coracle, NDK, Shopstr, Notedeck |
| `wss://purplepag.es` | Coracle, NDK, Amethyst, noStrudel, Shopstr, Notedeck |
| `wss://relay.primal.net` | Gossip, noStrudel, Amethyst, Wisp, Shopstr |
| `wss://nostr.wine` | Amethyst, Notedeck, Coracle (search) |

`relay.damus.io` is the most universally trusted bootstrap relay, appearing in 8 of the 12 analyzed projects. `purplepag.es` is the most common indexer relay (6 projects).

---

## 2. Relay Discovery Pipeline

### 2a. Startup Sequence: Gossip

**File:** `gossip-lib/src/overlord.rs` (`start_long_lived_subscriptions`)

1. **Initialize RelayPicker**: Compute scores for all followed pubkeys from stored PersonRelay data.
2. **Connect to picked relays**: Greedy set-cover algorithm selects optimal relay set.
3. **Subscribe to config events** on WRITE relays (own metadata).
4. **Subscribe to inbox** on READ relays (incoming mentions/replies).
5. **Subscribe to giftwraps** on DM + INBOX relays.
6. **Subscribe to discover relay lists** for all followed pubkeys whose relay lists are stale (configurable, default 20 minutes).

The discovery subscription fetches `EventKind::RelayList` and `EventKind::DmRelayList` from DISCOVER relays for all pubkeys needing relay list updates. This is a batch fetch.

### 2b. Startup Sequence: Welshman / Coracle

**File:** `coracle/src/engine/state.ts`

1. Load NIP-11 relay info for all initial relays (default, DVM, indexer, search).
2. User logs in; fetch relay list (kind 10002) via `fetchRelayList()` which queries in parallel:
   - Relay hint relays
   - Known write relays (from previous session)
   - Indexer relays
3. For feed loading, `getFilterSelectionsForIndexedKinds()` routes kind 0, 3, 10002, 10050 queries to indexer relays.
4. `loadUsingOutbox()` tries relays in chunks of 2, stopping when results are found.

### 2c. Startup Sequence: NDK

**File:** `core/src/ndk/index.ts`, `core/src/outbox/tracker.ts`

1. NDK constructor creates separate outbox pool (`purplepag.es`, `nos.lol`).
2. When subscriptions are created with `authors` filters, `OutboxTracker.trackUsers()` is called.
3. Relay lists are fetched in batches of 400 pubkeys via `getRelayListForUsers()`.
4. Kind 10002 takes priority; kind 3 content parsed as fallback.
5. When relay lists arrive, `user:relay-list-updated` events trigger `refreshRelayConnections()` on active subscriptions.

### 2d. Startup Sequence: Amethyst

**File:** `amethyst/src/main/java/com/vitorpamplona/amethyst/service/relayClient/reqCommand/account/follows/`

Progressive discovery cascade for each follow without a loaded relay list:

```
1. Outbox relays already known -> query those (stop if found)
2. Relay hints from bloom filter -> query those
3. If < 3 hints:
   a. Indexer relays (purplepag.es, indexer.coracle.social, user.kindpag.es, directory.yabu.me, profiles.nostr1.com)
   b. Home relays (own NIP-65 + private + local)
   c. If >300 users: limit indexer queries to 2 per user (load shedding)
4. If < 2 indexer relays:
   a. Search relays (nostr.wine, relay.noswhere.com, search.nos.today, etc.)
   b. Connected relays (up to 100, or 20 if >300 users)
5. If < 2 search relays: query common/shared outbox relays
```

The >300 follow threshold triggers explicit load shedding to prevent opening excessive connections.

### 2e. Startup Sequence: Wisp

**File:** `app/src/main/kotlin/com/wisp/app/relay/RelayProber.kt`

Wisp has a unique onboarding relay probe:

1. Connect to bootstrap relays (`relay.damus.io`, `relay.primal.net`).
2. Harvest up to 500 kind 10002 events from the network.
3. Tally relay URL frequency across harvested events.
4. Filter to "middle tier": drop top 5 mega-relays, require frequency >= 3.
5. Probe up to 15 candidates with NIP-11 info document fetch + ephemeral write test (kind 20242).
6. Select top 8 by latency.

This is the only project that actively probes relay health and latency during discovery.

### 2f. Ongoing Discovery

Most implementations re-fetch relay lists periodically:

| Project | Staleness Check | Mechanism |
|---------|-----------------|-----------|
| Gossip | 20 minutes (configurable `relay_list_becomes_stale_minutes`) | `person_needs_relay_list()` checks `relay_list_last_sought` timestamp |
| NDK | 2 minutes (LRU TTL) | `OutboxTracker.data` LRU cache expiration |
| Amethyst | Reactive (flow-based) | `StateFlow` on addressable notes; recomputes when kind 10002 changes |
| Voyage | Lazy on-demand | `lazySubNip65s()` identifies friends with missing NIP-65 data |
| rust-nostr | TTL-based | `ensure_gossip_public_keys_fresh()` checks Missing/Outdated/Updated status |

---

## 3. Fallback Chains

When no kind 10002 relay list exists for a user, each project has a different fallback strategy.

### 3a. Gossip

**Chain:**
1. Kind 10002 write relays (association_score = 1.0) **[primary]**
2. Kind 3 contact list content (sets read/write flags, same as kind 10002) **[equivalent primary]**
3. NIP-05 relays (sets both read+write) **[equivalent primary]**
4. Relays where the person's events have been fetched (`last_fetched`, base 0.2, 14-day halflife) **[weak]**
5. Relays suggested by others' relay hints (`last_suggested`, base 0.1, 7-day halflife) **[weakest]**
6. If seeker gets no relay list within 15 seconds: user's own READ relays **[timeout fallback]**

**Code:** `get_best_relays_with_score()` in `relay.rs` separates into "strong" (association >= 1.0) and "weak" (< 1.0). Weak relays are only used if no strong relays exist.

### 3b. Welshman / Coracle

**Chain:**
1. Kind 10002 write relays (via `getPubkeyRelays(pubkey, RelayMode.Write)`) **[primary]**
2. Fallback policy: `addMinimalFallbacks` adds 1 random default relay if zero relays found **[single fallback]**
3. For indexed kinds (0, 3, 10002, 10050): always also query indexer relays **[parallel]**
4. `loadUsingOutbox()` tries relay list in chunks of 2 from known write relays, stopping on success **[progressive]**

**Code:** `addMinimalFallbacks` in `router/src/index.ts` returns `count === 0 ? 1 : 0`.

### 3c. NDK

**Chain:**
1. Kind 10002 write relays (via `OutboxTracker.data`) **[primary]**
2. Kind 3 contact list content (parsed as relay list) **[fallback primary]**
3. Pool's permanent and connected relays (for authors with no known relays) **[broad fallback]**

**Code:** `chooseRelayCombinationForPubkeys()` in `outbox/index.ts`: `authorsMissingRelays` get assigned to `pool.permanentAndConnectedRelays()`.

### 3d. Amethyst

**Chain:**
1. Kind 10002 `writeRelaysNorm()` **[primary]**
2. `HintIndexer` bloom filter hints (`hintsForKey(authorHex)`) **[secondary]**
3. `Constants.eventFinderRelays` (7 hardcoded relays) **[terminal fallback]**

For own relay list fallback:
- Write relays: `eventFinderRelays`
- Read relays: `bootstrapInbox` (7 relays, partially overlapping with eventFinderRelays)

**Code:** `OutboxRelayLoader.authorsPerRelay()` in `OutboxRelayLoader.kt` chains `?: hintsForKey() ?: eventFinderRelays`.

### 3e. Nostur

**Chain:**
1. Kind 10002 write relays (from CoreData) **[primary]**
2. User's own configured relays (always also queried) **[parallel]**
3. Misconfigured kind 10002 detection: if any write relay matches the known-bad list, the entire kind 10002 is discarded (user treated as if they have no relay list)

Nostur also has a `skipTopRelays` parameter (default 3) that intentionally avoids the most popular relays to prevent centralization, which means fallback is more likely to occur for users on those popular relays.

### 3f. rust-nostr

**Chain:**
1. WRITE relays (from gossip graph bitflags) **[primary]**
2. HINT relays (from p-tag hints, 1 per user) **[supplementary]**
3. Most-RECEIVED relays (sorted by received_events count, 1 per user) **[supplementary]**
4. Client's configured READ relays (for orphan filters with no pubkey-relay data) **[terminal fallback]**

**Code:** `break_down_filter()` in `resolver.rs` collects relays from multiple flag types. `BrokenDownFilters::Other` falls back to READ relays.

### 3g. Voyage

**Chain:**
1. NIP-65 write relays (from `Nip65Entity` table) **[primary]**
2. Event-relay tracking (`EventRelayAuthorView` -- which relays delivered this author's events) **[secondary]**
3. READ relays + already-selected relays **[tertiary fallback]**
4. Pubkeys with only 1 relay also get added to READ relays for redundancy **[redundancy pass]**

### 3h. Nosotros

**Chain:**
1. Kind 10002 WRITE relays (via tanstack-query cache) **[primary]**
2. FALLBACK_RELAYS environment variable **[terminal fallback]**

For subscriptions:
1. Outbox-resolved relay-filter pairs
2. Static relay list (user's configured relays) **[merged]**
3. Relay hints from event tags (max 4) **[merged]**

### 3i. Wisp

**Chain:**
1. RelayScoreBoard (greedy set-cover over write relays) **[primary]**
2. `subscribeByAuthors()` groups authors by write relays; authors without relay lists fall back to `sendToAll` **[broad fallback]**

### 3j. Yakihonne

No outbox routing for feeds. For individual event lookup:
1. Query all connected relays **[primary]**
2. Fetch author's kind 10002, connect to their relays temporarily (2s delay), fetch event, disconnect **[on-demand]**

### 3k. Notedeck

No outbox routing yet. All relays receive all messages uniformly.

### 3l. Shopstr

All events published to user's own write + general relays + blastr. No per-recipient routing.

---

## 4. The Aggregating Relay Model

Several projects explicitly rely on indexer/aggregator relays that maintain comprehensive copies of metadata events across the network.

### Evidence of Indexer Relay Usage

| Project | Indexer Relays Used | What Is Fetched |
|---------|-------------------|----------------|
| Coracle/Welshman | `purplepag.es, relay.damus.io, indexer.coracle.social` | Kinds 0, 3, 10002, 10050 via `getFilterSelectionsForIndexedKinds()` |
| NDK | `purplepag.es, nos.lol` (dedicated outbox pool) | Kind 10002 (and kind 3 fallback) |
| Amethyst | `purplepag.es, indexer.coracle.social, user.kindpag.es, directory.yabu.me, profiles.nostr1.com` | Kind 10002 during progressive discovery cascade |
| noStrudel | `purplepag.es` (default lookup relay) | Kind 10002 |
| Wisp | `relay.damus.io, relay.primal.net` (bootstrap) | Harvests kind 10002 events for relay frequency analysis |
| Coracle (publish) | `withIndexers()` adds indexer relays when publishing relay list updates | Kind 10002 (own relay list advertisement) |

### purplepag.es as Infrastructure

`purplepag.es` appears as an indexer relay in 6 of the 12 analyzed projects. It functions as a specialized aggregator for NIP-65 relay lists and profile metadata. Its role is critical for bootstrapping: without an aggregator that maintains a comprehensive copy of relay lists, each client would need to discover relay lists through a cascade of general-purpose relays, which is slower and less reliable.

### Bi-Directional Indexer Usage

Some projects not only *read* from indexer relays but also *write* to them:

- **Coracle** publishes relay list updates to indexer relays via `withIndexers()` in `setOutboxPolicies()`
- **Gossip** publishes kind 10002 to any relay matching `is_good_for_advertise()`, which includes DISCOVER relays
- **Amethyst** publishes metadata and relay lists to `followPlusAllMineWithIndex` -- all follow outbox relays plus indexer relays plus own relays

This bi-directional relationship ensures indexer relays stay current, creating a positive feedback loop for the ecosystem.

---

## 5. New User Experience

### 5a. Gossip: Setup Wizard

Gossip provides the most structured onboarding:

1. Setup wizard presents 36 relay suggestions.
2. User must configure:
   - At least 3 OUTBOX relays (where they post)
   - At least 2 INBOX relays (where people can reach them)
   - At least 4 DISCOVERY relays (where relay lists are found)
3. After wizard completion, `start_long_lived_subscriptions()` initializes the RelayPicker and begins discovery.

This ensures new users have explicit relay roles assigned from the start. The downside is that it requires user knowledge about relay topology.

### 5b. Wisp: Automated Relay Probing

Wisp has the most automated new-user experience:

1. Connect to 2 bootstrap relays.
2. Harvest 500 kind 10002 events to learn the relay landscape.
3. Identify "middle tier" relays (not mega-hubs, but reasonably popular).
4. Probe 15 candidates with NIP-11 + write test (kind 20242).
5. Select top 8 by latency.
6. User starts with an optimized, tested relay set without manual configuration.

This is the only project that actively tests relay health and latency before adding relays.

### 5c. Amethyst: Progressive Discovery

Amethyst's onboarding benefits from its 5-relay indexer list and 7-relay event finder fallback. New users who follow accounts will immediately trigger the progressive discovery cascade:

1. For each follow, check indexer relays for kind 10002.
2. If indexer relays fail, try search relays.
3. If search relays fail, try all connected relays.
4. If everything fails, use `eventFinderRelays` as terminal fallback.

This means new users see content even before relay lists are fully discovered, though initially from the event finder relays rather than the optimal outbox set.

### 5d. Coracle: Fallback-Driven

New Coracle users rely on:
1. Default relays (`relay.damus.io`, `nos.lol`) for initial content.
2. Indexer relays for relay list discovery.
3. `addMinimalFallbacks` policy injects 1 default relay when no relays are found for a pubkey.

The experience is functional but potentially sparse for users following accounts on obscure relays, since only 1 fallback relay is added per missing user.

### 5e. NDK-Based Apps

NDK provides outbox "for free" to any consuming application. New users benefit from:
1. Automatic `OutboxTracker` that fetches relay lists for any pubkey in a subscription's `authors` filter.
2. Dedicated outbox pool (`purplepag.es`, `nos.lol`) for metadata discovery.
3. `refreshRelayConnections()` automatically adds newly-discovered relays to active subscriptions.

The consuming application only needs to provide the main relay pool; the outbox infrastructure handles the rest.

### 5f. Existing-User Login on New Device

For existing Nostr users logging into a new client installation:

- **Gossip:** Fetches own relay list from DISCOVER relays, then bootstraps from there.
- **Coracle:** `fetchRelayList()` queries hint relays, known write relays, and indexer relays in parallel.
- **NDK:** Outbox pool queries `purplepag.es` and `nos.lol` for the user's kind 10002.
- **Notedeck:** Priority chain: forced relays > local + advertised > bootstrap. On first login, bootstrap relays are used until kind 10002 is fetched.
- **Amethyst:** Connects to indexer relays to fetch own kind 10002, then connects to all listed relays.
- **Yakihonne:** Connects to constant relays (Yakihonne infrastructure), fetches kind 10002, connects to those relays.

The key difference is between projects that check indexer relays first (fast, requires indexer to be up-to-date) versus projects that use a broader search (slower, more resilient).

---

## 6. Summary: Bootstrap Relay Dependency

The analyzed ecosystem shows a significant dependency on a small number of bootstrap/indexer relays:

1. **relay.damus.io** -- universal bootstrap relay (8/12 projects)
2. **purplepag.es** -- primary indexer relay (6/12 projects)
3. **nos.lol** -- secondary bootstrap (5/12 projects)
4. **relay.primal.net** -- common fallback (5/12 projects)

If `purplepag.es` were to go offline, the relay discovery pipeline for multiple clients would degrade. Most implementations do not have a secondary indexer relay configured by default (Amethyst is the notable exception with 5 indexer relays). This represents a centralization risk in the current outbox ecosystem.
