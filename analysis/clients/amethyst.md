# Amethyst (Kotlin, Android)

## Quick Facts
| Setting | Value |
|---------|-------|
| Algorithm | Direct mapping (feeds); greedy set-cover (recommendations) |
| Connection cap | Dynamic (pool resized every 300ms based on active subscriptions) |
| Per-pubkey target | All declared write relays |
| Fallback relays | 7 hardcoded event finder relays (nostr.wine, relay.damus.io, relay.primal.net, nostr.mom, nos.lol, nostr.bitcoiner.social, nostr.oxtr.dev) |
| Health tracking | Binary RelayOfflineTracker + exponential backoff (500ms base) |
| NIP-17 DM inbox | Yes (kind 10050) |
| Configurable | No (but proxy relay bypasses outbox entirely) |

## How It Works

Amethyst uses Kotlin StateFlow reactive pipelines. For each followed pubkey, it observes the addressable note at `10002:<pubkey>:`. The OutboxRelayLoader extracts write relays per user, falls back to bloom filter hints then 7 hardcoded event finder relays, and groups subscriptions so each relay gets a filter containing only its assigned authors. Kind 10002 changes automatically recompute the relay-to-author map and rebuild subscription filters. The relay pool dynamically adds/removes connections based on the union of active subscription needs, updated every 300ms.

## Notable

- Three bloom filters (~9.6MB total) provide probabilistic relay hints for pubkeys, events, and addresses without needing a database. Uses relay URL hashcode as seed differentiator.
- 10 distinct relay list types. NIP-65 (kind 10002) is public relay metadata. The other 9 are mostly NIP-51 encrypted lists: DM (10050), proxy, blocked, broadcast, indexer, search, trusted, private storage, and local relay.
- Proxy relay system completely bypasses outbox when configured — all filters routed through a single trusted relay. Explicit fallback for Tor/privacy-focused users.
- Progressive 5-tier relay discovery with load shedding at >300 follows: reduces to 2 indexer relays/user and 20 connected relays (from 5/100).
- Hardcoded blocklist excludes known aggregator/special-purpose relays (feeds.nostr.band, filter.nostr.wine, nwc.primal.net, relay.getalby.com) from outbox selection.
