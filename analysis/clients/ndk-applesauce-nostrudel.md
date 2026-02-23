# NDK, Applesauce, and noStrudel: Outbox Implementation Analysis

## Key Differences

| Aspect | NDK | Applesauce | noStrudel |
|--------|-----|------------|-----------|
| Outbox default | Enabled by default | Opt-in via helper functions | Always uses Applesauce |
| Relay selection | Popularity ranking + greedy | Set-cover algorithm | Applesauce set-cover + health filtering |
| Kind 10002 fetch | Outbox pool (purplepag.es, nos.lol) + cache | Reactive via EventStore | Uses Applesauce EventStore |
| Connection mgmt | Temporary relays with 30s auto-disconnect | RelayPool with lazy creation | Single RelayPool + RelayLiveness health |
| Relay goal/author | Default 2 | Configurable `maxRelaysPerUser` | Default 5, user-adjustable |
| Max total relays | No hard cap (prefers connected) | Configurable `maxConnections` | Default 20, user-adjustable |
| Fallback relays | Pool's permanent + connected relays | Configurable fallbacks | relay.primal.net, relay.damus.io |
| Reactivity | Imperative (LRU cache + manual refresh) | RxJS observables, auto re-runs | RxJS via Applesauce |
| Developer effort | Zero -- any `subscribe()` with authors gets outbox | Explicit composition required | Demonstrates Applesauce composition |

### Key Findings

- **NDK** prioritizes reusing existing connections over minimizing total connections. No hard cap on relay count.
- **Applesauce** has the most formally correct relay selection (set-cover), but has a **bug**: `maxRelaysPerUser` is effectively unenforced due to a post-increment error.
- **noStrudel** adds a debug UI showing per-relay coverage stats, with color-coded indicators (green >= 80%, yellow >= 50%, red < 50%).

---

## 1. NDK

Outbox enabled by default. Any app calling `ndk.subscribe()` with author filters gets outbox routing without code changes.

### Initialization and Auto-Refresh

**File:** `/tmp/outbox-research/ndk/core/src/ndk/index.ts`

```typescript
export const DEFAULT_OUTBOX_RELAYS = ["wss://purplepag.es/", "wss://nos.lol/"];

// In constructor:
if (!(opts.enableOutboxModel === false)) {
    this.outboxPool = new NDKPool(opts.outboxRelayUrls || DEFAULT_OUTBOX_RELAYS, this, {
        debug: this.debug.extend("outbox-pool"),
        name: "Outbox Pool",
    });

    this.outboxTracker = new OutboxTracker(this);

    // When an outbox relay list updates, refresh all affected subscriptions
    this.outboxTracker.on("user:relay-list-updated", (pubkey, _outboxItem) => {
        for (const subscription of this.subManager.subscriptions.values()) {
            const isRelevant = subscription.filters.some((filter) => filter.authors?.includes(pubkey));
            if (isRelevant && typeof subscription.refreshRelayConnections === "function") {
                subscription.refreshRelayConnections();
            }
        }
    });
}
```

When any subscription has an `authors` filter, NDK automatically tracks those authors in the outbox tracker. The `OutboxTracker` fetches kind 10002 (kind 3 as fallback) in batches of 400, stores in an LRU cache (100K entries, 2-minute TTL).

### Core Relay Selection: `chooseRelayCombinationForPubkeys`

**File:** `/tmp/outbox-research/ndk/core/src/outbox/index.ts`

```typescript
export function chooseRelayCombinationForPubkeys(
    ndk: NDK,
    pubkeys: Hexpubkey[],
    type: "write" | "read",
    { count, preferredRelays }: { count?: number; preferredRelays?: Set<WebSocket["url"]> } = {},
): Map<WebSocket["url"], Hexpubkey[]> {
    count ??= 2; // default: 2 relays per author

    connectedRelays.forEach((relay) => preferredRelays?.add(relay.url));

    const { pubkeysToRelays, authorsMissingRelays } = getAllRelaysForAllPubkeys(ndk, pubkeys, type);

    // Sort relays by popularity (how many authors write to them)
    const sortedRelays = getTopRelaysForAuthors(ndk, pubkeys);

    for (const [author, authorRelays] of pubkeysToRelays.entries()) {
        let missingRelayCount = count;

        // Priority 1: Already-connected relays
        for (const relay of connectedRelays) {
            if (authorRelays.has(relay.url)) {
                addAuthorToRelay(author, relay.url);
                missingRelayCount--;
            }
        }

        // Priority 2: Relays already selected for other authors (connection reuse)
        for (const authorRelay of authorRelays) {
            if (relayToAuthorsMap.has(authorRelay)) {
                addAuthorToRelay(author, authorRelay);
                missingRelayCount--;
            }
        }

        // Priority 3: Popularity-ranked relays
        for (const relay of sortedRelays) {
            if (missingRelayCount <= 0) break;
            if (authorRelays.has(relay)) {
                addAuthorToRelay(author, relay);
                missingRelayCount--;
            }
        }
    }

    // Authors with no known relays: use pool's permanent/connected relays
    for (const author of authorsMissingRelays) {
        pool.permanentAndConnectedRelays().forEach((relay) => {
            relayToAuthorsMap.get(relay.url)?.push(author);
        });
    }

    return relayToAuthorsMap;
}
```

Relay ranking counts how many authors from the set write to each relay, sorts descending.

### Publishing

**File:** `/tmp/outbox-research/ndk/core/src/relay/sets/calculate.ts`

Publish relay set combines:
1. Author's own write relays
2. Relay hints from `e`/`a` tags (up to 5)
3. Read relays of p-tagged users (if fewer than 5 p-tags)
4. Pool's permanent and connected relays

### Connection Management

**File:** `/tmp/outbox-research/ndk/core/src/relay/pool/index.ts`

- **Temporary relays**: Outbox-discovered relays auto-disconnect after 30s of non-use
- **Connection filtering**: `relayConnectionFilter` callback can block specific relays
- **Flapping detection**: Exponential backoff for relays that keep disconnecting
- **System-wide disconnect detection**: If >50% of relays disconnect within 5s, triggers coordinated reconnection with reset backoff (handles sleep/wake)

### Filter Splitting

Each relay gets only the subset of authors whose outbox relays include that relay. Relay A gets `{authors: [alice, bob]}`, relay B gets `{authors: [bob, carol]}` -- bob appears on both if he writes to both.

---

## 2. Applesauce

Modular RxJS-based library. Relay selection is a pure function composable into observable pipelines.

### Core Algorithm: Greedy Set-Cover

**File:** `/tmp/outbox-research/applesauce/packages/core/src/helpers/relay-selection.ts`

```typescript
export function selectOptimalRelays(
  users: ProfilePointer[],
  { maxConnections, maxRelaysPerUser, score }: SelectOptimalRelaysOptions,
): ProfilePointer[] {
  const usersWithRelays = users.filter((user) => user.relays && user.relays.length > 0);

  // Build popularity map
  const popular = new Map<string, number>();
  for (const user of usersWithRelays) {
    for (const relay of user.relays) popular.set(relay, (popular.get(relay) || 0) + 1);
  }

  // Greedy set-cover loop
  let selectionPool = Array.from(usersWithRelays);
  const selectionCount = new Map<string, number>();
  let selection = new Set<string>();

  while (selectionPool.length > 0 && selection.size < maxConnections) {
    const relayCoverage = new Map<string, number>();
    for (const user of selectionPool) {
      for (const relay of user.relays) {
        if (selection.has(relay)) continue;
        relayCoverage.set(relay, (relayCoverage.get(relay) || 0) + 1);
      }
    }

    if (relayCoverage.size === 0) break;

    // Score: default is coverage/pool_size, custom score function supported
    const sorted = Array.from(relayCoverage.keys()).sort((a, b) => {
      const aCoverageScore = (relayCoverage.get(a) ?? 0) / selectionPool.length;
      const bCoverageScore = (relayCoverage.get(b) ?? 0) / selectionPool.length;
      const aScore = score ? score(a, aCoverageScore, popular.get(a) ?? 0) : aCoverageScore;
      const bScore = score ? score(b, bCoverageScore, popular.get(b) ?? 0) : bCoverageScore;
      return bScore - aScore;
    });

    const relay = sorted[0];
    selection.add(relay);

    // BUG: count++ is post-increment, so selectionCount stores pre-increment value.
    // maxRelaysPerUser is effectively unenforced.
    // Fix would be: selectionCount.set(user.pubkey, count + 1)
    if (maxRelaysPerUser) {
      selectionPool = selectionPool.filter((user) => {
        if (!user.relays || !user.relays.includes(relay)) return true;
        let count = selectionCount.get(user.pubkey) || 0;
        selectionCount.set(user.pubkey, count++);
        if (count >= maxRelaysPerUser) return false;
        return true;
      });
    }
  }

  return users.map((user) => ({
    ...user,
    relays: user.relays?.filter((relay) => selection.has(relay)),
  }));
}
```

Algorithm steps:
1. Build popularity map (users per relay)
2. Main loop (until all users covered or `maxConnections` reached): pick relay covering most uncovered users, recalculate coverage each iteration
3. Return users with relays filtered to selected set only

`maxConnections` directly caps total relays. A few popular relays cover most users, with diminishing returns after.

### Supplementary Functions

**File:** `/tmp/outbox-research/applesauce/packages/core/src/helpers/relay-selection.ts`

- `setFallbackRelays(users, fallbacks)`: assigns fallback relays to users with no relay list
- `removeBlacklistedRelays(users, blacklist)`: filters out blacklisted relays
- `groupPubkeysByRelay(pointers)`: creates the outbox map (relay -> users)

### Kind 10002 Processing

**File:** `/tmp/outbox-research/applesauce/packages/core/src/helpers/mailboxes.ts`

Parses kind 10002 into inbox (read) and outbox (write) sets. Tags with no marker treated as both. Results cached on event object using Symbols (parsed once).

### OutboxModel Composition

**File:** `/tmp/outbox-research/applesauce/packages/core/src/models/outbox.ts`

```typescript
export function OutboxModel(user, opts) {
  return (store) =>
    store.contacts(user).pipe(
      opts?.blacklist ? ignoreBlacklistedRelays(opts.blacklist) : identity,
      includeMailboxes(store, opts.type),
      map((users) => selectOptimalRelays(users, opts)),
    );
}
```

Chains: contacts -> blacklist filter -> mailbox enrichment -> optimal relay selection. Reactive: kind 10002 updates in the store trigger re-selection.

### Relay Health: `RelayLiveness`

**File:** `/tmp/outbox-research/applesauce/packages/relay/src/liveness.ts`

Three states: `online`, `offline`, `dead`.
- online -> offline (on failure) -> dead (after 5 failures)
- offline -> online (on success)
- dead: stays dead
- Exponential backoff: base 30s, max 5min
- `filter(relays)` removes dead relays and relays in backoff
- `ignoreUnhealthyRelaysOnPointers` operator filters unhealthy relays from ProfilePointer arrays reactively

---

## 3. noStrudel

Full Nostr client using Applesauce as its library layer. Adds configuration, caching, health tracking persistence, and debug UI.

### Configuration Defaults

**File:** `/tmp/outbox-research/nostrudel/src/const.ts`

```typescript
export const DEFAULT_MAX_CONNECTIONS = 20;
export const DEFAULT_MAX_RELAYS_PER_USER = 5;
export const DEFAULT_LOOKUP_RELAYS = ["wss://purplepag.es/"];
export const DEFAULT_FALLBACK_RELAYS = ["wss://relay.primal.net/", "wss://relay.damus.io/"];
```

### Pool Setup

**File:** `/tmp/outbox-research/nostrudel/src/services/pool.ts`

Single `RelayPool` with 60s keepAlive. `RelayLiveness` tracker persisted to localforage with 5s base backoff (vs Applesauce default 30s).

### Outbox Selection Pipeline

**File:** `/tmp/outbox-research/nostrudel/src/models/outbox-selection.ts`

```typescript
export function outboxSelection(): MonoTypeOperatorFunction<ProfilePointer[]> {
  return pipe(
    includeMailboxes(eventStore, "outbox"),
    includeFallbackRelays(localSettings.fallbackRelays),
    ignoreUnhealthyRelaysOnPointers(liveness),
    combineLatestWith(localSettings.maxConnections, localSettings.maxRelaysPerUser),
    debounceTime(500),  // Wait for relay data to stabilize
    map(([users, maxConnections, maxRelaysPerUser]) =>
      selectOptimalRelays(users, { maxConnections, maxRelaysPerUser }),
    ),
  );
}
```

The `debounceTime(500)` waits for kind 10002 events to arrive from multiple relays before running selection. All settings are reactive observables -- changing any setting triggers re-selection.

### Outbox Cache

**File:** `/tmp/outbox-research/nostrudel/src/services/outbox-cache.ts`

LRU cache of 30 outbox maps (relay-to-users mappings) to avoid recomputing.

### Debug UI

**Outbox Selection Settings** (`/tmp/outbox-research/nostrudel/src/views/settings/outbox-selection/index.tsx`):
- Max Connections slider (0-30, default 20)
- Max Relays Per User slider (0-30, default 5)
- Per-relay table: selected relays, user count per relay
- Users-by-relay-count breakdown
- Missing relay list users (no kind 10002)
- "Orphaned" users (had relays but none selected after optimization)

**Relay Selection Debugger** (`/tmp/outbox-research/nostrudel/src/components/outbox-relay-selection-modal.tsx`):
- Stats: selected relays, connected relays, coverage %, total users
- Coverage progress bar
- Per-relay table with user count, connection status, % of total
- Color-coded: green >= 80%, yellow >= 50%, red < 50%
