# rust-nostr, Voyage, Nosotros, Wisp, Shopstr

---

## rust-nostr (Rust, SDK)

### Quick Facts
| Setting | Value |
|---------|-------|
| Algorithm | Filter decomposition via bitflags |
| Connection cap | None |
| Per-pubkey target | 3 write + 3 read + 1 hint + 1 most-used |
| Fallback relays | Client's configured READ relays |
| Health tracking | Per-pubkey freshness semaphore (Missing/Outdated/Updated) |
| NIP-17 DM inbox | Yes (kind 10050, PRIVATE_MESSAGE bitflag) |
| Configurable | No (compile-time limits) |

### How It Works
rust-nostr stores bitflags per (pubkey, relay) pair: READ, WRITE, PRIVATE_MESSAGE, HINT, RECEIVED. The `break_down_filter()` function decomposes nostr filters based on these flags: `authors`-only filters use WRITE + HINT + RECEIVED relays, `#p`-only filters use READ + HINT + RECEIVED, both uses the union, neither falls back to client READ relays. Per-flag limits (3 write, 3 read, 1 hint, 1 most-used) are applied per pubkey. Supports negentropy (NIP-77) sync for bandwidth-efficient updates.

### Notable
- Five independent relay association types per (pubkey, relay) pair via bitflags. Most granular relay classification of any analyzed implementation.
- Freshness checking via per-pubkey tokio semaphores, stress-tested to 10k concurrent requests.
- SQLite backend persists the gossip graph across restarts (received_events count, last_received_event timestamp).

### Upgrade Path: FD+Thompson
rust-nostr's per-author Filter Decomposition can be upgraded to FD+Thompson by replacing lexicographic relay ordering with `sampleBeta(α, β)` scoring from delivery history. Same per-author structure, same write limits — just learned relay ranking instead of static. After 5 learning sessions (cap@20, NIP-66 filtered): FD+Thompson reaches **83.9% event recall** at 1yr vs baseline FD's 23.1% — converging within 2-3 sessions. Welshman+Thompson leads by ~5pp (89.4%) due to popularity weighting, but FD+Thompson requires no structural changes to existing rust-nostr code. See [README.md § FD+Thompson](../../README.md#fdthompson-for-rust-nostr) for implementation code.

---

## Voyage (Kotlin, Android)

### Quick Facts
| Setting | Value |
|---------|-------|
| Algorithm | Multi-phase greedy (NIP-65 + event-relay tracking) |
| Connection cap | 25 (`MAX_AUTOPILOT_RELAYS`) |
| Per-pubkey target | 2 (`MAX_RELAYS_PER_PUBKEY`, publish only) |
| Fallback relays | READ relays + already-selected relays |
| Health tracking | Spam relay flagging |
| NIP-17 DM inbox | No |
| Configurable | No |

### How It Works
Voyage's "autopilot" runs four phases: (1) map followed users' NIP-65 write relays, sorted by not-spam/has-event-data/connected/not-disconnected, take top 25; (2) fill coverage gaps using EventRelayAuthorView (tracks which relay delivered events from which author); (3) assign uncovered pubkeys to READ + selected relays; (4) pubkeys with only 1 relay get added to READ relays for redundancy.

### Notable
- Unique dual-source relay selection: combines NIP-65 declarations with empirical event-relay tracking (which relays actually delivered events from each author).
- Room (SQLite) persistent storage for NIP-65 data with `createdAt` for upsert deduplication.
- `lazySubNip65s()` identifies friends with missing NIP-65 data and fetches kind 10002 lazily on demand.

---

## Nosotros (TypeScript, Browser)

### Quick Facts
| Setting | Value |
|---------|-------|
| Algorithm | RxJS observable pipeline with event-count ranking |
| Connection cap | None |
| Per-pubkey target | 3 (configurable slider 1–14) |
| Fallback relays | FALLBACK_RELAYS env var |
| Health tracking | Relay stats DB (event count, connect count) |
| NIP-17 DM inbox | No |
| Configurable | Yes (max relays per user slider 1–14) |

### How It Works
Nosotros splits nostr filters by field type using RxJS observables. For `authors` fields, it fetches each author's relay list via tanstack-query (with batching), selects WRITE relays sorted by relay stats event count descending, and slices to `maxRelaysPerUser`. Subscriptions merge three sources: outbox-resolved relay-filter pairs, a static relay list, and relay hints (capped at 4). Filters blacklisted relays, ignored relays, and non-`wss://` URLs.

### Notable
- Per-author relay resolution via tanstack-query with batching — each author's relay list resolves independently as an observable.
- SQLite (OPFS) `seen` table tracks `(eventId, relay, created_at)` for event delivery tracking.
- Subscription merges outbox results + static relays + hints into a unified stream. Max 4 hint relay connections per subscription.

---

## Wisp (Kotlin, Android)

### Quick Facts
| Setting | Value |
|---------|-------|
| Algorithm | Greedy set-cover (`RelayScoreBoard`) |
| Connection cap | 75 (`MAX_SCORED_RELAYS`) |
| Per-pubkey target | No per-pubkey limit |
| Fallback relays | relay.damus.io, relay.primal.net (onboarding only) |
| Health tracking | None explicit |
| NIP-17 DM inbox | No |
| Configurable | No |

### How It Works
Wisp's RelayScoreBoard builds a relay-to-followed-authors map from kind 10002 write relays, then runs greedy set-cover: pick the relay covering the most uncovered authors, remove them, repeat until all covered or 75-relay cap reached. Authors without relay lists get `sendToAll` (broadcast to all general relays). The scoreboard recomputes after relay list EOSE.

### Notable
- Unique onboarding relay prober: harvests 500 kind 10002 events from bootstrap relays, drops top 5 mega-relays, requires frequency ≥3, probes 15 middle-tier candidates with NIP-11 + ephemeral write test (kind 20242), selects top 8 by latency.
- Only project that tests relay health and latency *before* adding relays during onboarding.
- LRU(500) relay list cache backed by SharedPreferences for persistence.

---

## Shopstr (TypeScript, Browser)

### Quick Facts
| Setting | Value |
|---------|-------|
| Algorithm | None (static relay list) |
| Connection cap | N/A |
| Per-pubkey target | N/A |
| Fallback relays | relay.damus.io, nos.lol, purplepag.es, relay.primal.net, relay.nostr.band |
| Health tracking | None |
| NIP-17 DM inbox | No |
| Configurable | No |

### How It Works
Shopstr is a Next.js marketplace using nostr-tools' SimplePool. It reads kind 10002 for the user's own relay config only, not for other users. All events publish to the user's own write relays + general relays + sendit.nosflare.com (blastr). No per-recipient routing.

### Notable
- Marketplace-focused: relay routing is not a priority since listings are broadcast broadly.
- Adds sendit.nosflare.com (blastr) to all writes for maximum event propagation.
- Relays stored in localStorage with three separate lists: relays, readRelays, writeRelays.
