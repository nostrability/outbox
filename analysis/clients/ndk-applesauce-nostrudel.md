# NDK, Applesauce, noStrudel

---

## NDK (TypeScript, Browser/Node)

### Quick Facts
| Setting | Value |
|---------|-------|
| Algorithm | Priority-based (connected > already-selected > popular) |
| Connection cap | None (prefers reusing existing connections) |
| Per-pubkey target | 2 (`relayGoalPerAuthor`) |
| Fallback relays | purplepag.es, nos.lol (outbox pool); app's permanent relays |
| Health tracking | Flapping detection + exponential backoff; >50% disconnect in 5s = system-wide reset |
| NIP-17 DM inbox | No |
| Configurable | Per-subscription relay goal |

### How It Works
Outbox is enabled by default — any app calling `ndk.subscribe()` with author filters gets outbox routing without code changes. The OutboxTracker fetches kind 10002 (kind 3 as fallback) in batches of 400 via a dedicated outbox pool (purplepag.es, nos.lol), cached in a 100k-entry LRU with 2-minute TTL. Relay selection prioritizes already-connected relays, then relays already selected for other authors (connection reuse), then popularity-ranked relays. When relay lists update, NDK re-routes affected active subscriptions via `refreshRelayConnections()`.

### Notable
- Zero-config outbox: transparent to consuming applications. No setup required beyond calling `ndk.subscribe()`.
- Temporary relay connections auto-disconnect after 30s of non-use. Prevents connection bloat from one-off outbox relays.
- System-wide disconnect detection: >50% of relays disconnecting within 5s triggers coordinated reconnection with reset backoff (handles sleep/wake cycles).
- No hard connection cap. Minimizes *new* connections via priority system rather than limiting total count.

---

## Applesauce (TypeScript, Library)

### Quick Facts
| Setting | Value |
|---------|-------|
| Algorithm | Greedy set-cover with pluggable scoring |
| Connection cap | Configurable `maxConnections` |
| Per-pubkey target | Configurable `maxRelaysPerUser` |
| Fallback relays | Configurable fallback list |
| Health tracking | RelayLiveness: online → offline → dead (terminal after 5 failures) |
| NIP-17 DM inbox | No |
| Configurable | Yes (both caps, custom score function) |

### How It Works
Applesauce provides pure functions and RxJS operators for composable outbox pipelines. The core `selectOptimalRelays()` function runs greedy set-cover: iteratively picks the relay covering the most uncovered users, recalculates coverage each step, stops at `maxConnections`. A pluggable `score(relay, coverageScore, popularity)` callback lets clients customize scoring. The OutboxModel chains: contacts → blacklist filter → mailbox enrichment → optimal relay selection, all as reactive observables.

### Notable
- Modular library — clients compose pipelines from pure functions + RxJS operators. Not tied to any specific client.
- RelayLiveness is a three-state machine: online → offline → dead. Dead after 5 consecutive failures is permanent for the session. Exponential backoff: base 30s, max 5min.
- `ignoreUnhealthyRelaysOnPointers` operator reactively re-runs selection when relays go offline, automatically adapting the relay set.

---

## noStrudel (TypeScript, Browser)

### Quick Facts
| Setting | Value |
|---------|-------|
| Algorithm | Applesauce greedy set-cover + health filtering |
| Connection cap | 20 (user-adjustable slider 0–30) |
| Per-pubkey target | 5 (user-adjustable slider 0–30) |
| Fallback relays | relay.primal.net, relay.damus.io |
| Health tracking | Applesauce RelayLiveness persisted to localforage (5s base backoff) |
| NIP-17 DM inbox | No |
| Configurable | Yes (both sliders, fallback relays) |

### How It Works
noStrudel is a full Nostr client using Applesauce as its library layer. Its outbox pipeline chains: includeMailboxes → includeFallbackRelays → ignoreUnhealthyRelays → debounceTime(500ms) → selectOptimalRelays. The 500ms debounce waits for kind 10002 events to arrive from multiple relays before running selection. All settings (max connections, max relays per user) are reactive observables — changing any setting triggers re-selection. An LRU cache of 30 outbox maps avoids recomputation.

### Notable
- Only client with a user-facing outbox debugger: coverage %, per-relay table with user counts, "users by relay count" breakdown, missing relay list users, and "orphaned" users whose relays were all dropped during optimization. Color-coded: green ≥80%, yellow ≥50%, red <50%.
- Uses purplepag.es as its single lookup/indexer relay for kind 10002 fetching.
- RelayLiveness state persisted to localforage across sessions, with a more aggressive 5s base backoff (vs Applesauce default of 30s).
