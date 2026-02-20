# NDK, Applesauce, and noStrudel: Outbox Implementation Analysis

## Summary

These three projects form a layered ecosystem for outbox model support in Nostr:

- **NDK** (by pablof7z) is a high-level SDK where outbox is enabled by default. It transparently routes subscriptions and publishes to the right relays based on users' kind 10002 relay lists, so any app built on NDK gets outbox routing "for free." Its relay selection uses a popularity-based ranking approach: count how many authors write to each relay, sort by that count, then greedily assign relays to authors.

- **Applesauce** (by hzrd149) is a modular library ecosystem built on RxJS observables. Its relay selection uses a **greedy set-cover algorithm** that iteratively picks the relay covering the most uncovered users, with configurable `maxConnections` and `maxRelaysPerUser` caps. This is mathematically closer to optimal minimum-connection relay selection.

- **noStrudel** (by hzrd149) is a full Nostr client that uses Applesauce as its library layer. It adds user-facing configuration (max connections slider, fallback relays), relay health tracking via the `RelayLiveness` class, and a debug UI showing coverage statistics per relay.

### Key architectural differences

| Aspect | NDK | Applesauce | noStrudel |
|--------|-----|------------|-----------|
| Outbox default | Enabled by default | Opt-in via helper functions | Always uses Applesauce |
| Relay selection | Popularity ranking + greedy | Set-cover algorithm | Applesauce set-cover + health filtering |
| Kind 10002 fetch | Fetches from outbox pool (purplepag.es, nos.lol) + cache | Subscribes reactively via EventStore | Uses Applesauce EventStore |
| Connection management | Temporary relays with auto-disconnect timers | RelayPool with lazy relay creation | Single RelayPool + RelayLiveness health tracker |
| Relay goal per author | Default 2 | Configurable `maxRelaysPerUser` | Default 5, user-adjustable |
| Max total relays | No hard cap (but prefers connected) | Configurable `maxConnections` | Default 20, user-adjustable |
| Fallback for missing relays | Pool's permanent + connected relays | Configurable fallback relays | relay.primal.net, relay.damus.io |

---

## 1. NDK

NDK's outbox model was the original motivation for creating the library. It is enabled by default (unless `enableOutboxModel: false` is passed) and works transparently for all subscriptions.

### 1.1 Initialization and outbox pool

When NDK is constructed, it automatically creates a separate "outbox pool" of relays used specifically for fetching kind 10002 relay lists, plus an `OutboxTracker` singleton.

**File:** `/tmp/outbox-research/ndk/core/src/ndk/index.ts` (lines 269, 450-472)

```typescript
export const DEFAULT_OUTBOX_RELAYS = ["wss://purplepag.es/", "wss://nos.lol/"];

// In constructor:
if (!(opts.enableOutboxModel === false)) {
    this.outboxPool = new NDKPool(opts.outboxRelayUrls || DEFAULT_OUTBOX_RELAYS, this, {
        debug: this.debug.extend("outbox-pool"),
        name: "Outbox Pool",
    });

    this.outboxTracker = new OutboxTracker(this);

    // Listen for outbox relay list updates and refresh affected subscriptions
    this.outboxTracker.on("user:relay-list-updated", (pubkey, _outboxItem) => {
        // Find all active subscriptions that include this author
        for (const subscription of this.subManager.subscriptions.values()) {
            const isRelevant = subscription.filters.some((filter) => filter.authors?.includes(pubkey));
            if (isRelevant && typeof subscription.refreshRelayConnections === "function") {
                subscription.refreshRelayConnections();
            }
        }
    });
}
```

Key design point: When an outbox relay list is updated for a pubkey, NDK automatically finds all active subscriptions involving that pubkey and calls `refreshRelayConnections()` to add the newly-discovered relays to the subscription.

### 1.2 How apps get outbox "for free"

When any subscription is created with an `authors` filter, NDK automatically tracks those authors in the outbox tracker:

**File:** `/tmp/outbox-research/ndk/core/src/ndk/index.ts` (lines 908-916)

```typescript
// if we have an authors filter and we are using the outbox pool,
// we want to track the authors in the outbox tracker
if (this.outboxPool && subscription.hasAuthorsFilter()) {
    const authors: string[] = subscription.filters
        .filter((filter) => filter.authors && filter.authors?.length > 0)
        .flatMap((filter) => filter.authors!);

    this.outboxTracker?.trackUsers(authors);
}
```

Then, when the subscription starts, if no explicit `relaySet` is provided, it automatically calculates relay sets from filters using outbox data:

**File:** `/tmp/outbox-research/ndk/core/src/subscription/index.ts` (lines 761-779)

```typescript
if (!this.relaySet || this.relaySet.relays.size === 0) {
    this.relayFilters = calculateRelaySetsFromFilters(
        this.ndk,
        filters,
        this.pool,
        this.opts.relayGoalPerAuthor,
    );
} else {
    this.relayFilters = new Map();
    for (const relay of this.relaySet.relays) {
        this.relayFilters.set(relay.url, filters);
    }
}
```

### 1.3 Kind 10002 processing and caching

The `OutboxTracker` fetches kind 10002 (and kind 3 as fallback) events, processes them into read/write relay sets, and stores them in an LRU cache.

**File:** `/tmp/outbox-research/ndk/core/src/outbox/tracker.ts`

```typescript
export class OutboxTracker extends EventEmitter {
    public data: LRUCache<Hexpubkey, OutboxItem>;

    constructor(ndk: NDK) {
        this.data = new LRUCache({
            maxSize: 100000,
            entryExpirationTimeInMS: 2 * 60 * 1000, // 2 minute TTL
        });
    }

    async trackUsers(items: NDKUser[] | Hexpubkey[], skipCache = false) {
        // Batched in groups of 400
        for (let i = 0; i < items.length; i += 400) {
            const slice = items.slice(i, i + 400);
            const pubkeys = slice.map(getKeyFromItem).filter((pk) => !this.data.has(pk));

            // Put placeholder for all items
            for (const pubkey of pubkeys) {
                this.data.set(pubkey, new OutboxItem("user"));
            }

            getRelayListForUsers(pubkeys, this.ndk, skipCache, 1000, relayHints)
                .then((relayLists) => {
                    for (const [pubkey, relayList] of relayLists) {
                        let outboxItem = this.data.get(pubkey)!;
                        outboxItem.readRelays = new Set(normalize(relayList.readRelayUrls));
                        outboxItem.writeRelays = new Set(normalize(relayList.writeRelayUrls));

                        // Remove blocked relays
                        if (this.ndk.relayConnectionFilter) {
                            for (const relayUrl of outboxItem.readRelays) {
                                if (!this.ndk.relayConnectionFilter(relayUrl)) {
                                    outboxItem.readRelays.delete(relayUrl);
                                }
                            }
                        }

                        this.emit("user:relay-list-updated", pubkey, outboxItem);
                    }
                });
        }
    }
}
```

The relay list fetcher tries kind 10002 first, falls back to kind 3 (contacts list) content parsing:

**File:** `/tmp/outbox-research/ndk/core/src/utils/get-users-relay-list.ts`

The function `getRelayListForUsers` first checks the cache for kind 3 and 10002 events, then queries the outbox pool (or main pool) for any missing pubkeys. Kind 10002 takes priority; kind 3 is only used as fallback.

**File:** `/tmp/outbox-research/ndk/core/src/events/kinds/relay-list.ts`

The `NDKRelayList` class parses kind 10002 `r` tags, differentiating between read (no marker or `read` marker) and write (no marker or `write` marker):

```typescript
get readRelayUrls(): WebSocket["url"][] {
    return this.tags
        .filter((tag) => tag[0] === "r" || tag[0] === "relay")
        .filter((tag) => !tag[2] || (tag[2] && tag[2] === READ_MARKER))
        .map((tag) => tryNormalizeRelayUrl(tag[1]))
        .filter((url) => !!url);
}

get writeRelayUrls(): WebSocket["url"][] {
    return this.tags
        .filter((tag) => tag[0] === "r" || tag[0] === "relay")
        .filter((tag) => !tag[2] || (tag[2] && tag[2] === WRITE_MARKER))
        .map((tag) => tryNormalizeRelayUrl(tag[1]))
        .filter((url) => !!url);
}
```

Note: Tags with no marker (bare `["r", "wss://..."]`) are treated as BOTH read AND write.

### 1.4 Core relay routing logic: `chooseRelayCombinationForPubkeys`

This is the heart of NDK's outbox relay selection.

**File:** `/tmp/outbox-research/ndk/core/src/outbox/index.ts`

```typescript
export function chooseRelayCombinationForPubkeys(
    ndk: NDK,
    pubkeys: Hexpubkey[],
    type: "write" | "read",
    { count, preferredRelays }: { count?: number; preferredRelays?: Set<WebSocket["url"]> } = {},
): Map<WebSocket["url"], Hexpubkey[]> {
    count ??= 2; // default: 2 relays per author

    // Add already-connected relays to preferred set
    connectedRelays.forEach((relay) => preferredRelays?.add(relay.url));

    // Get all relays for all pubkeys from outbox tracker
    const { pubkeysToRelays, authorsMissingRelays } = getAllRelaysForAllPubkeys(ndk, pubkeys, type);

    // Sort relays by popularity (how many authors write to them)
    const sortedRelays = getTopRelaysForAuthors(ndk, pubkeys);

    // For each author with known relays:
    for (const [author, authorRelays] of pubkeysToRelays.entries()) {
        let missingRelayCount = count;

        // Priority 1: Use relays we're already connected to
        for (const relay of connectedRelays) {
            if (authorRelays.has(relay.url)) {
                addAuthorToRelay(author, relay.url);
                missingRelayCount--;
            }
        }

        // Priority 2: Use relays already selected for other authors (connection reuse)
        for (const authorRelay of authorRelays) {
            if (relayToAuthorsMap.has(authorRelay)) {
                addAuthorToRelay(author, authorRelay);
                missingRelayCount--;
            }
        }

        // Priority 3: Use relays sorted by global popularity
        for (const relay of sortedRelays) {
            if (missingRelayCount <= 0) break;
            if (authorRelays.has(relay)) {
                addAuthorToRelay(author, relay);
                missingRelayCount--;
            }
        }
    }

    // For authors with no known relays: use pool's permanent/connected relays
    for (const author of authorsMissingRelays) {
        pool.permanentAndConnectedRelays().forEach((relay) => {
            relayToAuthorsMap.get(relay.url)?.push(author);
        });
    }

    return relayToAuthorsMap;
}
```

The relay ranking function is straightforward -- it counts how many authors from the set write to each relay:

**File:** `/tmp/outbox-research/ndk/core/src/outbox/relay-ranking.ts`

```typescript
export function getTopRelaysForAuthors(ndk: NDK, authors: Hexpubkey[]): WebSocket["url"][] {
    const relaysWithCount = new Map<WebSocket["url"], number>();
    authors.forEach((author) => {
        const writeRelays = getRelaysForSync(ndk, author);
        if (writeRelays) {
            writeRelays.forEach((relay) => {
                relaysWithCount.set(relay, (relaysWithCount.get(relay) || 0) + 1);
            });
        }
    });
    return Array.from(relaysWithCount.entries())
        .sort((a, b) => b[1] - a[1])
        .map((entry) => entry[0]);
}
```

### 1.5 Publishing with outbox awareness

When publishing, NDK calculates the relay set by combining:
1. The author's own write relays
2. Relay hints from `e` and `a` tags (up to 5)
3. Read relays of p-tagged users (if fewer than 5 p-tags)
4. Pool's permanent and connected relays
5. Explicit relay URLs as fallback

**File:** `/tmp/outbox-research/ndk/core/src/relay/sets/calculate.ts`

```typescript
export async function calculateRelaySetFromEvent(ndk, event, requiredRelayCount) {
    const relays: Set<NDKRelay> = new Set();

    // 1. Author's write relays
    const authorWriteRelays = await getWriteRelaysFor(ndk, event.pubkey);

    // 2. Relay hints from e/a tags
    let relayHints = event.tags
        .filter((tag) => ["a", "e"].includes(tag[0]))
        .map((tag) => tag[2])
        .filter((url) => url?.startsWith("wss://"));

    // 3. P-tagged users' read relays (for <5 p-tags)
    if (pTags.length < 5) {
        const pTaggedRelays = chooseRelayCombinationForPubkeys(ndk, pTags, "read", {
            preferredRelays: new Set(authorWriteRelays),
        });
    }

    // 4. Pool's permanent relays
    ndk.pool?.permanentAndConnectedRelays().forEach((relay) => relays.add(relay));

    return new NDKRelaySet(relays, ndk);
}
```

### 1.6 Connection management and pooling

NDK's `NDKPool` manages relay connections with several notable features:

**File:** `/tmp/outbox-research/ndk/core/src/relay/pool/index.ts`

- **Temporary relays**: Relays discovered via outbox routing are added as temporary with `useTemporaryRelay(relay, removeIfUnusedAfter=30000)`. They auto-disconnect after 30 seconds of non-use.
- **Connection filtering**: `relayConnectionFilter` callback can block connections to specific relays.
- **Flapping detection**: Exponential backoff for relays that keep disconnecting.
- **System-wide disconnection detection**: If >50% of relays disconnect within 5 seconds, it triggers a coordinated reconnection with reset backoff (handles sleep/wake, network changes).
- **Delayed connect**: Cache adapter can provide `dontConnectBefore` timestamp to throttle reconnection attempts to known-bad relays.

### 1.7 Subscription filter splitting

When a subscription has authors, NDK splits the filter into per-relay filters, sending each relay only the subset of authors whose outbox relays include that relay:

**File:** `/tmp/outbox-research/ndk/core/src/relay/sets/calculate.ts` (lines 114-185)

```typescript
export function calculateRelaySetsFromFilter(ndk, filters, pool, relayGoalPerAuthor) {
    // For filters with authors:
    const authorToRelaysMap = getRelaysForFilterWithAuthors(ndk, Array.from(authors), relayGoalPerAuthor);

    for (const filter of filters) {
        if (filter.authors) {
            for (const [relayUrl, relayAuthors] of authorToRelaysMap.entries()) {
                // Intersect filter.authors with the authors assigned to this relay
                const intersection = filter.authors.filter((a) => relayAuthors.includes(a));
                result.set(relayUrl, [...result.get(relayUrl)!, { ...filter, authors: intersection }]);
            }
        }
    }
}
```

This means relay A might get `{authors: [alice, bob], kinds: [1]}` while relay B gets `{authors: [bob, carol], kinds: [1]}`, with bob appearing on both if he writes to both relays.

### 1.8 Late-arriving outbox data

NDK handles the case where outbox data arrives after a subscription has already started. The `refreshRelayConnections` method on subscriptions adds new relay connections without disturbing existing ones:

**File:** `/tmp/outbox-research/ndk/core/src/subscription/index.ts` (lines 787-812)

```typescript
public refreshRelayConnections(): void {
    if (this.relaySet && this.relaySet.relays.size > 0) return;

    const updatedRelaySets = calculateRelaySetsFromFilters(this.ndk, this.filters, this.pool, ...);

    for (const [relayUrl, filters] of updatedRelaySets) {
        if (!this.relayFilters?.has(relayUrl)) {
            this.relayFilters?.set(relayUrl, filters);
            const relay = this.pool.getRelay(relayUrl, true, true, filters);
            relay.subscribe(this, filters);
        }
    }
}
```

---

## 2. Applesauce

Applesauce takes a fundamentally different architectural approach: it is a collection of modular RxJS-based packages where relay selection is a pure function that can be composed into observable pipelines.

### 2.1 The greedy set-cover relay selection algorithm

This is the core algorithm. It is a pure function that takes an array of `ProfilePointer` objects (each with a pubkey and a list of relays) and returns the same array with relays filtered to only include the "selected" optimal set.

**File:** `/tmp/outbox-research/applesauce/packages/core/src/helpers/relay-selection.ts`

```typescript
export function selectOptimalRelays(
  users: ProfilePointer[],
  { maxConnections, maxRelaysPerUser, score }: SelectOptimalRelaysOptions,
): ProfilePointer[] {
  const usersWithRelays = users.filter((user) => user.relays && user.relays.length > 0);

  // Step 1: Build popularity map (how many users use each relay)
  const popular = new Map<string, number>();
  for (const user of usersWithRelays) {
    for (const relay of user.relays) popular.set(relay, (popular.get(relay) || 0) + 1);
  }

  // Step 2: Greedy set-cover loop
  let selectionPool = Array.from(usersWithRelays);
  const selectionCount = new Map<string, number>();
  let selection = new Set<string>();

  while (selectionPool.length > 0 && selection.size < maxConnections) {
    // Calculate coverage: how many pool users each unselected relay covers
    const relayCoverage = new Map<string, number>();
    for (const user of selectionPool) {
      for (const relay of user.relays) {
        if (selection.has(relay)) continue; // skip already-selected
        relayCoverage.set(relay, (relayCoverage.get(relay) || 0) + 1);
      }
    }

    if (relayCoverage.size === 0) break;

    // Sort by score (default: coverage ratio = covered_users / pool_size)
    const sorted = Array.from(relayCoverage.keys()).sort((a, b) => {
      const aCoverageScore = (relayCoverage.get(a) ?? 0) / selectionPool.length;
      const bCoverageScore = (relayCoverage.get(b) ?? 0) / selectionPool.length;
      const aScore = score ? score(a, aCoverageScore, popular.get(a) ?? 0) : aCoverageScore;
      const bScore = score ? score(b, bCoverageScore, popular.get(b) ?? 0) : bCoverageScore;
      return bScore - aScore;
    });

    // Pick the best relay
    const relay = sorted[0];
    selection.add(relay);

    // Remove users who have hit their maxRelaysPerUser limit
    // NOTE: Bug in upstream Applesauce — count++ is post-increment, so
    // selectionCount stores the pre-increment value. The check
    // `count >= maxRelaysPerUser` never triggers for values >= 2,
    // meaning maxRelaysPerUser is effectively unenforced.
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

  // Return users with relays filtered to only selected relays
  return users.map((user) => ({
    ...user,
    relays: user.relays?.filter((relay) => selection.has(relay)),
  }));
}
```

**Algorithm walkthrough:**

1. **Build popularity map**: Count how many users list each relay.
2. **Main loop** (until all users covered or `maxConnections` reached):
   a. For each relay not yet selected, count how many users in the remaining pool use it (coverage).
   b. Score each relay. Default scoring is `coverage / pool_size`. A custom `score` function can incorporate relay popularity.
   c. Select the highest-scoring relay.
   d. If `maxRelaysPerUser` is set, remove users from the pool once enough of their relays have been selected.
3. **Return** users with relays filtered to only the selected set.

This is a variant of the greedy weighted set cover algorithm. The key insight: by recalculating coverage at each step (not just at the start), it adapts to the evolving uncovered set. The `maxRelaysPerUser` parameter prevents one user from being covered by too many relays (wasting connections).

### 2.2 How it minimizes total connections

The `maxConnections` parameter directly caps the number of relays selected. With default noStrudel settings:
- `maxConnections = 20`
- `maxRelaysPerUser = 5`

The algorithm will select at most 20 relays total. The greedy set-cover approach ensures these 20 are the ones covering the most users. In practice, a few popular relays (relay.damus.io, nos.lol, relay.primal.net) cover the majority of users, so the first few selections give high coverage, with diminishing returns for later selections.

The reported ~30 connections for 311 pubkeys would use a higher `maxConnections` setting. The algorithm efficiently identifies that a small number of relays covers most users.

### 2.3 Supplementary functions

**File:** `/tmp/outbox-research/applesauce/packages/core/src/helpers/relay-selection.ts`

```typescript
// Set fallback relays for users with no relay list
export function setFallbackRelays(users: ProfilePointer[], fallbacks: string[]): ProfilePointer[] {
  return users.map((user) => {
    if (!user.relays || user.relays.length === 0) return { ...user, relays: fallbacks };
    else return user;
  });
}

// Remove blacklisted relays
export function removeBlacklistedRelays(users: ProfilePointer[], blacklist: string[]): ProfilePointer[] {
  return users.map((user) => ({
    ...user,
    relays: user.relays?.filter((relay) => !blacklist.includes(relay))
  }));
}

// Group users by relay (creates the "outbox map")
export function groupPubkeysByRelay(pointers: ProfilePointer[]): OutboxMap {
  const outbox: OutboxMap = {};
  for (const pointer of pointers) {
    if (!pointer.relays) continue;
    for (const relay of pointer.relays) {
      if (!outbox[relay]) outbox[relay] = [];
      outbox[relay]!.push(pointer);
    }
  }
  return outbox;
}
```

### 2.4 Kind 10002 processing (mailboxes)

Applesauce parses kind 10002 events into inbox (read) and outbox (write) relay sets:

**File:** `/tmp/outbox-research/applesauce/packages/core/src/helpers/mailboxes.ts`

```typescript
export function getInboxes(event: NostrEvent): string[] {
  return getOrComputeCachedValue(event, MailboxesInboxesSymbol, () => {
    const inboxes: string[] = [];
    for (const tag of event.tags) {
      if (!isRTag(tag)) continue;
      const [, url, mode] = tag;
      if (url && isSafeRelayURL(url) && (mode === "read" || mode === undefined)) {
        inboxes.push(normalizeURL(url));
      }
    }
    return inboxes;
  });
}

export function getOutboxes(event: NostrEvent): string[] {
  return getOrComputeCachedValue(event, MailboxesOutboxesSymbol, () => {
    const outboxes: string[] = [];
    for (const tag of event.tags) {
      if (!isRTag(tag)) continue;
      const [name, url, mode] = tag;
      if (name === "r" && isSafeRelayURL(url) && (mode === "write" || mode === undefined)) {
        outboxes.push(normalizeURL(url));
      }
    }
    return outboxes;
  });
}
```

Results are cached on the event object using Symbols, so parsing only happens once per event.

### 2.5 RxJS observable pipeline

The `includeMailboxes` operator subscribes to kind 10002 events from the EventStore and enriches ProfilePointers with relay URLs:

**File:** `/tmp/outbox-research/applesauce/packages/core/src/observable/relay-selection.ts`

```typescript
export function includeMailboxes(store, type = "outbox") {
  return switchMap((contacts) =>
    combineLatest(
      contacts.map((user) =>
        store.replaceable({ kind: 10002, pubkey: user.pubkey }).pipe(
          map((event) => {
            if (!event) return user;
            const relays = type === "outbox" ? getOutboxes(event) : getInboxes(event);
            return addRelayHintsToPointer(user, relays);
          }),
        ),
      ),
    ),
  );
}
```

This is reactive: if a kind 10002 event is updated in the store, the pipeline re-emits with updated relay URLs, which can trigger re-selection.

### 2.6 The OutboxModel

A composable model that chains: contacts -> blacklist filter -> mailbox enrichment -> optimal relay selection.

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

### 2.7 Connection management

Applesauce's `RelayPool` is simpler than NDK's -- it lazily creates relays on demand and provides a reactive API:

**File:** `/tmp/outbox-research/applesauce/packages/relay/src/pool.ts`

```typescript
export class RelayPool implements IPool {
  relays$ = new BehaviorSubject<Map<string, Relay>>(new Map());

  relay(url: string): Relay {
    url = normalizeURL(url);
    let relay = this.relays.get(url);
    if (relay) return relay;
    relay = new Relay(url, this.options);
    this.relays.set(url, relay);
    this.relays$.next(this.relays);
    return relay;
  }

  // Key method: outbox-aware subscription
  outboxSubscription(outboxes, filter, options) {
    const filterMap = isObservable(outboxes)
      ? outboxes.pipe(map((outboxes) => createFilterMap(outboxes, filter)))
      : createFilterMap(outboxes, filter);
    return this.subscriptionMap(filterMap, options);
  }
}
```

The `outboxSubscription` method takes an `OutboxMap` (relay -> users mapping) and a filter template, then creates per-relay filters with the appropriate authors for each relay. When the `OutboxMap` is an observable, the subscriptions update reactively.

### 2.8 Relay health tracking (RelayLiveness)

**File:** `/tmp/outbox-research/applesauce/packages/relay/src/liveness.ts`

A sophisticated health tracking system with three states: `online`, `offline`, `dead`.

```typescript
export class RelayLiveness {
  // State machine:
  // online -> offline (on failure) -> dead (after maxFailuresBeforeDead failures)
  // offline -> online (on success)
  // dead: stays dead (ignored even on success)

  // Exponential backoff: baseDelay * 2^(failureCount-1), capped at maxDelay
  // Default: base=30s, max=5min, dead after 5 failures

  // Filtering removes dead relays and relays in backoff period
  filter(relays: string[]): string[] { ... }

  // Observables for downstream consumption
  healthy$: Observable<string[]>; // online OR (offline AND not in backoff)
  unhealthy$: Observable<string[]>; // dead OR (offline AND in backoff)

  // Connects to pool for automatic tracking
  connectToPool(pool) {
    pool.add$.subscribe((relay) => {
      relay.open$.subscribe(() => this.recordSuccess(relay.url));
      relay.close$.subscribe((event) => {
        if (event.wasClean === false) this.recordFailure(relay.url);
      });
    });
  }
}
```

The `ignoreUnhealthyRelaysOnPointers` operator filters unhealthy relays out of ProfilePointer arrays reactively:

**File:** `/tmp/outbox-research/applesauce/packages/relay/src/operators/liveness.ts`

```typescript
export function ignoreUnhealthyRelaysOnPointers(liveness) {
  return (source) =>
    source.pipe(
      combineLatestWith(liveness.unhealthy$),
      map(([pointers, unhealthy]) =>
        pointers.map((pointer) => ({
          ...pointer,
          relays: pointer.relays?.filter((relay) => !unhealthy.includes(relay))
        })),
      ),
    );
}
```

---

## 3. noStrudel

noStrudel is a full Nostr client that uses Applesauce as its library layer. It adds configuration, caching, and UI on top.

### 3.1 Pool setup

**File:** `/tmp/outbox-research/nostrudel/src/services/pool.ts`

```typescript
const pool = new RelayPool({ keepAlive: 60_000 });

export const liveness = new RelayLiveness({
  backoffBaseDelay: 5000,  // 5 second base backoff (vs Applesauce default 30s)
  storage: localforage.createInstance({ name: "liveness" }),
});
liveness.load();
liveness.connectToPool(pool);
```

noStrudel uses a single `RelayPool` instance shared across the entire app, with a `RelayLiveness` tracker that persists relay health data to localforage.

### 3.2 Outbox selection pipeline

The `outboxSelection()` function chains Applesauce operators to create the full outbox pipeline:

**File:** `/tmp/outbox-research/nostrudel/src/models/outbox-selection.ts`

```typescript
export function includeOutboxRelays(): MonoTypeOperatorFunction<ProfilePointer[]> {
  return pipe(
    includeMailboxes(eventStore, "outbox"),     // Add outbox relays from kind 10002
    includeFallbackRelays(localSettings.fallbackRelays),  // Add fallbacks for users with no relays
    ignoreUnhealthyRelaysOnPointers(liveness),  // Remove dead/backing-off relays
  );
}

export function outboxSelection(): MonoTypeOperatorFunction<ProfilePointer[]> {
  return pipe(
    includeOutboxRelays(),
    combineLatestWith(localSettings.maxConnections, localSettings.maxRelaysPerUser),
    debounceTime(500),  // Wait 500ms for relay data to stabilize
    map(([users, maxConnections, maxRelaysPerUser]) =>
      selectOptimalRelays(users, { maxConnections, maxRelaysPerUser }),
    ),
  );
}
```

The `debounceTime(500)` is notable -- it waits for relay data to stabilize (since kind 10002 events arrive asynchronously from multiple relays) before running the selection algorithm.

### 3.3 Default configuration

**File:** `/tmp/outbox-research/nostrudel/src/const.ts`

```typescript
export const DEFAULT_MAX_CONNECTIONS = 20;
export const DEFAULT_MAX_RELAYS_PER_USER = 5;
export const DEFAULT_LOOKUP_RELAYS = ["wss://purplepag.es/"];
export const DEFAULT_FALLBACK_RELAYS = ["wss://relay.primal.net/", "wss://relay.damus.io/"];
```

### 3.4 Outbox caching and timeline loading

noStrudel caches outbox maps (relay-to-users mappings) to avoid recomputing them:

**File:** `/tmp/outbox-research/nostrudel/src/services/outbox-cache.ts`

```typescript
class OutboxCacheService {
  protected outboxMaps = new LRU<Observable<OutboxMap>>(30); // max 30 cached

  getOutboxMap(list: LoadableAddressPointer): Observable<OutboxMap> {
    const key = hash_sum(["outbox-map", list.kind, list.pubkey, list.identifier]);
    let existing = this.outboxMaps.get(key);
    if (existing) return existing;

    const outboxMap$ = eventStore.replaceable(list).pipe(
      map((event) => event ? getProfilePointersFromList(event) : undefined),
      defined(),
      outboxSelection(),
      map((selection) => createOutboxMap(selection)),
      shareReplay(1),
    );
    this.outboxMaps.set(key, outboxMap$);
    return outboxMap$;
  }
}
```

The outbox subscription service uses these cached maps to create live subscriptions:

**File:** `/tmp/outbox-research/nostrudel/src/services/outbox-subscriptions.ts`

```typescript
class OutboxSubscriptionsService {
  subscription(list, filter) {
    return outboxCacheService.getOutboxMap(list).pipe(
      switchMap((outboxMap) => {
        const { authors, ...filterWithoutAuthors } = filter;
        return pool.outboxSubscription(outboxMap, filterWithoutAuthors).pipe(
          onlyEvents(),
          mapEventsToStore(eventStore),
          ignoreElements(),
        );
      }),
    );
  }
}
```

### 3.5 UI for relay management

noStrudel provides several settings views:

**Relay Settings** (`/tmp/outbox-research/nostrudel/src/views/settings/relays/index.tsx`):
- Lookup relay configuration (for discovering kind 10002 events)
- Fallback relay configuration
- Extra publish relay configuration
- Unhealthy relay management

**Outbox Selection Settings** (`/tmp/outbox-research/nostrudel/src/views/settings/outbox-selection/index.tsx`):
- Max Connections slider (0-30, default 20)
- Max Relays Per User slider (0-30, default 5)
- Table showing which relays are selected and how many users each covers
- Users-by-relay-count breakdown (users grouped by how many relays were selected for them)
- Missing relay list users (no kind 10002 event)
- "Orphaned" users (had relays but none were selected after optimization)

**Outbox Relay Selection Debugger Modal** (`/tmp/outbox-research/nostrudel/src/components/outbox-relay-selection-modal.tsx`):
- Shows stats: selected relays, connected relays, coverage %, total users
- Progress bar for user coverage
- Per-relay table with user count, connection status, and % of total users
- Color-coded coverage indicator (green >= 80%, yellow >= 50%, red < 50%)

### 3.6 User-configurable preferences

**File:** `/tmp/outbox-research/nostrudel/src/services/preferences.ts`

All relay-related settings are persisted and reactive (using `PreferenceSubject` which wraps `BehaviorSubject`):

```typescript
const fallbackRelays = await PreferenceSubject.array<string>("fallback-relays", DEFAULT_FALLBACK_RELAYS);
const lookupRelays = await PreferenceSubject.array<string>("lookup-relays", DEFAULT_LOOKUP_RELAYS);
const extraPublishRelays = await PreferenceSubject.array<string>("extra-publish-relays", []);
const maxConnections = await PreferenceSubject.number("max-connections", DEFAULT_MAX_CONNECTIONS);
const maxRelaysPerUser = await PreferenceSubject.number("max-relays-per-user", DEFAULT_MAX_RELAYS_PER_USER);
```

Because these are observables, changing any setting automatically triggers re-selection through the RxJS pipeline.

---

## Comparative Analysis

### Relay selection algorithms

**NDK** uses a three-priority greedy approach:
1. Prefer already-connected relays
2. Prefer relays already selected for other authors (connection reuse)
3. Fall back to popularity-ranked relays

There is no hard cap on total connections. The `relayGoalPerAuthor` (default 2) controls how many relays each author gets, but the total number of relays grows with the diversity of authors' relay sets.

**Applesauce** uses a formal set-cover approach:
1. At each step, pick the relay covering the most uncovered users
2. Hard cap on total connections (`maxConnections`)
3. Remove users from the pool once they hit `maxRelaysPerUser`

The Applesauce approach is better at minimizing total connections because it has a hard cap and its algorithm explicitly optimizes for coverage. NDK's approach may open more connections but prioritizes reusing existing connections.

### Reactivity

- **NDK**: Imperative. Outbox data is fetched, cached in LRU, and subscriptions are manually refreshed when data arrives.
- **Applesauce/noStrudel**: Reactive. Everything is RxJS observables. When a kind 10002 event updates, the pipeline automatically re-runs selection and updates subscriptions.

### Health tracking

- **NDK**: Flapping detection with exponential backoff, system-wide disconnection detection, delayed connect from cache.
- **Applesauce/noStrudel**: `RelayLiveness` with online/offline/dead states, exponential backoff, persistent storage, and `ignoreUnhealthyRelaysOnPointers` operator for automatic filtering.

### Transparency to app developers

- **NDK**: Maximum transparency. Any app calling `ndk.subscribe()` with author filters gets outbox routing without any code changes.
- **Applesauce**: Requires explicit composition. Developers must use `includeMailboxes()`, `selectOptimalRelays()`, and `groupPubkeysByRelay()` to build their own outbox pipeline.
- **noStrudel**: Demonstrates the "right way" to compose Applesauce's primitives into a complete outbox implementation.
