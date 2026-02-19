# Welshman + Coracle: Outbox/Relay Routing Analysis

## Summary

Welshman is a modular TypeScript library that provides the relay routing engine (`@welshman/router`), connection management (`@welshman/net`), relay health tracking (`@welshman/app`), and NIP-65 relay list processing. Coracle is a Svelte-based nostr client that consumes Welshman and configures it with concrete relay sets and user settings.

**Key architectural characteristics:**

- **Weighted selection model**: The Router builds `Selection[]` arrays (relay + weight pairs) from multiple "scenarios" (e.g., author's write relays, user's read relays, tag hints), merges them, then scores relays using `quality * log(weight) * random()` to pick the top N.
- **Default relay limit of 3**: Configurable per-user via `relay_limit` setting; the Router's `getLimit()` defaults to 3.
- **Quality-gated relay scoring**: Relays with recent errors get quality 0 (excluded). Connected relays get 1.0, previously-seen get 0.9, unknown standard relays get 0.8.
- **Three fallback policies**: `addNoFallbacks` (default), `addMinimalFallbacks` (1 fallback if zero relays found), `addMaximalFallbacks` (fill up to limit with fallbacks).
- **Lazy connect-on-send**: WebSocket connections are established only when a message needs to be sent, and auto-close after 30 seconds of inactivity.
- **Local relay as cache**: Every request (unless `skipCache: true`) also queries a local in-memory `Repository` via a `LocalAdapter`.

---

## 1. Router Core Logic

**File**: `/tmp/outbox-research/welshman/packages/router/src/index.ts`

### Router class

The `Router` is a stateless factory that creates `RouterScenario` instances. It has no internal state -- all relay knowledge comes from injected callbacks in `routerContext`.

```typescript
export class Router {
  readonly options: RouterOptions

  static configure(options: RouterOptions) {
    Object.assign(routerContext, options)
  }

  static get() {
    return new Router(routerContext)
  }
  // ...
}
```

### RouterOptions (dependency injection)

```typescript
export type RouterOptions = {
  getUserPubkey?: () => string | undefined
  getPubkeyRelays?: (pubkey: string, mode?: RelayMode) => string[]
  getDefaultRelays?: () => string[]
  getIndexerRelays?: () => string[]
  getSearchRelays?: () => string[]
  getRelayQuality?: (url: string) => number
  getLimit?: () => number
}
```

These are populated by `@welshman/app` at import time (see section 8 below) and further overridden by Coracle at initialization.

### Scenarios (relay selection strategies)

Each scenario method returns a `RouterScenario` wrapping one or more `Selection` objects:

| Method | What it does | Relay mode |
|---|---|---|
| `ForUser()` | User's READ relays | `RelayMode.Read` |
| `FromUser()` | User's WRITE relays | `RelayMode.Write` |
| `MessagesForUser()` | User's MESSAGING relays | `RelayMode.Messaging` |
| `ForPubkey(pk)` | Target's READ relays | `RelayMode.Read` |
| `FromPubkey(pk)` | Target's WRITE relays | `RelayMode.Write` |
| `ForPubkeys(pks)` | Merge of ForPubkey for each | `RelayMode.Read` |
| `FromPubkeys(pks)` | Merge of FromPubkey for each | `RelayMode.Write` |
| `Event(event)` | Author's WRITE relays | `RelayMode.Write` |
| `Replies(event)` | Author's READ relays (where to find replies) | `RelayMode.Read` |
| `PublishEvent(event)` | Author write + each tagged pubkey's read relays (0.5 weight) | Mixed |
| `Index()` | Indexer relays | N/A |
| `Search()` | Search relays (NIP-50) | N/A |
| `Default()` | Fallback/default relays | N/A |

### PublishEvent -- the outbox publish path

```typescript
PublishEvent = (event: TrustedEvent) => {
  const pubkeys = getPubkeyTagValues(event.tags)
  const scenarios = [
    this.FromPubkey(event.pubkey),                              // author's write relays
    ...pubkeys.map(pubkey => this.ForPubkey(pubkey).weight(0.5)), // each tagged user's read relays
  ]
  // Override the limit to ensure deliverability
  return this.merge(scenarios).limit(30)
}
```

This is the core outbox model: publish to the author's write relays AND the read relays of every tagged pubkey, with a hard limit of 30 relays per event.

### EventParents / EventRoots -- fetching thread context

```typescript
EventParents = (event: TrustedEvent) => {
  const {replies} = getAncestorTags(event)
  const mentions = getPubkeyTags(event.tags)
  const authors = replies.map(nth(3)).filter(p => p?.length === 64)
  const others = mentions.map(nth(1)).filter(p => p?.length === 64)
  const relays = uniq([...replies, ...mentions].map(nth(2)).filter(r => r && isRelayUrl(r)))

  return this.merge([
    this.FromPubkeys(authors).weight(10),  // heavy weight on reply authors' write relays
    this.FromPubkeys(others),              // normal weight on mentioned pubkeys
    this.FromRelays(relays),               // relay hints from tags
  ])
}
```

---

## 2. Relay Scoring and Selection

**File**: `/tmp/outbox-research/welshman/packages/router/src/index.ts` (method `getUrls` on `RouterScenario`)

### The scoring formula

```typescript
const scoreRelay = (relay: string) => {
  const weight = relayWeights.get(relay)!
  const quality = getRelayQuality ? getRelayQuality(relay) : 1

  // Log the weight, since it's a straight count which ends up over-weighting hubs.
  // Also add some random noise so that we'll occasionally pick lower quality/less popular relays.
  return -(quality * inc(Math.log(weight)) * Math.random())
}
```

Where `inc(x)` = `x + 1` and `weight` is the sum of all weights from merged scenarios.

**Key design choices:**
- `Math.log(weight)` compresses hub bias -- a relay appearing 100 times only scores ~5.6x vs 1x, not 100x.
- `Math.random()` introduces stochastic variation so the same query may hit different relays each time.
- `quality` is a 0-1 multiplier; quality=0 means the relay is completely excluded (since the filter removes relays where `scoreRelay` returns falsy, and `-(0 * ...)` = `-0` which is falsy in the filter).

### Relay filtering before scoring

```typescript
for (const {weight, relays} of this.selections) {
  for (const relay of relays) {
    if (!isRelayUrl(relay)) continue
    if (!allowOnion && isOnionUrl(relay)) continue
    if (!allowLocal && isLocalUrl(relay)) continue
    if (!allowInsecure && relay.startsWith("ws://") && !isOnionUrl(relay)) continue
    relayWeights.set(relay, add(weight, relayWeights.get(relay)))
  }
}
```

By default: no onion, no local, no insecure (plain ws://) relays.

### Fallback injection

```typescript
const fallbacksNeeded = fallbackPolicy(relays.length, limit)
const allFallbackRelays: string[] = this.router.options.getDefaultRelays?.() || []
const fallbackRelays = shuffle(allFallbackRelays).slice(0, fallbacksNeeded)

for (const fallbackRelay of fallbackRelays) {
  relays.push(fallbackRelay)
}
```

Three policies:
- `addNoFallbacks`: always 0 (default)
- `addMinimalFallbacks`: 1 if count is 0, else 0
- `addMaximalFallbacks`: `limit - count` (fill up to limit)

---

## 3. Relay Quality / Health Tracking

**File**: `/tmp/outbox-research/welshman/packages/app/src/relayStats.ts`

### RelayStats data structure

```typescript
export type RelayStats = {
  url: string
  first_seen: number
  recent_errors: number[]      // timestamps of last 10 errors
  open_count: number
  close_count: number
  publish_count: number
  request_count: number
  event_count: number
  last_open: number
  last_close: number
  last_error: number
  last_publish: number
  last_request: number
  last_event: number
  last_auth: number
  publish_success_count: number
  publish_failure_count: number
  eose_count: number
  notice_count: number
}
```

### Quality calculation

```typescript
export const getRelayQuality = (url: string) => {
  if (!isRelayUrl(url)) return 0

  // Check user's blocked relay list
  if ($pubkey && getRelaysFromList(getBlockedRelayList($pubkey)).includes(url)) return 0

  const relayStats = getRelayStats(url)

  // Error-based exclusion (tiered thresholds)
  if (relayStats) {
    if (relayStats.recent_errors.filter(n => n > ago(MINUTE)).length > 0) return 0  // any error in last minute
    if (relayStats.recent_errors.filter(n => n > ago(HOUR)).length > 3)   return 0  // >3 errors in last hour
    if (relayStats.recent_errors.filter(n => n > ago(DAY)).length > 10)   return 0  // >10 errors in last day
  }

  if (Pool.get().has(url)) return 1        // currently connected
  if (relayStats) return 0.9               // previously connected
  if (!isIPAddress(url) && !isLocalUrl(url) && !isOnionUrl(url) && !url.startsWith("ws://"))
    return 0.8                              // standard unknown relay
  return 0.7                               // weird URL
}
```

**Tiered error thresholds:**
- 1+ errors in last minute: quality = 0 (dead)
- 3+ errors in last hour: quality = 0 (unstable)
- 10+ errors in last day: quality = 0 (persistent failures)

### Stats collection

Stats are collected via the `trackRelayStats` function, which listens to socket events (Send, Receive, Status changes). This is attached to every socket via `Pool.get().subscribe(socket => trackRelayStats(socket))` in `@welshman/app/index.ts`.

Error timestamps are stored in `recent_errors` array (capped at 10 entries). Stats are batched and updated every 1000ms.

---

## 4. Max Connections Per Request (Relay Limit)

### Default limit

The `RouterScenario.getLimit()` method:

```typescript
getLimit = () => this.options.limit || this.router.options.getLimit?.() || 3
```

So the precedence is:
1. Scenario-specific override (e.g., `.limit(30)` for `PublishEvent`)
2. Router-level `getLimit()` callback
3. Hardcoded default of **3**

### Coracle configuration

In `/tmp/outbox-research/coracle/src/engine/state.ts`:

```typescript
routerContext.getLimit = () => getSetting("relay_limit")
```

And the default setting:

```typescript
export const defaultSettings = {
  relay_limit: 3,
  // ...
}
```

Users can change this in their settings. The `PublishEvent` scenario overrides this to 30 for event publishing.

### Request batching and chunking

For filter selections with many authors, the router chunks pubkeys:

```typescript
export const getFilterSelectionsForAuthors = (filter: Filter) => {
  if (!filter.authors) return []
  const chunkCount = clamp([1, 30], Math.round(filter.authors.length / 30))
  return chunks(chunkCount, filter.authors).map(authors => ({
    filter: {...filter, authors},
    scenario: Router.get().FromPubkeys(authors),
  }))
}
```

This splits large author lists into groups of ~30, each getting their own relay selection.

---

## 5. Long-Tail Redistribution

There is no explicit "redistribution" mechanism. Instead, the system handles obscure relays through:

1. **Fallback policies**: When `addMinimalFallbacks` is used (the default for `getFilterSelections`), if zero relays are found for a pubkey, one random default relay is added.

2. **Log-dampened weight scoring**: `Math.log(weight)` prevents popular relay hubs from completely dominating, giving smaller relays a proportional chance.

3. **Random noise**: `Math.random()` in the scoring formula means that occasionally a less popular relay will be chosen over a more popular one.

4. **Indexer relays as fallback**: The `getFilterSelectionsForIndexedKinds` rule sends queries for kinds 0 (PROFILE), 10002 (RELAYS), 10050 (MESSAGING_RELAYS), and 3 (FOLLOWS) to indexer relays, providing a safety net for users whose relay lists haven't been discovered yet.

5. **Outbox loading with chunked fallback**: The `loadUsingOutbox` function in `@welshman/app/src/relayLists.ts` tries relays in chunks of 2, stopping when it finds results:

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

---

## 6. Outbox Read vs. Write Paths

### Outbox Read (fetching events by others)

When fetching events authored by specific pubkeys, the system uses `FromPubkeys` which resolves to each pubkey's **write relays** (where they publish):

```typescript
FromPubkey = (pubkey: string) =>
  this.FromRelays(this.getRelaysForPubkey(pubkey, RelayMode.Write))
```

This is the core outbox model: to read someone's events, go to their write relays.

For feed loading, the `requestPage` function in `@welshman/feeds/src/request.ts` calls `getFilterSelections()` which applies these rules in order:
1. Search filters -> search relays
2. WRAP filters -> user's messaging relays
3. Indexed kinds (0, 3, 10002, 10050) -> indexer relays
4. Filters with authors -> `FromPubkeys(authors)` (outbox model)
5. All remaining filters -> `ForUser().weight(0.2)` (user's own read relays, low weight)

### Inbox Write (publishing events)

When publishing, `PublishEvent` sends to:
- Author's **write relays** (weight 1.0)
- Each tagged pubkey's **read relays** (weight 0.5)
- Limit overridden to 30

In Coracle's `signAndPublish`:

```typescript
export const signAndPublish = async (template, {anonymous = false} = {}) => {
  const event = await sign(template, {anonymous})
  const relays = Router.get().PublishEvent(event).policy(addMinimalFallbacks).getUrls()
  return await publishThunk({event, relays})
}
```

For user metadata (relay lists, follows, profile), Coracle publishes to `FromUser().policy(addMaximalFallbacks)` -- the user's own write relays, filling up to the limit with defaults. For relay list updates specifically, it also includes indexer relays via `withIndexers()`:

```typescript
export const setOutboxPolicies = async (modifyTags) => {
  publishThunk({
    event: makeEvent(list.kind, { content, tags: modifyTags(list.publicTags) }),
    relays: withIndexers(Router.get().FromUser().policy(addMaximalFallbacks).getUrls()),
  })
}
```

### Notifications (inbox read)

Coracle fetches notifications (events tagging the user) from the user's **read relays**:

```typescript
export const loadNotifications = () => {
  const filter = {kinds: getNotificationKinds(), "#p": [pubkey.get()]}
  return pullConservatively({
    relays: Router.get().ForUser().policy(addMaximalFallbacks).getUrls(),
    // ForUser() = user's READ relays
    filters: [addSinceToFilter(filter, int(WEEK))],
  })
}
```

### Direct Messages

Messages use the dedicated messaging relay mode:

```typescript
export const loadMessages = () => {
  const router = Router.get()
  pullConservatively({
    relays: router.ForUser().getUrls(),     // DMs addressed to user: user's READ relays
    filters: [{kinds: [DEPRECATED_DIRECT_MESSAGE], "#p": [pubkey.get()]}],
  })
  pullConservatively({
    relays: router.FromUser().getUrls(),    // DMs sent by user: user's WRITE relays
    filters: [{kinds: [DEPRECATED_DIRECT_MESSAGE], authors: [pubkey.get()]}],
  })
  pullConservatively({
    relays: router.MessagesForUser().getUrls(), // NIP-17 wraps: user's MESSAGING relays
    filters: [{kinds: [WRAP], "#p": [pubkey.get()]}],
  })
}
```

---

## 7. Kind 10002 (NIP-65) Processing

**File**: `/tmp/outbox-research/welshman/packages/util/src/List.ts`

### Tag format

NIP-65 relay lists (kind 10002) use `r` tags:
- `["r", "wss://relay.example.com/"]` -- both read and write
- `["r", "wss://relay.example.com/", "read"]` -- read only
- `["r", "wss://relay.example.com/", "write"]` -- write only

### Parsing

```typescript
export const getRelayTags = (tags: string[][]) =>
  tags.filter(t => ["r", "relay"].includes(t[0]) && isRelayUrl(t[1] || ""))

export const getRelaysFromList = (list?: List, mode?: RelayMode): string[] => {
  let tags = getRelayTags(getListTags(list))
  if (mode) {
    tags = tags.filter((t: string[]) => !t[2] || t[2] === mode)
  }
  return uniq(tags.map(t => normalizeRelayUrl(t[1])))
}
```

Important: when filtering by mode, tags **without** a third element (no mode specified) pass through for both read and write. This correctly implements the NIP-65 spec where unadorned tags indicate both modes.

### Fetching relay lists

The `fetchRelayList` function tries three strategies in parallel:

```typescript
export const fetchRelayList = async (pubkey: string, relayHints: string[] = []) => {
  const filters = [{kinds: [RELAYS], authors: [pubkey], limit: 1}]
  await Promise.all([
    load({filters, relays: Router.get().FromRelays(relayHints).getUrls()}), // hint relays
    load({filters, relays: Router.get().FromPubkey(pubkey).getUrls()}),     // known write relays
    load({filters, relays: Router.get().Index().getUrls()}),                // indexer relays
  ])
}
```

### Default routerContext for relay lists

The `routerContext.getPubkeyRelays` default implementation queries the Repository directly:

```typescript
export const routerContext: RouterOptions = {
  getPubkeyRelays: (pubkey: string, mode?: RelayMode) => {
    return uniq(
      Repository.get()
        .query([{kinds: [RELAYS], authors: [pubkey]}])
        .flatMap(event => getRelaysFromList(readList(asDecryptedEvent(event)), mode)),
    )
  },
}
```

The `@welshman/app` package overrides this with a richer implementation that also handles `RelayMode.Blocked` (kind 10006) and `RelayMode.Messaging` (kind 10050):

```typescript
export const getPubkeyRelays = (pubkey: string, mode?: RelayMode) => {
  if (mode === RelayMode.Blocked) return getRelaysFromList(getBlockedRelayList(pubkey))
  if (mode === RelayMode.Messaging) return getRelaysFromList(getMessagingRelayList(pubkey))
  return getRelaysFromList(getRelayList(pubkey), mode)
}
```

---

## 8. Bootstrapping / Fallback Relays

### Coracle's environment configuration

**File**: `/tmp/outbox-research/coracle/.env.template`

```
VITE_DEFAULT_RELAYS=relay.damus.io,nos.lol
VITE_INDEXER_RELAYS=relay.damus.io,purplepag.es,indexer.coracle.social
VITE_SEARCH_RELAYS=nostr.wine,search.nos.today
VITE_SIGNER_RELAYS=relay.nsec.app,ephemeral.snowflare.cc,bucket.coracle.social
VITE_DVM_RELAYS=relay.nsec.app,ephemeral.snowflare.cc,bucket.coracle.social
```

### Router context configuration in Coracle

**File**: `/tmp/outbox-research/coracle/src/engine/state.ts`

```typescript
routerContext.getDefaultRelays = always(env.DEFAULT_RELAYS)
routerContext.getIndexerRelays = always(env.INDEXER_RELAYS)
routerContext.getSearchRelays = always(env.SEARCH_RELAYS)
routerContext.getLimit = () => getSetting("relay_limit")
```

### welshman/app default configuration (overridden by Coracle)

**File**: `/tmp/outbox-research/welshman/packages/app/src/index.ts`

The `@welshman/app` package sets up its own defaults which are more dynamic:

```typescript
const _relayGetter = (fn?) =>
  throttleWithValue(200, () => {
    let _relays = getRelays()
    if (fn) _relays = _relays.filter(fn)
    return sortBy(r => -getRelayQuality(r.url), _relays)
      .slice(0, 5)
      .map(r => r.url)
  })

routerContext.getDefaultRelays = _relayGetter()
routerContext.getIndexerRelays = _relayGetter()
routerContext.getSearchRelays = _relayGetter(r => r?.supported_nips?.includes?.("50"))
```

These use all known relays sorted by quality, capped at 5. But Coracle overrides these with static lists from the env.

### Bootstrap sequence

At startup, Coracle loads relay info for all initial relays:

```typescript
const initialRelays = [
  ...env.DEFAULT_RELAYS,
  ...env.DVM_RELAYS,
  ...env.INDEXER_RELAYS,
  ...env.SEARCH_RELAYS,
]

ready.then(() => Promise.all(initialRelays.map(url => loadRelay(url))))
```

`loadRelay` fetches the NIP-11 relay information document for each URL.

---

## 9. Connection Pooling / Management

### Pool (singleton)

**File**: `/tmp/outbox-research/welshman/packages/net/src/pool.ts`

```typescript
export class Pool {
  _data = new Map<string, Socket>()

  static get() {
    if (!poolSingleton) poolSingleton = new Pool()
    return poolSingleton
  }

  get(_url: string): Socket {
    const url = normalizeRelayUrl(_url)
    const socket = this._data.get(url)
    if (socket) return socket

    const newSocket = this.makeSocket(url)
    this._data.set(url, newSocket)
    for (const cb of this._subs) cb(newSocket)
    return newSocket
  }
}
```

Sockets are created lazily when first requested and cached indefinitely in the pool. The pool notifies subscribers when new sockets are created (used by `@welshman/app` to attach stat tracking and event handling).

### Socket policies

**File**: `/tmp/outbox-research/welshman/packages/net/src/policy.ts`

Four default policies are applied to every socket:

1. **`socketPolicyPing`**: Sends a `["PING"]` every 30 seconds if no activity, to detect broken connections.

2. **`socketPolicyAuthBuffer`**: Buffers outgoing messages while NIP-42 auth is in progress. When auth succeeds, replays buffered messages. When `auth-required` CLOSED/OK responses come back during auth, suppresses them from the caller.

3. **`socketPolicyConnectOnSend`**: Auto-opens the WebSocket when a message is sent, unless there was an error in the last 5 seconds. This is the lazy-connect mechanism.

   ```typescript
   on(socket, SocketEvent.Sending, (message) => {
     const isClosed = [SocketStatus.Closed, SocketStatus.Error].includes(socket.status)
     if (isClosed && lastError < ago(5)) {
       socket.open()
     }
   })
   ```

4. **`socketPolicyCloseInactive`**: Auto-closes sockets after 30 seconds of inactivity with no pending requests. If a socket closes unexpectedly while requests are pending, reopens it (with a 5-second anti-flap delay) and replays pending messages with `since` timestamps to avoid re-downloading.

   ```typescript
   const interval = setInterval(() => {
     if (socket.status === SocketStatus.Open && lastActivity < ago(30) && pending.size === 0) {
       socket.close()
     }
   }, 3000)
   ```

### Auth flow

**File**: `/tmp/outbox-research/welshman/packages/net/src/auth.ts`

The `AuthState` class tracks the NIP-42 authentication state machine:
- `None` -> `Requested` (relay sends AUTH challenge)
- `Requested` -> `PendingSignature` (user prompted to sign)
- `PendingSignature` -> `PendingResponse` (signed AUTH sent to relay)
- `PendingResponse` -> `Ok` or `Forbidden`

Coracle configures auto-authentication:

```typescript
defaultSocketPolicies.push(
  makeSocketPolicyAuth({
    sign: (event) => signer.get()?.sign(event),
    shouldAuth: (socket) => autoAuthenticate,  // from user setting auto_authenticate2
  }),
)
```

### Adapter layer

**File**: `/tmp/outbox-research/welshman/packages/net/src/adapter.ts`

The adapter layer abstracts different relay backends:

- **`SocketAdapter`**: Wraps a real WebSocket via `Pool.get(url)`
- **`LocalAdapter`**: Queries the in-memory `Repository` directly (used for `LOCAL_RELAY_URL`)
- **`MockAdapter`**: For testing

The `getAdapter` function selects the right adapter:

```typescript
export const getAdapter = (url: string, context?) => {
  if (url === LOCAL_RELAY_URL) return new LocalAdapter(context.repository)
  if (isRelayUrl(url)) return new SocketAdapter(context.pool.get(url))
  throw new Error(`Invalid relay url ${url}`)
}
```

### Event tracking

**File**: `/tmp/outbox-research/welshman/packages/net/src/tracker.ts`

The `Tracker` maintains bidirectional maps: `eventId -> Set<relay>` and `relay -> Set<eventId>`. This enables:
- Deduplication: `tracker.track(eventId, relay)` returns `true` if the event was already seen
- Provenance: knowing which relays have a given event

The tracker is persisted to IndexedDB in Coracle via `TrackerStorageAdapter`.

### Request batching (Loader)

**File**: `/tmp/outbox-research/welshman/packages/net/src/request.ts`

The `makeLoader` function creates a batching loader that:
1. Delays requests by a configurable amount (default 200ms)
2. Groups requests by relay
3. Unions filters for the same relay into a single REQ
4. Can return early based on filter cardinality (e.g., `limit: 1` returns after first event)

```typescript
export const load = makeLoader({delay: 200, timeout: 3000, threshold: 0.5})
```

The default `load` has a 3-second timeout and a 0.5 threshold (returns after 50% of relays respond).

---

## 10. Negentropy Sync Support

**File**: `/tmp/outbox-research/welshman/packages/app/src/sync.ts`

The system supports NIP-77 negentropy-based reconciliation for efficient sync:

```typescript
export const hasNegentropy = (url: string) => {
  const relay = getRelay(url)
  if (relay?.negentropy) return true
  if (relay?.supported_nips?.includes?.("77")) return true
  if (relay?.software?.includes?.("strfry") && !relay?.version?.match(/^0\./)) return true
  return false
}
```

Coracle's `pullConservatively` partitions relays into negentropy-capable and non-capable, using full negentropy sync for the former and capped requests for the latter.

---

## Key Observations

1. **No explicit "gossip" protocol**: The system does not implement a gossip/rumor-based relay discovery protocol. It relies entirely on kind 10002 relay lists fetched from indexer relays and the outbox model.

2. **Stochastic relay selection**: The `Math.random()` in the scoring formula means relay selection is non-deterministic. Two identical queries may go to different relay sets.

3. **Quality as a hard gate**: Relays with quality 0 (blocked, recent errors) are completely excluded from selection -- they don't just get lower priority, they get filtered out entirely (since `0 * log(weight) * random() = 0` which is falsy and gets filtered).

4. **No connection limit**: There is no hard cap on the total number of concurrent WebSocket connections. The pool grows indefinitely. The `relay_limit` only controls how many relays are selected per routing scenario, not total connections.

5. **Local cache as first-class relay**: The `LOCAL_RELAY_URL` adapter means every request also checks the local Repository, providing instant results for cached data.

6. **Publish confirmation tracking**: The `Thunk` system tracks publish results per-relay and removes tracker entries for relays that fail, maintaining accurate provenance data.
