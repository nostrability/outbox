# Bootstrapping and Fallback Strategies

## Key Findings

- **relay.damus.io** is the most common bootstrap relay (8/12 projects)
- **purplepag.es** is the primary indexer relay (6/12 projects)
- **nos.lol** and **relay.primal.net** are secondary bootstraps (5/12 each)
- If purplepag.es went offline, relay discovery for multiple clients would degrade. Amethyst is the only project with 5 indexer relays; most have 1-2.
- Wisp is the only project that actively probes relay health and latency during discovery
- Gossip has no hardcoded fallback relays at runtime -- entirely data-driven after setup

## Common Relays Across Projects

| Relay | Appears In |
|-------|-----------|
| `wss://relay.damus.io` | Gossip, Coracle, noStrudel, Amethyst, Wisp, Shopstr, Yakihonne, Notedeck |
| `wss://nos.lol` | Gossip, Coracle, NDK, Shopstr, Notedeck |
| `wss://purplepag.es` | Coracle, NDK, Amethyst, noStrudel, Shopstr, Notedeck |
| `wss://relay.primal.net` | Gossip, noStrudel, Amethyst, Wisp, Shopstr |
| `wss://nostr.wine` | Amethyst, Notedeck, Coracle (search) |

---

## 1. Bootstrap Relay Lists

| Project | Bootstrap / Default Relays | Indexer Relays | Notes |
|---------|---------------------------|----------------|-------|
| **Gossip** | 36 relays in setup wizard (`gossip-bin/src/ui/wizard/setup_relays.rs`) | None hardcoded | No runtime fallbacks; entirely data-driven after wizard |
| **Coracle** | `relay.damus.io`, `nos.lol` (`.env.template`) | `relay.damus.io`, `purplepag.es`, `indexer.coracle.social` | Also has separate search and signer relay lists |
| **NDK** | Configured by consuming app (`core/src/ndk/index.ts`) | `purplepag.es`, `nos.lol` (dedicated outbox pool) | Outbox pool used only for kind 10002 fetching |
| **noStrudel** | `relay.primal.net`, `relay.damus.io` (`src/const.ts`) | `purplepag.es` | Minimal: 1 lookup + 2 fallback relays |
| **Amethyst** | 7 event finder relays + 7 bootstrap inbox relays (`AccountSettings.kt`) | `purplepag.es`, `indexer.coracle.social`, `user.kindpag.es`, `directory.yabu.me`, `profiles.nostr1.com` | Largest and most differentiated relay sets |
| **Nostur** | User-configured during setup (`OutboxLoader.swift`) | None hardcoded | Excludes special-purpose relays from outbox selection |
| **rust-nostr** | None; consuming app supplies all relays | None hardcoded | SDK framework only |
| **Voyage** | None explicit | None hardcoded | Falls back to READ relays for uncovered pubkeys |
| **Wisp** | `relay.damus.io`, `relay.primal.net` (`RelayProber.kt`) | None hardcoded | Used only during onboarding probe phase |
| **Nosotros** | Via `FALLBACK_RELAYS` env var | None hardcoded | Used for authors without known relay lists |
| **Shopstr** | `relay.damus.io`, `nos.lol`, `purplepag.es`, `relay.primal.net`, `relay.nostr.band` | None | Also adds `sendit.nosflare.com` (blastr) to all writes |
| **Yakihonne** | 4 Yakihonne/Dorafactory relays + `relay.damus.io` | None | Constant relays cannot be removed by user; most centralized |
| **Notedeck** | `relay.damus.io`, `nos.lol`, `nostr.wine`, `purplepag.es` | None | Used when no local or advertised relays available |

---

## 2. Relay Discovery Pipeline

| Project | Discovery Sequence |
|---------|--------------------|
| **Gossip** | Init RelayPicker with PersonRelay scores -> greedy set-cover selects relays -> subscribe to config on WRITE, inbox on READ, giftwraps on DM+INBOX -> batch-fetch relay lists for stale follows (default 20min staleness) |
| **Coracle** | Load NIP-11 for all initial relays -> fetch kind 10002 via hint relays + known writes + indexers in parallel -> route indexed kinds (0, 3, 10002, 10050) to indexers -> `loadUsingOutbox()` tries relays in chunks of 2, stops on success |
| **NDK** | Outbox pool created (`purplepag.es`, `nos.lol`) -> subscriptions with `authors` trigger `trackUsers()` -> relay lists fetched in batches of 400 -> kind 10002 priority, kind 3 fallback -> `refreshRelayConnections()` on active subs |
| **Amethyst** | Progressive cascade per follow: known outbox relays -> bloom filter hints -> indexers (5) -> home relays -> search relays -> connected relays -> shared outbox relays. >300 follows triggers load shedding (2 indexers, 20 connected max) |
| **Wisp** | Connect to 2 bootstrap relays -> harvest 500 kind 10002 events -> tally relay frequency -> drop top 5 mega-relays, require freq >= 3 -> probe 15 candidates (NIP-11 + write test kind 20242) -> select top 8 by latency |

### Ongoing Discovery

| Project | Staleness Check | Mechanism |
|---------|-----------------|-----------|
| Gossip | 20 minutes (configurable) | `person_needs_relay_list()` checks `relay_list_last_sought` |
| NDK | 2 minutes (LRU TTL) | `OutboxTracker.data` cache expiration |
| Amethyst | Reactive | `StateFlow` on addressable notes; recomputes when kind 10002 changes |
| Voyage | Lazy on-demand | `lazySubNip65s()` identifies friends with missing NIP-65 |
| rust-nostr | TTL-based | `ensure_gossip_public_keys_fresh()` checks Missing/Outdated/Updated status |

---

## 3. Fallback Chains

| Project | Fallback Chain (in order) |
|---------|--------------------------|
| **Gossip** | Kind 10002 write relays (score 1.0) -> kind 3 contact list content (same priority) -> NIP-05 relays (same priority) -> relays where person's events were fetched (score 0.2, 14-day halflife) -> relay hints from others (score 0.1, 7-day halflife) -> own READ relays after 15s timeout |
| **Coracle** | Kind 10002 write relays -> `addMinimalFallbacks` adds 1 random default relay if zero found -> indexed kinds always also query indexer relays -> `loadUsingOutbox()` tries chunks of 2, stops on success |
| **NDK** | Kind 10002 write relays -> kind 3 content parsed as relay list -> pool's permanent + connected relays for authors with no known relays |
| **Amethyst** | Kind 10002 write relays -> HintIndexer bloom filter hints -> `eventFinderRelays` (7 hardcoded). Own relay fallback: write -> eventFinderRelays, read -> bootstrapInbox (7 relays) |
| **Nostur** | Kind 10002 write relays -> user's own configured relays (always queried in parallel). If any write relay matches known-bad list, entire kind 10002 is discarded |
| **rust-nostr** | WRITE relays (gossip graph bitflags) -> HINT relays (p-tag hints, 1/user) -> most-RECEIVED relays (by event count, 1/user) -> client's READ relays for orphan filters |
| **Voyage** | NIP-65 write relays -> event-relay tracking (which relays delivered this author) -> READ relays + already-selected relays -> pubkeys with only 1 relay get added to READ relays for redundancy |
| **Nosotros** | Kind 10002 WRITE relays (tanstack-query cache) -> `FALLBACK_RELAYS` env var. Subscriptions merge: outbox relay-filter pairs + static relay list + relay hints (max 4) |
| **Wisp** | RelayScoreBoard (greedy set-cover over write relays) -> `sendToAll` for authors without relay lists |
| **Yakihonne** | Query all connected relays -> fetch author's kind 10002, connect temporarily (2s), fetch event, disconnect. No outbox routing for feeds |
| **Notedeck** | No outbox routing yet. All relays receive all messages uniformly |
| **Shopstr** | All events to user's own write + general relays + blastr. No per-recipient routing |

---

## 4. Indexer Relay Usage

| Project | Indexer Relays Used | What Is Fetched |
|---------|-------------------|----------------|
| Coracle/Welshman | `purplepag.es`, `relay.damus.io`, `indexer.coracle.social` | Kinds 0, 3, 10002, 10050 |
| NDK | `purplepag.es`, `nos.lol` (dedicated outbox pool) | Kind 10002 (kind 3 fallback) |
| Amethyst | `purplepag.es`, `indexer.coracle.social`, `user.kindpag.es`, `directory.yabu.me`, `profiles.nostr1.com` | Kind 10002 during progressive cascade |
| noStrudel | `purplepag.es` | Kind 10002 |
| Wisp | `relay.damus.io`, `relay.primal.net` (bootstrap) | Harvests kind 10002 for relay frequency analysis |

Some projects also write to indexers:
- **Coracle** publishes relay list updates to indexers via `withIndexers()`
- **Gossip** publishes kind 10002 to relays matching `is_good_for_advertise()`, including DISCOVER relays
- **Amethyst** publishes metadata and relay lists to all follow outbox + indexer + own relays

---

## 5. New User Experience

- **Gossip**: Setup wizard requires explicit relay role assignment (3+ OUTBOX, 2+ INBOX, 4+ DISCOVERY). Structured but requires relay topology knowledge.
- **Wisp**: Fully automated. Probes 15 relay candidates with NIP-11 + write test, selects top 8 by latency. Only project that tests relay health before adding.
- **Amethyst**: 5-relay indexer list + 7-relay event finder fallback means new users see content immediately via fallback relays before optimal outbox set is discovered.
- **Coracle**: Default relays + indexers + `addMinimalFallbacks` (1 relay per missing user). Functional but sparse for users on obscure relays.
- **NDK apps**: Outbox "for free" -- `OutboxTracker` auto-fetches relay lists, dedicated outbox pool handles discovery, `refreshRelayConnections()` adds new relays to active subs.

### Existing-User Login on New Device

- **Gossip**: Fetches own relay list from DISCOVER relays, bootstraps from there
- **Coracle**: Queries hint relays + known writes + indexers in parallel
- **NDK**: Outbox pool queries `purplepag.es` and `nos.lol` for user's kind 10002
- **Notedeck**: Priority: forced relays > local + advertised > bootstrap
- **Amethyst**: Connects to indexers for own kind 10002, then to all listed relays
- **Yakihonne**: Connects to constant Yakihonne relays, fetches kind 10002, connects to those
