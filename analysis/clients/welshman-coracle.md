# Welshman + Coracle: Outbox/Relay Routing Analysis

## Key Observations

- **Stochastic relay selection.** `Math.random()` in the scoring formula means two identical queries may hit different relay sets.
- **Quality as a hard gate.** Relays with quality 0 (blocked, recent errors) are completely excluded -- `0 * log(weight) * random() = -0` is falsy and gets filtered out.
- **No connection limit.** No hard cap on total concurrent WebSocket connections. The pool grows indefinitely. `relay_limit` only controls how many relays are selected per routing scenario.
- **Local cache as first-class relay.** `LOCAL_RELAY_URL` adapter means every request also checks the in-memory Repository, providing instant cached results.
- **No gossip/rumor relay discovery.** Relies entirely on kind 10002 relay lists fetched from indexer relays and the outbox model.
- **Publish confirmation tracking.** The `Thunk` system tracks publish results per-relay and removes tracker entries for relays that fail.

---

## 1. Router and Scoring

**File**: `/tmp/outbox-research/welshman/packages/router/src/index.ts`

The `Router` is stateless -- all relay knowledge comes from injected callbacks in `routerContext`. It creates `RouterScenario` instances that build `Selection[]` arrays (relay + weight pairs) from scenarios, merge them, then score and select the top N.

### Scenarios

| Method | Relays Used | Mode |
|---|---|---|
| `ForUser()` | User's READ relays | Read |
| `FromUser()` | User's WRITE relays | Write |
| `MessagesForUser()` | User's MESSAGING relays | Messaging |
| `ForPubkey(pk)` | Target's READ relays | Read |
| `FromPubkey(pk)` / `FromPubkeys(pks)` | Target's WRITE relays | Write |
| `PublishEvent(event)` | Author write + tagged pubkeys' read (0.5 weight), limit 30 | Mixed |
| `Index()` / `Search()` / `Default()` | Indexer / Search / Fallback relays | N/A |

### Scoring Formula

```typescript
const scoreRelay = (relay: string) => {
  const weight = relayWeights.get(relay)!
  const quality = getRelayQuality ? getRelayQuality(relay) : 1
  return -(quality * inc(Math.log(weight)) * Math.random())
}
```

- `Math.log(weight)` compresses hub bias -- a relay appearing 100 times scores ~5.6x vs 1x, not 100x.
- `Math.random()` introduces variation so the same query may hit different relays.
- `quality` is 0-1; quality=0 means complete exclusion.

### Quality Calculation

**File**: `/tmp/outbox-research/welshman/packages/app/src/relayStats.ts`

```typescript
export const getRelayQuality = (url: string) => {
  if (!isRelayUrl(url)) return 0
  if ($pubkey && getRelaysFromList(getBlockedRelayList($pubkey)).includes(url)) return 0

  const relayStats = getRelayStats(url)
  if (relayStats) {
    if (relayStats.recent_errors.filter(n => n > ago(MINUTE)).length > 0) return 0
    if (relayStats.recent_errors.filter(n => n > ago(HOUR)).length > 3)   return 0
    if (relayStats.recent_errors.filter(n => n > ago(DAY)).length > 10)   return 0
  }

  if (Pool.get().has(url)) return 1        // currently connected
  if (relayStats) return 0.9               // previously connected
  if (!isIPAddress(url) && !isLocalUrl(url) && !isOnionUrl(url) && !url.startsWith("ws://"))
    return 0.8                              // standard unknown relay
  return 0.7                               // weird URL
}
```

**Error thresholds:**
- 1+ errors in last minute: quality = 0
- 3+ errors in last hour: quality = 0
- 10+ errors in last day: quality = 0

Stats collected via socket event listeners, batched every 1000ms, `recent_errors` capped at 10 entries.

### Relay Limit

Default **3** relays per scenario. Precedence: scenario override > router-level `getLimit()` > hardcoded 3. `PublishEvent` overrides to 30.

Coracle users can change this via `relay_limit` setting.

### Fallback Policies

```typescript
addNoFallbacks       // always 0 (default)
addMinimalFallbacks  // 1 if count is 0, else 0
addMaximalFallbacks  // limit - count (fill up to limit)
```

Fallback relays are shuffled from `getDefaultRelays()`.

---

## 2. Outbox Read vs. Write Paths

### Reading (fetching events by others)

Filter selection priority:
1. Search filters -> search relays
2. WRAP filters -> user's messaging relays
3. Indexed kinds (0, 3, 10002, 10050) -> indexer relays
4. Filters with authors -> `FromPubkeys(authors)` (their write relays -- core outbox model)
5. Remaining filters -> `ForUser().weight(0.2)` (user's read relays, low weight)

For large author lists, pubkeys are chunked into groups of ~30, each getting independent relay selection.

### Publishing

- Regular events: author's write relays + each tagged pubkey's read relays (0.5 weight), limit 30, minimal fallbacks.
- User metadata (relay lists, follows, profile): `FromUser().policy(addMaximalFallbacks)` -- write relays filled to limit with defaults. Relay list updates also include indexer relays.
- Notifications: user's READ relays with maximal fallbacks.
- DMs: user's READ relays (incoming), WRITE relays (sent), MESSAGING relays (NIP-17 wraps).

### Outbox loading with chunked fallback

**File**: `/tmp/outbox-research/welshman/packages/app/src/relayLists.ts`

```typescript
export const loadUsingOutbox = async (kind: number, pubkey: string, filter: Filter = {}) => {
  const writeRelays = getRelaysFromList(await loadRelayList(pubkey), RelayMode.Write)
  const allRelays = Router.get()
    .FromRelays(writeRelays)
    .policy(addMinimalFallbacks)
    .limit(8)
    .getUrls()

  for (const relays of chunk(2, allRelays)) {
    const events = await load({filters, relays})
    if (events.length > 0) return first(sortEventsDesc(events))
  }
}
```

Tries relays in chunks of 2, stopping when results are found.

---

## 3. Kind 10002 (NIP-65) Processing

**File**: `/tmp/outbox-research/welshman/packages/util/src/List.ts`

Tags without a third element pass through for both read and write (correct per NIP-65 spec).

Relay list fetching tries three strategies in parallel: hint relays, known write relays, and indexer relays.

The `@welshman/app` package provides `getPubkeyRelays` handling `RelayMode.Blocked` (kind 10006) and `RelayMode.Messaging` (kind 10050) in addition to standard read/write.

---

## 4. Connection Management

**File**: `/tmp/outbox-research/welshman/packages/net/src/pool.ts`

- **Pool**: Singleton `Map<string, Socket>`. Sockets created lazily on first request, cached indefinitely.
- **Adapters**: `SocketAdapter` (real WebSocket), `LocalAdapter` (in-memory Repository), `MockAdapter` (testing).
- **Tracker**: Bidirectional `eventId <-> relay` maps for deduplication and provenance. Persisted to IndexedDB in Coracle.
- **Request batching**: 200ms delay, groups by relay, unions filters per relay. Default 3s timeout, returns after 50% of relays respond.

### Socket Policies

Four default policies on every socket:
- **Ping**: `["PING"]` every 30s if idle, detects broken connections.
- **Auth buffer**: Buffers outgoing messages during NIP-42 auth, replays on success. Coracle auto-authenticates via user setting.
- **Connect-on-send**: Opens WebSocket only when a message is sent (unless error in last 5s).
- **Close-inactive**: Closes after 30s with no pending requests. Reopens with 5s anti-flap delay if closed unexpectedly while requests pending.

---

## 5. Bootstrapping

**File**: `/tmp/outbox-research/coracle/.env.template`

```
VITE_DEFAULT_RELAYS=relay.damus.io,nos.lol
VITE_INDEXER_RELAYS=relay.damus.io,purplepag.es,indexer.coracle.social
VITE_SEARCH_RELAYS=nostr.wine,search.nos.today
VITE_SIGNER_RELAYS=relay.nsec.app,ephemeral.snowflare.cc,bucket.coracle.social
VITE_DVM_RELAYS=relay.nsec.app,ephemeral.snowflare.cc,bucket.coracle.social
```

Coracle overrides welshman's dynamic defaults (top 5 known relays by quality) with these static lists. At startup, NIP-11 relay info is fetched for all initial relays.

Negentropy (NIP-77) sync is supported for capable relays (strfry 1.x+, relays advertising NIP-77). Coracle partitions relays into negentropy-capable and non-capable, using full sync for the former.
