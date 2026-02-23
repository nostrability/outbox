# Cross-Client Comparison

Outbox implementation decisions across 15 Nostr clients, organized by what you need to decide.

For per-client details, see [clients/](clients/). For recommendations, see [IMPLEMENTATION-GUIDE.md](../IMPLEMENTATION-GUIDE.md).

---

## 1. Relay Selection Algorithm

| Client | Algorithm | Scoring | Notes |
|--------|-----------|---------|-------|
| **Gossip** | Greedy set-cover | `association * relay_quality` (two-layer composite) | Temporal decay on non-declared signals (14d/7d halflife) |
| **Welshman/Coracle** | Weighted stochastic | `quality * (1 + log(weight)) * random()` | Only client with stochastic selection |
| **NDK** | Priority-based | Connected > already-selected > popular | Zero-config: any `subscribe()` with authors gets outbox |
| **Applesauce/noStrudel** | Greedy set-cover | `covered_users / remaining_pool` (pluggable) | Custom `score()` callback available |
| **Amethyst** (feeds) | Direct mapping | None (binary: online/offline) | Maps each follow to ALL declared write relays |
| **Amethyst** (recs) | Greedy set-cover | Coverage count | Two-pass: cover all, then ensure ≥2 relays/user |
| **Nostur** | Greedy coverage sort | Coverage count, skip top N | `skipTopRelays: 3` forces anti-centralization |
| **rust-nostr** | Filter decomposition | `received_events DESC` tiebreak | Bitflag per (pubkey, relay): READ/WRITE/HINT/RECEIVED/DM |
| **Voyage** | Multi-phase greedy | Lexicographic: not-spam > event-data > connected | 4 phases: NIP-65 → event-relay tracking → fallback → redundancy |
| **Wisp** | Greedy set-cover | Pure coverage count | Onboarding probes relay latency before selection |
| **Nosotros** | Observable pipeline | Event-count sort | Per-author relay resolution via tanstack-query |

---

## 2. Connection Limits

| Client | Hard cap | Per-pubkey target | Configurable |
|--------|:--------:|:-----------------:|:------------:|
| **Gossip** | 50 | 2 | Both |
| **Welshman/Coracle** | None (3/scenario) | 3 | Yes (`relay_limit`) |
| **NDK** | None | 2 | Per-subscription |
| **noStrudel** | 20 | 5 | Both (sliders 0–30) |
| **Amethyst** | Dynamic | All declared | No |
| **Nostur** | 50 (outbox pool) | 2 | No |
| **rust-nostr** | None | 3w + 3r + 1h + 1m | No (compile-time) |
| **Voyage** | 25 | 2 (publish) | No |
| **Wisp** | 75 | No limit | No |
| **Nosotros** | None | 3 | Yes (slider 1–14) |

Browser clients (noStrudel, Welshman, Nosotros) face practical WebSocket limits on memory/CPU. Native clients can afford more connections.

---

## 3. Bootstrap & Fallback

| Client | Bootstrap relays | Fallback chain | Indexer relays |
|--------|-----------------|----------------|----------------|
| **Gossip** | 36 in setup wizard | Fetched (0.2/14d decay) → hints (0.1/7d) → own READ relays (15s timeout) | None hardcoded |
| **Coracle** | relay.damus.io, nos.lol | 1 random default relay if zero found | purplepag.es, relay.damus.io, indexer.coracle.social |
| **NDK** | App-configured | Kind 3 content → pool permanent relays | purplepag.es, nos.lol |
| **noStrudel** | relay.primal.net, relay.damus.io | Configurable fallback list | purplepag.es |
| **Amethyst** | 7 event finder + 7 inbox relays | Bloom filter hints → 7 hardcoded relays | 5 indexers (purplepag.es, indexer.coracle.social, user.kindpag.es, directory.yabu.me, profiles.nostr1.com) |
| **Nostur** | User-configured | User's own configured relays (always parallel) | None hardcoded |
| **rust-nostr** | App-supplied | HINT + RECEIVED relays → client's READ relays | None hardcoded |
| **Voyage** | None explicit | Event-relay tracking → READ + selected → redundancy pass | None hardcoded |
| **Wisp** | relay.damus.io, relay.primal.net | sendToAll for missing relay lists | None hardcoded |
| **Nosotros** | FALLBACK_RELAYS env var | Static relay list + relay hints (max 4) | None hardcoded |
| **Shopstr** | relay.damus.io, nos.lol, purplepag.es, relay.primal.net | All events to own write + general + blastr | None |
| **Yakihonne** | 4 Yakihonne/Dorafactory + relay.damus.io | On-demand event lookup (temporary 2s connect) | None |
| **Notedeck** | relay.damus.io, nos.lol, nostr.wine, purplepag.es | No outbox routing yet | None |

**Common relays:** relay.damus.io (8/13), purplepag.es (6/13), nos.lol (5/13), relay.primal.net (5/13).

---

## 4. Health & Liveness

| Client | Approach | States | Backoff |
|--------|----------|--------|---------|
| **Gossip** | Per-relay success/failure counts + penalty box | Excluded for 15s–10min by failure reason | Per-reason timers |
| **Welshman** | Tiered error thresholds | Quality 0–1 (0 = excluded) | 1/min, 3/hr, or 10/day = quality 0 |
| **NDK** | Flapping detection | Normal / coordinated-reconnect | Exponential; >50% disconnect in 5s = system-wide reset |
| **Applesauce/noStrudel** | Three-state machine | Online → Offline → Dead (terminal) | Exponential: base 5–30s, max 5min, dead after 5 failures |
| **Amethyst** | Binary offline set | Available / offline | Exponential: 500ms base, doubling |
| **Nostur** | Misconfigured kind 10002 detection + stale cleanup | Connected / idle / special-purpose exclusion | 10min idle cleanup, 35s ephemeral |
| **rust-nostr** | Per-pubkey freshness semaphore | Missing / Outdated / Updated | TTL-based |
| **Voyage** | Spam relay flagging | Not-spam / spam | Boolean sort factor |

---

## 5. Heuristics Beyond Outbox

| Heuristic | Purpose | Implemented by |
|-----------|---------|----------------|
| **Inbox** (NIP-65 read relays) | Deliver to recipient's read relays | Gossip, Welshman, NDK, Applesauce, Amethyst, Nostur, rust-nostr, Voyage, Nosotros, Wisp |
| **DM inbox** (kind 10050) | Route gift wraps to DM relays | Gossip, Welshman, Amethyst, rust-nostr (partial: Nostur) |
| **Relay hints** (e/p/a tags) | Use relay URLs from event tags | Gossip, Welshman, NDK, Amethyst, Nostur, rust-nostr, Nosotros, Wisp |
| **Search relays** (NIP-50) | Route full-text search | Welshman, Amethyst, Gossip |
| **Indexer relays** | Fetch metadata (kinds 0, 3, 10002) | Welshman, NDK, Amethyst, noStrudel, Wisp |
| **Event delivery tracking** | Track which relays delivered events per author | Gossip, rust-nostr, Voyage, Amethyst, Nosotros |
| **Community/group relays** | Route NIP-72/NIP-29 events | Amethyst |

---

## 6. Unsolved Problems

- **Hashtag/geohash routing** — No pubkey to look up for `#t` or `#g` filtered events. No mechanism for relays to advertise topic specialization.
- **Relay capability discovery** — Beyond NIP-11's `supported_nips`, relays cannot advertise coverage, retention policies, or performance characteristics.
- **No client measures actual per-author delivery** — The most important missing metric. noStrudel shows assignment coverage but not event recall.
- **Replaceable vs regular events treated identically** — For replaceable events (kind 0, 3, 10002), a single copy from any relay suffices. Only Welshman routes "indexed kinds" to indexers as a special case.
- **Cross-heuristic conflict resolution** — When declared relays disagree with observed evidence (e.g., declared relay dead for a month vs undeclared relay delivering events), implementations use ad hoc priority rules.

---

## 7. Maturity

| Project | Read Outbox | Write Inbox | Scoring | Health | NIP-17 DM | Configurable |
|---------|:-----------:|:-----------:|:-------:|:------:|:---------:|:------------:|
| **Gossip** | Full | Full | Multi-factor | Full | Yes | Yes |
| **Welshman/Coracle** | Full | Full | Stochastic | Tiered | Yes | Yes |
| **Amethyst** | Full | Full | Binary | Binary | Yes | No |
| **NDK** | Full | Full | Priority | Flapping | No | Per-sub |
| **Applesauce/noStrudel** | Full | Full | Pluggable | 3-state | No | Yes |
| **Nostur** | Full | Full | Coverage | Misc detect | Partial | No |
| **rust-nostr** | Full | Full | Tiebreak | Freshness | Yes | No |
| **Voyage** | Full | Full | Lexicographic | Spam flag | No | No |
| **Wisp** | Full | Full | Coverage | None | No | No |
| **Nosotros** | Full | Full | Event-count | Stats DB | No | Yes |
| **Yakihonne** | None | None | None | None | No | No |
| **Notedeck** | Planned | None | None | None | No | No |
| **Shopstr** | None | None | None | None | No | No |
