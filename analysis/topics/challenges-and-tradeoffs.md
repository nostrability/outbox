# Outbox Model: Challenges and Tradeoffs

## Key Findings

- **Scalability**: Amethyst triggers load shedding at >300 follows. NDK batches in 400s, Voyage caps at 750 keys/filter. Greedy set-cover is used by Gossip, noStrudel, Wisp, and Amethyst to minimize connections.
- **Defunct relays**: Approaches range from simple offline sets (Amethyst) to three-state machines with terminal "dead" state (Applesauce). Gossip reassigns pubkeys when relays are excluded.
- **Misconfigured lists**: Nostur discards the entire kind 10002 if any entry matches a known-bad list. All others filter individual entries.
- **Centralization**: Three anti-centralization techniques: Welshman's log dampening, Nostur's skipTopRelays (skips top 3), Wisp's mega-relay filtering during onboarding.
- **Connection limits**: Range from 20 (noStrudel, browser) to 75 (Wisp, native). NDK has no hard cap but auto-disconnects temporary relays after 30s.
- **Relay migration**: NDK re-checks every 2 min, Gossip every 20 min. Indexer relays are the primary solution for the bootstrap paradox.
- **Privacy**: Nostur gates outbox behind VPN detection. Amethyst has granular Tor routing with 4 presets. Proxy relays hide interest graph at cost of trusting one relay.
- **Resource cost**: Amethyst uses ~9.6MB for bloom filter hint storage. Nostur offers "low data mode" disabling outbox entirely.

---

## 1. Scalability

### Large Follow List Thresholds

| Project | Threshold / Strategy | Detail |
|---------|---------------------|--------|
| Amethyst | >300 follows: load shedding | Reduces to 2 indexer relays/user (from 5) and 20 connected relays (from 100) |
| NDK | Batch 400 pubkeys | Outbox tracker requests chunked in groups of 400 |
| Welshman/Coracle | Chunk ~30 authors | Author lists split into groups of ~30 for relay selection |
| Voyage | MAX_KEYS = 750 | Absolute cap on keys per filter |

### Greedy Set-Cover

Used by Gossip, noStrudel, Wisp, and Amethyst to minimize relay connections needed to reach all follows:
- **Gossip**: Picks relay with highest aggregate score across unassigned pubkeys, assigns, repeats
- **noStrudel**: Recalculates coverage each step, hard cap of `maxConnections` (default 20)
- **Wisp**: `RelayScoreBoard` with set-cover, capped at `MAX_SCORED_RELAYS = 75`
- **Amethyst**: `RelayListRecommendationProcessor` runs set-cover for relay recommendations

All implementations share the same tradeoff: O(n * m) efficiency but front-loads popular relays, creating centralization pressure.

---

## 2. Defunct Relays

| Project | Approach | Key Detail |
|---------|----------|------------|
| **Welshman** | Tiered error thresholds | Quality = 0 (excluded) if: any error in last minute, >3 in last hour, or >10 in last day |
| **Gossip** | Per-reason exclusion timers | 15s (clean close) to 10min (rejected/DNS fail/5xx). Reassigns pubkeys to other relays on exclusion |
| **Applesauce/noStrudel** | Three-state machine: online -> offline -> dead | Dead after 5 failures (terminal, permanent for session). Exponential backoff: base 30s, max 5min. noStrudel overrides base to 5s, persists to localforage |
| **Amethyst** | Binary offline set + exponential backoff | `cannotConnectRelays` set subtracted from candidates. Backoff starts at 500ms, doubles on failure |
| **NDK** | Flapping detection | >50% disconnect in 5s triggers coordinated reconnect. Per-relay exponential backoff. Cache adapter can set `dontConnectBefore` |

### Relay Success Tracking

- **Gossip**: `success_count`/`failure_count` per relay; `score *= 0.5 + 0.5 * success_rate()`. Zero successes = score 0.
- **Voyage**: `EventRelayAuthorView` ranks relays by actual events delivered
- **Nosotros**: Sorts candidates by `stats.events` count

---

## 3. Misconfigured Relay Lists

Common problems: localhost addresses, paid filter relays as general writes, NWC-only relays, blast relays as reads, infinite-subdomain tricks.

### Blocklist Approaches

| Project | Strategy | Blocked Relays |
|---------|----------|---------------|
| **Amethyst** | Filter individual entries (`OutboxRelayLoader.kt`) | `feeds.nostr.band`, `filter.nostr.wine`, `nwc.primal.net`, `relay.getalby.com` |
| **Nostur** | Discard entire kind 10002 if ANY entry matches (`OutboxLoader.swift`) | `127.0.0.1`, `localhost`, `filter.nostr.wine`, `welcome.nostr.wine`, `nostr.mutinywallet.com`, `feeds.nostr.band`, `search.nos.today`, `relay.getalby.com`, `sendit.nosflare.com` |
| **Gossip** | URL-pattern banning (`storage/mod.rs`) | Infinite-subdomain variants of `relay.nostr.band` and `filter.nostr.wine` |

### Protocol-Level Filtering

- **Welshman**: Excludes onion, local, and insecure (`ws://`) relays by default. Supports user-maintained blocked relay list (kind 10006).
- **Nosotros**: Filters blacklisted relays, ignored relays, and non-`wss://` relays
- **Amethyst**: User-defined blocked relay lists stored as encrypted NIP-51 events

### Discard-Entire-Event vs. Filter-Individual-Entries

Nostur's approach (discard the whole kind 10002 if any entry is bad) means a user with 4 good relays and 1 bad relay loses their entire relay list. Rationale: any bad entry signals the user may not understand their relay config. All other implementations filter individual entries while keeping good ones.

---

## 4. Centralization Pressure

Greedy set-cover naturally gravitates toward popular relays. If 60% of users write to `relay.damus.io`, the algorithm selects it first, creating winner-take-all dynamics.

### Anti-Centralization Approaches

| Project | Technique | How It Works |
|---------|-----------|-------------|
| **Welshman** | Logarithmic dampening | `quality * log(weight) * random()` -- relay in 100 users' lists scores ~5.6x (not 100x) vs. 1 user. Random multiplier varies per query. |
| **Nostur** | `skipTopRelays` (default 3) | Sorts relays by coverage count, skips the top 3 before starting assignment. Forces traffic to smaller relays at cost of more connections. |
| **Wisp** | Mega-relay filtering | Onboarding drops top 5 most popular relays, requires frequency >= 3. New users start with mid-tier relays. |
| **Gossip** | User-assignable relay ranks (0-9) | Rank feeds into score: `score *= rank / 9.0`. Default 3; rank 0 means "do not use." |

### Other Centralization Dynamics

- **Amethyst**: Proxy relay feature bypasses outbox entirely, routing all requests through a single trusted relay. Centralization-by-choice for users who trust a specific relay.
- **NDK**: Prioritizes already-connected relays, creating a rich-get-richer effect where first-connected relays accumulate more authors over time.

---

## 5. Connection Limits

| Implementation | Default Max | Context |
|---|---|---|
| **Gossip** | 50 (`max_relays`) | Native (Rust). 2 relays per person. |
| **noStrudel/Applesauce** | 20 (`maxConnections`), adjustable 0-30 | Browser. 5 relays per user. |
| **Nostur** | 50 (`maxPreferredRelays`) | iOS. Separate pools: outbox (50), ephemeral (35s timeout), user relays. |
| **Wisp** | 75 (`MAX_SCORED_RELAYS`) | Android native. |
| **Voyage** | 25 (`MAX_AUTOPILOT_RELAYS`) | Android native. 2 per pubkey for publishing. |
| **Welshman/Coracle** | 3 per routing scenario (user-configurable) | Browser. No global pool cap. 30 for PublishEvent. |
| **NDK** | No hard cap | Browser/Node. Temporary relays auto-disconnect after 30s. |
| **Nosotros** | 3 per user (configurable 1-14) | Browser. Max 4 hint relays per subscription. |

Browser clients face practical WebSocket limits on memory and CPU. Native clients can afford more connections since each is an async task.

### Connection Lifecycle Strategies

- **Welshman**: Lazy connect-on-send, 30s inactivity auto-close
- **NDK**: Temporary relays auto-disconnect after 30s of non-use
- **Nostur**: Three pools -- persistent (user relays), 10-minute idle cleanup (outbox), 35s auto-removal (ephemeral)
- **Amethyst**: Dynamically resizes relay pool every 300ms based on union of active subscription needs

---

## 6. Relay Migration

When a user changes their kind 10002, clients following them must discover and act on the change.

### Discovery of Updated Lists

| Project | Refresh Interval | Mechanism |
|---------|-----------------|-----------|
| Gossip | 20 min (configurable) | Re-queries DISCOVER relays for stale follows |
| NDK | 2 min LRU TTL | Emits `user:relay-list-updated`, triggers `refreshRelayConnections()` on affected subs |
| Amethyst | Reactive | Observes addressable note `10002:<pubkey>:`, recomputes relay-author map on change |
| Applesauce/noStrudel | Reactive (RxJS) | `includeMailboxes` operator subscribes to kind 10002 per pubkey, re-emits on change |

### The Bootstrap Paradox

When a user migrates to entirely new relays, old relays may not have the updated kind 10002. Solutions:
- **Indexer relays** (purplepag.es, indexer.coracle.social, user.kindpag.es) as centralized discovery points
- **Coracle** queries hint relays + known writes + indexers in parallel
- **Gossip** uses DISCOVER relays; falls back to own READ relays after 15s
- **Amethyst** has a five-tier progressive search

Tradeoff: indexer relays provide reliable discovery but become single points of failure. Gossip deliberately avoids hardcoded fallbacks -- if discovery fails, the user may not see that person's events.

---

## 7. Privacy

### Per-Project Privacy Mechanisms

| Project | Mechanism | Detail |
|---------|-----------|--------|
| **Nostur** | VPN detection gate | Outbox connections silently skipped if VPN detection enabled and no VPN detected. Prevents IP leakage to untrusted relays. |
| **Amethyst** | Granular Tor routing | Per-category controls: onion relays, DMs, new relays, trusted relays, media, NIP-05, wallet. Presets: "Only When Needed", "Default", "Small Payloads", "Full Privacy". |
| **Amethyst** | Proxy relay | Routes all requests through single trusted relay. Proxy sees everything, but no other relay learns the follow list. |
| **Welshman** | Onion/insecure filtering | Excludes Tor-only and cleartext `ws://` relays by default. |

Relay hints in `nprofile`/`nevent`/`naddr` references create metadata for behavior correlation. Nostur excludes localhost/non-wss/auth-required relays from hint resolution. Nosotros caps hint connections at 4 per subscription.

---

## 8. Resource Cost

### Memory

| Project | Storage | Size/Detail |
|---------|---------|-------------|
| Amethyst | Bloom filters for relay hints | ~9.6MB total (events 5MB, addresses 875KB, pubkeys 3.75MB) + LRU cache + per-user frequency maps. All in-memory. |
| Gossip | LMDB (memory-mapped) | PersonRelay table avoids heap allocation, requires disk space |
| NDK | LRU cache | 100,000 entries, 2-min TTL |
| Wisp | LRU cache + SharedPreferences | 500 entries |
| noStrudel | LRU cache | 30 outbox maps |

### Bandwidth

- Outbox increases bandwidth via kind 10002 fetches for all follows + more WebSocket connections (each with ping/pong overhead)
- Welshman: PINGs every 30s per connection; `socketPolicyCloseInactive` closes idle after 30s
- Gossip: Single filter with all follow pubkeys sent to DISCOVER relays, re-fetched every 20min
- rust-nostr and Welshman/Coracle support negentropy-based sync (NIP-77) for bandwidth-efficient incremental updates

### Battery (Mobile)

- **Nostur**: "Low data mode" disables outbox entirely
- **Amethyst**: Samples relay pool updates at 300ms intervals
- **noStrudel**: 500ms debounce before relay selection after data changes

### User Controls

| Project | Control |
|---------|---------|
| Nostur | Outbox off by default ("Autopilot" opt-in). Low data mode disables entirely. |
| noStrudel | Max connections slider (0-30) |
| Gossip | `max_relays` (default 50) and `num_relays_per_person` (default 2), user-configurable |
| Amethyst | Proxy relay bypasses outbox. >300 follow threshold auto-reduces resource usage. |
| Welshman/Coracle | `relay_limit` user-configurable; default 3 per routing scenario |

Projects without outbox (Shopstr, Yakihonne feeds, Notedeck) avoid these costs but cannot find events from users on non-mainstream relays.
