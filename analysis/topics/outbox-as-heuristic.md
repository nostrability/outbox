# Outbox as One Heuristic Among Many

## Unsolved Problems

### Events with t-tags (Hashtags)
No analyzed implementation routes hashtag-filtered subscriptions (`{"#t": ["nostr"]}`) beyond the user's own read relays. When a filter has `#t` but no `authors`, outbox provides no guidance -- there is no pubkey to look up. A missing "hashtag relay" discovery mechanism means queries only reach relays the user already knows about.

### Events with g-tags (Geohash/Location)
Same problem as hashtags -- no pubkey-based routing, no relay-level geohash specialization. Amethyst includes `geotags` in subscription filters but routes them through the follow feed relay set.

### Relay Capability Discovery
Most implementations hardcode relay roles (search, indexer) rather than discovering them. Partial exceptions:
- Welshman/app checks `relay.supported_nips?.includes?.("50")` from NIP-11
- Wisp's RelayProber probes via NIP-11 fetch + ephemeral write test during onboarding

No standard mechanism exists for relays to advertise coverage, specialization, or capabilities beyond NIP-11's `supported_nips` array.

### Cross-Heuristic Conflict Resolution
When heuristics disagree, implementations use ad hoc priority rules:
- **Gossip:** declared relays (score >= 1.0) always beat undeclared
- **Welshman:** weight multiplication with logarithmic compression
- **rust-nostr:** separate per-flag limits, then union
- **Amethyst:** fixed priority cascade in `OutboxRelayLoader`

No formal framework exists for weighting conflicting signals (e.g., declared relay dead for a month vs. undeclared relay consistently delivering events). Gossip's exponential decay is the most principled approach.

### Replaceable vs. Regular Events
All implementations treat relay selection identically regardless of event replaceability. For replaceable events (kind 0, 3, 10002), a single copy from any relay suffices, so fewer relays could be queried. Only Welshman routes "indexed kinds" to indexer relays as a special case.

---

## Heuristics Taxonomy

| Heuristic | Purpose | Implemented By | Not Implemented |
|-----------|---------|---------------|-----------------|
| **Outbox** (NIP-65 write relays) | Find events by querying author's declared write relays | Gossip, Welshman, NDK, Applesauce, noStrudel, Amethyst, Nostur, rust-nostr, Voyage, Nosotros, Wisp | Yakihonne (own account only), Notedeck (parsed but no routing), Shopstr (own config only) |
| **Inbox** (NIP-65 read relays) | Deliver events to a pubkey's declared read relays; fetch notifications/mentions | Gossip, Welshman, NDK, Applesauce, Amethyst, Nostur, rust-nostr, Voyage, Nosotros, Wisp | -- |
| **DM Inbox** (kind 10050 / NIP-17) | Route gift wraps to DM-designated relays | Gossip, Welshman, Amethyst, Nostur, rust-nostr | NDK, Applesauce/noStrudel, Voyage, Nosotros, Wisp, Shopstr |
| **Relay Hints** (event tags) | Use relay URLs from `e`/`p`/`a`/`q` tags and NIP-19 entities | Gossip, Welshman, NDK, Amethyst, Nostur, rust-nostr, Nosotros, Wisp | Voyage, Shopstr, Yakihonne, Notedeck |
| **Search Relays** (NIP-50) | Route full-text search to NIP-50 relays | Welshman, Amethyst, Gossip | -- |
| **Indexer Relays** | Query relays aggregating metadata (kinds 0, 3, 10002, 10050) | Welshman, NDK, Amethyst, noStrudel, Wisp (via bootstrap) | -- |
| **Discovery Relays** | Fetch relay lists for followed pubkeys | Gossip (dedicated DISCOVER role), Amethyst (progressive cascade) | -- |
| **Community/Group Relays** | Route NIP-72 community or NIP-29 group events to designated relays | Amethyst | Underrepresented across all codebases |
| **Event Delivery Tracking** | Track which relays historically delivered events per pubkey | Gossip, Amethyst, rust-nostr, Voyage, Nosotros | -- |
| **Zap Receipt Routing** | Route zap receipts to relay in zap request | No explicit implementation; handled by general relay hints | -- |

---

## How Implementations Combine Heuristics

### Welshman's Scenario Composition
Each scenario method returns weighted `Selection[]` arrays. Multiple scenarios merge via `this.merge(scenarios)`, summing weights per relay. Scoring: `quality * log(weight) * random()` compresses hub bias and adds stochastic variation.

Scenario compositions by context:
- **Feed:** `FromPubkeys(authors)` + `ForUser()` at 0.2 weight
- **Thread:** `FromPubkeys(replyAuthors).weight(10)` + `FromPubkeys(mentioned)` + `FromRelays(tagHints)`
- **Publishing:** Author write + tagged users' read (0.5 weight), limit 30
- **Notifications:** `ForUser().policy(addMaximalFallbacks)`
- **DMs:** `MessagesForUser()` -- kind 10050 relays
- **Metadata:** `Index()` -- indexer relays

Fallback policies (`addNoFallbacks`, `addMinimalFallbacks`, `addMaximalFallbacks`) add another composition dimension.

### Gossip's Relay Usage Flags (Bitmask Roles)
Relays have bitmask flags: OUTBOX, INBOX, DISCOVER, DM, READ, WRITE, GLOBAL, SEARCH, SPAMSAFE. A single relay can have multiple roles. `choose_relay_urls(usage, filter)` selects by bitmask. Operations compose roles:
- **Startup:** DISCOVER for relay lists, READ for inbox, DM+INBOX for giftwraps
- **RelayPicker:** OUTBOX-flagged relays composed with health scores
- **Publishing:** WRITE + tagged users' INBOX + DM for NIP-17

### rust-nostr's Bitflags Per Pubkey-Relay Pair
Bitflags at the person-relay level: READ (1), WRITE (2), PRIVATE_MESSAGE (4), HINT (8), RECEIVED (16). `break_down_filter()` composes by filter structure:
- `authors` only: WRITE + HINT + most-RECEIVED (outbox)
- `#p` only: READ + HINT + most-RECEIVED (inbox)
- Both: union of ALL relay types
- Neither: client's configured READ relays

Per-flag limits: write 3, read 3, hint 1, most-used 1, nip17 3.

### Amethyst's Relay List Types

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

The proxy relay system is notable: when configured, it completely replaces outbox routing, sending all filters through a single trusted relay. Explicit fallback for privacy-focused (especially Tor) users who cannot tolerate relay fan-out.

---

## "Skip Top N" Anti-Centralization

- **Nostur:** `skipTopRelays` (default 3) skips the top N relays by coverage count in `createRequestPlan()`, forcing load distribution away from mega-hubs like relay.damus.io.
- **Wisp:** `RelayProber` drops the top 5 mega-relays during onboarding, filtering to "middle tier" relays (frequency >= 3 but not top 5).
- **Amethyst:** Blocklist approach -- `feeds.nostr.band`, `filter.nostr.wine`, `nwc.primal.net`, `relay.getalby.com` unconditionally excluded from outbox selection as known aggregators/special-purpose relays.
