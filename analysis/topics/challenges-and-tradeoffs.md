# Outbox Model: Challenges and Tradeoffs

A cross-cutting analysis of how Nostr clients handle the practical difficulties of the outbox model, based on code-level review of Gossip, Welshman/Coracle, Amethyst, NDK, Applesauce/noStrudel, Nostur, rust-nostr, Voyage, Wisp, and Nosotros.

---

## 1. Scalability

The outbox model requires a client to know the relay preferences of every pubkey it wants to read from. For a user following hundreds or thousands of accounts, this creates scaling pressure on relay discovery, connection count, and filter fan-out.

### Large follow list thresholds

**Amethyst** has the most explicit scaling threshold. When more than 300 users need relay list discovery, it reduces the number of relays queried per user:

```kotlin
// File: AccountFollowsLoaderSubAssembler.kt (pickRelaysToLoadUsers)
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

In the >300 case, only 2 indexer relays per user are queried (instead of all 5), and only 20 connected relays are probed (instead of up to 100).

**NDK** batches outbox tracker requests in groups of 400 pubkeys:

```typescript
// File: ndk/core/src/outbox/tracker.ts
for (let i = 0; i < items.length; i += 400) {
    const slice = items.slice(i, i + 400);
    // ...
}
```

**Welshman/Coracle** chunks large author lists into groups of ~30 for relay selection:

```typescript
// File: welshman/packages/router/src/index.ts (getFilterSelectionsForAuthors)
const chunkCount = clamp([1, 30], Math.round(filter.authors.length / 30))
return chunks(chunkCount, filter.authors).map(authors => ({
    filter: {...filter, authors},
    scenario: Router.get().FromPubkeys(authors),
}))
```

**Voyage** sets an absolute cap on keys per filter: `MAX_KEYS = 750`.

### Greedy set-cover as a scaling strategy

Several implementations use greedy set-cover algorithms specifically to minimize the number of relay connections needed to reach all followed pubkeys:

- **Gossip** iterates through a scoreboard, picking the relay with the highest aggregate score across all unassigned pubkeys, then assigning those pubkeys and repeating.
- **Applesauce/noStrudel** recalculates coverage at each step, with a hard cap of `maxConnections` (default 20).
- **Wisp** uses a `RelayScoreBoard` with greedy set-cover, capped at `MAX_SCORED_RELAYS = 75`.
- **Amethyst** includes a `RelayListRecommendationProcessor` that runs greedy set-cover to find the minimum relay set covering all follows, though this is used for recommendations rather than live routing.

The tradeoff is consistent across all implementations: greedy set-cover is efficient (O(n * m) where n is users and m is relays) but not globally optimal. It tends to front-load popular relays, which creates centralization pressure (see section 4).

---

## 2. Defunct Relays

Every client must handle relays that are down, misconfigured, or permanently dead. The approaches range from simple binary online/offline tracking to multi-state machines with exponential backoff.

### Welshman: Tiered error thresholds

Welshman tracks the last 10 error timestamps per relay and applies three exclusion tiers:

```typescript
// File: welshman/packages/app/src/relayStats.ts (getRelayQuality)
if (relayStats.recent_errors.filter(n => n > ago(MINUTE)).length > 0) return 0  // any error in last minute
if (relayStats.recent_errors.filter(n => n > ago(HOUR)).length > 3)   return 0  // >3 errors in last hour
if (relayStats.recent_errors.filter(n => n > ago(DAY)).length > 10)   return 0  // >10 errors in last day
```

Quality 0 means the relay is completely excluded from selection -- `0 * log(weight) * random()` produces `-0`, which is falsy and filtered out.

### Gossip: Exclusion timers with per-reason penalties

Gossip assigns penalty durations based on the specific failure mode:

| Exit Reason | Exclusion Duration |
|---|---|
| Connection closed (clean) | 15 seconds |
| Timeout | 1 minute |
| Got disconnected / WS close | 2 minutes |
| Subscriptions completed with failures | 2 minutes |
| Relay rejected us (401/403/404) | 10 minutes |
| DNS lookup failure | 10 minutes |
| HTTP 5xx errors | 10 minutes |

```rust
// File: gossip-lib/src/overlord.rs
pub fn relay_disconnected(&self, url: &RelayUrl, penalty_seconds: i64) {
    if penalty_seconds > 0 {
        let hence = Unixtime::now().0 + penalty_seconds;
        self.excluded_relays.insert(url.to_owned(), hence);
    }
    // Reassign pubkeys that were on this relay
}
```

Critically, when a relay is excluded, Gossip reassigns its pubkeys back into the "needing" pool so the relay picker can cover them through other relays.

### Applesauce/noStrudel: Three-state machine (online / offline / dead)

Applesauce's `RelayLiveness` class implements a formal state machine:

```typescript
// File: applesauce/packages/relay/src/liveness.ts
// online -> offline (on failure) -> dead (after maxFailuresBeforeDead failures)
// offline -> online (on success)
// dead: stays dead (ignored even on success)
// Exponential backoff: baseDelay * 2^(failureCount-1), capped at maxDelay
// Default: base=30s, max=5min, dead after 5 failures
```

The "dead" state is terminal -- a relay that fails 5 times is permanently excluded for the session, even if it comes back online. This is aggressive but prevents wasting connections on flaky relays. noStrudel persists liveness data to `localforage` so relay health survives page reloads, and overrides the base delay down to 5 seconds.

### Amethyst: RelayOfflineTracker

Amethyst maintains a simple binary set of offline relays:

```kotlin
// File: RelayOfflineTracker.kt
// Maintains a cannotConnectRelays set.
// When relay connects -> remove from set
// When connection fails -> add to set
```

This set is subtracted from candidate relays in `pickRelaysToLoadUsers()`. Separately, `BasicRelayClient` implements exponential backoff starting at 500ms, doubling on consecutive failures, resetting after success.

### NDK: Flapping detection

NDK detects system-wide disconnection events:

- If >50% of relays disconnect within 5 seconds, it triggers coordinated reconnection with reset backoff (handles sleep/wake, network changes).
- Individual relays get exponential backoff for repeated disconnections.
- A cache adapter can provide a `dontConnectBefore` timestamp to throttle reconnection to known-bad relays.

### Relay success tracking as a scoring input

Gossip and Voyage both use historical success data to weight relay selection:

- **Gossip** tracks `success_count` and `failure_count` per relay. Success rate feeds into the relay score: `score *= 0.5 + 0.5 * success_rate()`. A relay with zero successes gets score 0.
- **Voyage** uses `EventRelayAuthorView` to rank relays by how many events they have actually delivered, preferring relays that have proven themselves.
- **Nosotros** sorts relay candidates by `stats.events` count, preferring relays that have delivered the most events.

---

## 3. Misconfigured Relay Lists

Users often publish kind 10002 events with problematic entries: localhost addresses, paid filter relays listed as general write relays, NWC-only relays, write-only blast relays listed as read relays, or relays with infinite subdomain tricks.

### Hardcoded blocklists

**Amethyst** maintains an inline blocklist in `OutboxRelayLoader`:

```kotlin
// File: OutboxRelayLoader.kt
if (!it.url.startsWith("wss://feeds.nostr.band") &&
    !it.url.startsWith("wss://filter.nostr.wine") &&
    !it.url.startsWith("wss://nwc.primal.net") &&
    !it.url.startsWith("wss://relay.getalby.com")
) {
    add(it, authorHex)
}
```

**Nostur** takes a more aggressive approach -- if ANY write relay matches a known-bad list, the entire kind 10002 event is discarded:

```swift
// File: OutboxLoader.swift
let DETECT_MISCONFIGURED_KIND10002_HELPER_LIST: Set<String> = [
    "ws://127.0.0.1",
    "ws://localhost",
    "wss://filter.nostr.wine",     // paid
    "wss://welcome.nostr.wine",    // special feed relay
    "wss://nostr.mutinywallet.com", // blastr (write-only)
    "wss://feeds.nostr.band",      // special feeds
    "wss://search.nos.today",
    "wss://relay.getalby.com",     // NWC only
    "sendit.nosflare.com",         // rejects REQs
]
```

Nostur also maintains a `SPECIAL_PURPOSE_RELAYS` set that is excluded from outbox connection selection:

```swift
let SPECIAL_PURPOSE_RELAYS: Set<String> = [
    "wss://nostr.mutinywallet.com",  // blastr
    "wss://filter.nostr.wine",
    "wss://purplepag.es"
]
```

**Gossip** uses URL-pattern-based banning to block infinite-subdomain relay tricks:

```rust
// File: gossip-lib/src/storage/mod.rs
pub fn url_is_banned(url: &RelayUrl) -> bool {
    let s = url.as_str();
    (s.contains("relay.nostr.band") && !s.ends_with("relay.nostr.band/"))
        || (s.contains("filter.nostr.wine") && !s.ends_with("filter.nostr.wine/"))
}
```

This catches cases where users put personalized subdomain relays (e.g., `wss://user123.relay.nostr.band/`) in their kind 10002.

### Protocol-level filtering

**Welshman** filters by URL properties before scoring:

```typescript
// File: welshman/packages/router/src/index.ts
if (!isRelayUrl(relay)) continue
if (!allowOnion && isOnionUrl(relay)) continue
if (!allowLocal && isLocalUrl(relay)) continue
if (!allowInsecure && relay.startsWith("ws://") && !isOnionUrl(relay)) continue
```

By default, onion, local, and insecure (plain ws://) relays are excluded. Welshman also supports a user-maintained blocked relay list (kind 10006) that feeds into quality scoring.

**Nosotros** applies a similar filter chain:

```typescript
// File: selectRelays.ts
.filter((data) => !pool.blacklisted?.has(data.relay))
.filter((data) => !RELAY_SELECTION_IGNORE.includes(data.relay))
.filter((data) => data.relay.startsWith('wss://'))
```

**Amethyst** supports user-defined blocked relay lists stored as encrypted NIP-51 events:

```kotlin
// File: FollowsPerOutboxRelay.kt
val outboxPerRelayMinusBlockedFlow =
    combine(outboxPerRelayFlow, blockedRelayList.flow) { followList, blockedRelays ->
        followList.minus(blockedRelays)
    }
```

### The "discard entire event" vs. "filter individual entries" tradeoff

Nostur's approach (discard the entire kind 10002 if any entry is bad) is aggressive -- it means a user with 4 good relays and 1 bad relay will have their entire relay list ignored. The rationale is that any bad entry signals the user may not understand their relay list, so the whole thing is suspect. All other implementations (Amethyst, Gossip, Welshman) filter individual entries while keeping good ones.

---

## 4. Centralization Pressure

The outbox model's greedy algorithms naturally gravitate toward popular relays. If 60% of users write to `relay.damus.io`, the set-cover algorithm will select it first because it covers the most pubkeys. This creates a "winner take all" dynamic where a few large relays handle most traffic.

### Welshman: Logarithmic dampening

Welshman explicitly addresses this with a logarithmic weight function:

```typescript
// File: welshman/packages/router/src/index.ts (scoreRelay)
// Log the weight, since it's a straight count which ends up over-weighting hubs.
return -(quality * inc(Math.log(weight)) * Math.random())
```

A relay appearing in 100 users' lists only scores ~5.6x higher than a relay appearing in 1 user's list, not 100x. The `Math.random()` multiplier adds stochastic variation, so different queries may hit different relays.

### Nostur: skipTopRelays

Nostur's `createRequestPlan()` has an explicit `skipTopRelays` parameter:

```swift
// File: NostrEssentials Outbox.swift
public func createRequestPlan(
    pubkeys: Set<String>,
    reqFilters: [Filters],
    ourReadRelays: Set<String>,
    preferredRelays: PreferredRelays,
    skipTopRelays: Int = 0  // Default 3 for Following feed
) -> RequestPlan
```

When set to 3 (the default for the Following feed), the algorithm sorts relays by coverage count and skips the top 3 before starting assignment. This forces traffic to smaller relays, at the cost of potentially needing more connections to cover all pubkeys.

### Wisp: Relay probing drops mega-relays

Wisp's relay discovery during onboarding explicitly filters out the most popular relays:

```kotlin
// File: RelayProber.kt
// Filters to "middle tier" (drops top 5 mega-relays, requires frequency >= 3)
```

This means new Wisp users start with mid-tier relays rather than the biggest hubs.

### Gossip: User-assignable relay ranks

Gossip allows users to rank relays 0-9 (default 3), with 0 meaning "do not use." The rank feeds into the relay score:

```rust
// File: gossip-lib/src/storage/types/relay3.rs
score *= self.rank as f32 / 9.0;
```

This gives users direct control over centralization pressure, though most users will not change defaults.

### Amethyst: Proxy relay as an escape valve

Amethyst's proxy relay feature allows users to bypass the outbox model entirely:

```kotlin
// File: AllFollowsByProxyTopNavFilter.kt
// When proxy relays are configured, the outbox model is completely bypassed.
// All follow filters are sent to the proxy relays with the full author list.
```

This is a centralization-by-choice pattern: users who trust a specific relay (e.g., a self-hosted relay with all their follows' events) can opt into centralized access. It also serves privacy needs (see section 7).

### NDK: Preferring connected relays reinforces incumbency

NDK's relay selection prioritizes already-connected relays:

```typescript
// File: ndk/core/src/outbox/index.ts (chooseRelayCombinationForPubkeys)
// Priority 1: Use relays we're already connected to
// Priority 2: Use relays already selected for other authors (connection reuse)
// Priority 3: Use relays sorted by global popularity
```

While efficient (fewer new connections), this means the first relays connected tend to accumulate more authors over time, creating a rich-get-richer effect.

---

## 5. Connection Limits

The outbox model fundamentally requires more relay connections than a static relay list. Each implementation manages this tension differently, with browser-based clients facing stricter constraints than native ones.

### Configured limits across projects

| Implementation | Default Max Connections | Context |
|---|---|---|
| **Gossip** | 50 (`max_relays`) | Native (Rust). Per-person target: 2 relays. |
| **noStrudel/Applesauce** | 20 (`maxConnections`), adjustable 0-30 | Browser. Per-user target: 5 relays. |
| **Nostur** | 50 (`maxPreferredRelays`) | iOS native. Separate pools for outbox (50), ephemeral (35s timeout), user relays. |
| **Wisp** | 75 (`MAX_SCORED_RELAYS`) | Android native. |
| **Voyage** | 25 (`MAX_AUTOPILOT_RELAYS`) | Android native. Per-pubkey: 2 for publishing. |
| **Welshman/Coracle** | 3 per routing scenario (user-configurable) | Browser. No global pool cap. 30 for PublishEvent. |
| **NDK** | No hard cap | Browser/Node. Temporary relays auto-disconnect after 30s. |
| **Nosotros** | 3 per user (configurable 1-14) | Browser. Max 4 hint relays per subscription. |

### Browser vs. native constraints

Browser-based clients (Welshman/Coracle, NDK, noStrudel, Nosotros, Shopstr) face practical WebSocket limits. While there is no formal browser spec limiting WebSocket connections, most browsers limit per-domain connections, and total open connections affect memory and CPU. noStrudel's default of 20 max connections reflects this constraint.

Native clients (Gossip, Amethyst, Nostur, Voyage, Wisp) can afford more connections. Gossip's 50 and Wisp's 75 are feasible because each connection is an async task, not a browser resource.

### Connection lifecycle strategies

**Welshman** uses lazy connect-on-send with 30-second inactivity auto-close:

```typescript
// File: welshman/packages/net/src/policy.ts
// socketPolicyConnectOnSend: Opens WebSocket only when sending
// socketPolicyCloseInactive: Closes after 30s with no pending requests
```

**NDK** uses temporary relays for outbox-discovered connections:

```typescript
// File: ndk/core/src/relay/pool/index.ts
// useTemporaryRelay(relay, removeIfUnusedAfter=30000)
// Auto-disconnect after 30 seconds of non-use
```

**Nostur** maintains three separate pools with different lifecycles:

- `connections`: persistent (user-configured relays)
- `outboxConnections`: 10-minute idle cleanup
- `ephemeralConnections`: 35-second auto-removal

**Amethyst** dynamically resizes its relay pool every 300ms based on the union of active subscription needs:

```kotlin
// File: NostrClient.kt
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

---

## 6. Relay Migration

When a user changes their kind 10002 relay list, clients following that user need to discover and act on the change. This is complicated by the fact that relay lists are themselves stored on relays.

### Discovery of updated relay lists

**Gossip** re-fetches relay lists after a configurable staleness period:

```rust
// File: gossip-lib/src/storage/mod.rs
def_setting!(relay_list_becomes_stale_minutes, b"relay_list_becomes_stale_minutes", u64, 20);
```

Every 20 minutes, Gossip checks which followed pubkeys have stale relay lists and re-queries DISCOVER relays.

**NDK** uses a 2-minute TTL in its LRU cache:

```typescript
// File: ndk/core/src/outbox/tracker.ts
this.data = new LRUCache({
    maxSize: 100000,
    entryExpirationTimeInMS: 2 * 60 * 1000, // 2 minute TTL
});
```

When a relay list is updated, NDK emits a `user:relay-list-updated` event that triggers `refreshRelayConnections()` on all active subscriptions involving that pubkey:

```typescript
this.outboxTracker.on("user:relay-list-updated", (pubkey, _outboxItem) => {
    for (const subscription of this.subManager.subscriptions.values()) {
        if (subscription.filters.some((filter) => filter.authors?.includes(pubkey))) {
            subscription.refreshRelayConnections();
        }
    }
});
```

**Amethyst** uses a reactive flow pipeline -- it observes the addressable note at `10002:<pubkey>:` for each followed user, and whenever the note is updated (new kind 10002 event received), the entire relay-to-author map is recomputed automatically:

```kotlin
// File: OutboxRelayLoader.kt (toAuthorsPerRelayFlow)
return combine(noteMetadataFlows) { outboxRelays ->
    transformation(authorsPerRelay(outboxRelays, cache))
}
```

**Applesauce/noStrudel** achieves the same reactivity through RxJS: the `includeMailboxes` operator subscribes to kind 10002 events per pubkey via `EventStore`, and re-emits whenever the underlying event changes.

### The bootstrap paradox

When a user migrates to entirely new relays, their old relays may no longer have their updated kind 10002 event. Clients must discover the new list from somewhere:

- **Indexer relays** (purplepag.es, indexer.coracle.social, user.kindpag.es) serve as centralized discovery points. NDK defaults to `["wss://purplepag.es/", "wss://nos.lol/"]` for its outbox pool.
- **Welshman/Coracle** sends relay list queries to three sources in parallel: relay hints, known write relays, and indexer relays.
- **Gossip** uses dedicated DISCOVER relays. If a relay list is not found within 15 seconds, it falls back to the user's own READ relays.
- **Amethyst** has a five-tier progressive search for relay lists (see section 1).

The tradeoff: indexer relays provide reliable discovery but become single points of failure and centralization points themselves. Gossip deliberately avoids hardcoded fallback relays at runtime -- if relay discovery fails, the user may not see that person's events.

---

## 7. Privacy Considerations

The outbox model has inherent privacy implications: connecting to a followed user's declared relays reveals to those relays that you are interested in that user.

### Nostur: VPN detection gate

Nostur gates outbox connections behind a VPN check:

```swift
// File: ConnectionPool.swift
guard SettingsStore.shared.enableOutboxRelays, vpnGuardOK() else { return }
```

If VPN detection is enabled and no VPN is detected, outbox connections are silently skipped. This prevents IP address leakage to potentially untrusted relays.

### Amethyst: Tor support with granular routing

Amethyst has per-category Tor routing controls:

```kotlin
// File: TorSettings.kt
// onionRelaysViaTor, dmRelaysViaTor, newRelaysViaTor, trustedRelaysViaTor
// Media, NIP-05, wallet operations can each independently route through Tor
// Presets: "Only When Needed", "Default", "Small Payloads", "Full Privacy"
```

### Proxy relays as privacy shields

Amethyst's proxy relay feature doubles as a privacy mechanism. By routing all requests through a single trusted relay, the client avoids revealing its interest graph to dozens of individual relays:

```kotlin
// File: FollowsPerOutboxRelay.kt
if (proxyRelays.isEmpty()) {
    outboxPerRelayMinusBlockedFlow   // normal outbox model
} else {
    kind3Follows.flow.map { follows ->
        proxyRelays.associateWith { follows.authors }  // all authors to proxy
    }
}
```

The tradeoff is clear: the proxy relay sees everything, but no other relay learns the user's follow list.

### Welshman: Onion and insecure filtering

Welshman defaults to excluding onion and insecure relays:

```typescript
if (!allowOnion && isOnionUrl(relay)) continue
if (!allowInsecure && relay.startsWith("ws://") && !isOnionUrl(relay)) continue
```

This is a privacy consideration in reverse -- preventing connections to Tor-only relays that might be unreachable or unintended, and preventing cleartext WebSocket connections that leak data to network observers.

### Relay hints as a tracking vector

When clients embed relay hints in `nprofile`, `nevent`, or `naddr` references, they inadvertently create metadata that can be used to correlate user behavior. Nostur resolves relay hints using a priority cascade that excludes localhost, non-wss, and auth-required relays. Nosotros caps hint-derived connections at 4 per subscription.

---

## 8. Resource Cost

The outbox model consumes more battery, bandwidth, memory, and CPU than a static relay approach. Each implementation makes different tradeoffs in managing these costs.

### Memory

**Amethyst** uses bloom filters for relay hint storage, which is memory-efficient but probabilistic:

```kotlin
// File: HintIndexer.kt
private val eventHints = BloomFilterMurMur3(40_000_000, 10)    // ~5MB for events
private val addressHints = BloomFilterMurMur3(7_000_000, 10)   // ~875KB for addresses
private val pubKeyHints = BloomFilterMurMur3(30_000_000, 10)   // ~3.75MB for keys
```

Total: ~9.6MB for the bloom filters alone, plus the `relayDB` LRU cache and `UserRelaysCache` per-user frequency maps. Amethyst keeps all relay association data in memory (no SQL database for person-relay tracking).

**Gossip** uses LMDB (memory-mapped files) for its `PersonRelay` table, which avoids heap allocation for the working set but requires disk space and maps into virtual memory.

**NDK** uses an LRU cache capped at 100,000 entries with 2-minute TTL for outbox data.

**Wisp** uses an LRU cache of 500 entries for relay lists, backed by SharedPreferences.

**noStrudel** caches up to 30 outbox maps (relay-to-users mappings) in an LRU.

### Bandwidth

The outbox model increases bandwidth in two ways: (1) fetching kind 10002 events for all follows, and (2) maintaining more simultaneous WebSocket connections (each with its own ping/pong overhead).

**Welshman** sends WebSocket PINGs every 30 seconds on each connection. With 20 active connections, this is 40 pings/minute of overhead. The `socketPolicyCloseInactive` policy mitigates this by closing idle connections after 30 seconds.

**Gossip** fetches relay lists for all follows on startup, with a 20-minute staleness timer for re-fetching. The relay list subscription filter is:

```rust
Filter {
    authors: pubkeys.to_vec(),
    kinds: vec![EventKind::RelayList, EventKind::DmRelayList],
    ..Default::default()
}
```

For 500 follows, this is a single filter with 500 authors sent to DISCOVER relays.

**rust-nostr** supports negentropy-based sync for relay list updates, which is bandwidth-efficient for incremental changes. Welshman/Coracle also support NIP-77 negentropy when the relay supports it.

### Battery (mobile)

**Nostur** provides a "low data mode" that disables outbox routing entirely. This is the most direct battery optimization.

**Amethyst** samples the relay pool update at 300ms intervals to avoid constant recalculation:

```kotlin
}.sample(300).onEach {
    relayPool.updatePool(it)
}
```

**noStrudel** applies a 500ms debounce before running relay selection after relay data changes:

```typescript
debounceTime(500),  // Wait 500ms for relay data to stabilize
```

### CPU

The greedy set-cover algorithms in Applesauce, Gossip, Wisp, and Amethyst all have O(n * m) complexity per recomputation, where n is the number of followed users and m is the number of candidate relays. For large follow lists (1000+ users), this can be significant. noStrudel's debouncing helps by avoiding repeated recomputation as kind 10002 events trickle in.

**Gossip's** composite scoring involves floating-point arithmetic with exponential decay calculations per person-relay pair:

```rust
score += exponential_decay(0.2, 60*60*24*14, elapsed);  // 14-day halflife
score += exponential_decay(0.1, 60*60*24*7, elapsed);   // 7-day halflife
```

This runs for every person-relay pair in the system during relay picker initialization.

### The fundamental cost tradeoff

The outbox model exchanges resource cost for censorship resistance and data availability. Every implementation accepts this tradeoff but lets users modulate it:

- **Nostur**: Outbox is off by default ("Autopilot" opt-in). Low data mode disables it entirely.
- **noStrudel**: Max connections slider (0-30) lets users dial down resource usage.
- **Gossip**: `max_relays` (default 50) and `num_relays_per_person` (default 2) are user-configurable.
- **Amethyst**: Proxy relay bypasses outbox entirely. >300 follow threshold automatically reduces resource usage.
- **Welshman/Coracle**: `relay_limit` is user-configurable; default is 3 per routing scenario.

Implementations that do not implement the outbox model at all (Shopstr, Yakihonne for feeds, Notedeck currently) avoid these costs entirely but sacrifice the ability to find events from users who post to non-mainstream relays.
