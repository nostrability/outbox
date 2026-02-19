# Outbox Implementation Analysis: Nostur, Yakihonne, Notedeck

## Summary

| Client | Language | Outbox Status | Scope | Approach |
|--------|----------|--------------|-------|----------|
| **Nostur** | Swift/iOS | Mature, opt-in ("Autopilot") | Follows + custom feeds only | Full NIP-65 outbox+inbox with request planning, write relay routing, and connection pooling |
| **Yakihonne** | Dart/Flutter | Partial / Display-only | Own relays only | Reads kind 10002 to display and self-configure relays; connects to author relays on-demand for event lookup; no outbox routing for feeds |
| **Notedeck** | Rust | Foundation only (PR #1288 in progress) | Own account's relay list | Parses NIP-65, manages own relay set from kind 10002; no outbox routing for follows yet |

**Key takeaway:** Nostur is the only client of the three with a complete outbox implementation for reading and writing. Yakihonne uses kind 10002 primarily for self-relay-management and has a rudimentary "fetch from author's relays" fallback. Notedeck has the NIP-65 parsing and relay configuration foundation in place but does not yet route requests per-author.

---

## Nostur (Swift/iOS)

### Architecture Overview

Nostur's outbox implementation is built across two layers:
1. **NostrEssentials library** (`nostr-essentials` Swift package) -- contains the core outbox algorithms (`createRequestPlan`, `createWritePlan`, `pubkeysByRelay`)
2. **Nostur app layer** -- `OutboxLoader`, `ConnectionPool`, settings integration, relay hint resolution

The feature is called "Autopilot" in the UI and is **disabled by default** (opt-in). A separate toggle "Follow relay hints" controls whether ephemeral connections are made to relays embedded in nostr links (nevent, naddr).

### Kind 10002 Processing

**File:** `/tmp/outbox-research/nostur/Nostur/Relays/Network/OutboxLoader.swift`

The `OutboxLoader` is initialized when a user logs in (if outbox is enabled), scoped to the user's follows and custom contact feeds:

```swift
init(pubkey: String, follows: Set<String> = [], cp: ConnectionPool) {
    self.pubkey = pubkey
    self.follows = follows
    // ...
    self.load()
}
```

On load, it:
1. Fetches kind 10002 events from the local CoreData database for all followed pubkeys
2. Sends a REQ to connected relays for kind 10002 with `since:` optimization
3. Passes parsed kind 10002s to `ConnectionPool.setPreferredRelays()`

```swift
let kind10002s: [NostrEssentials.Event] = Event.fetchReplacableEvents(
    10002, pubkeys: self.follows.union(self.contactFeedPubkeys), context: context
)
```

**Limitation to follows:** Kind 10002 events are only fetched for pubkeys in the user's follow list plus any custom contact feed pubkeys with `.useOutbox` enabled. This is the "limited to follows and relay hints" constraint -- the outbox model does NOT apply to arbitrary pubkeys discovered while browsing.

**Misconfigured kind 10002 detection:**

**File:** `/tmp/outbox-research/nostur/Nostur/Relays/Network/OutboxLoader.swift` (bottom)

Nostur maintains a hardcoded list of known-bad relay entries that indicate a misconfigured kind 10002:

```swift
let DETECT_MISCONFIGURED_KIND10002_HELPER_LIST: Set<String> = [
    "ws://127.0.0.1",
    "ws://localhost",
    "wss://filter.nostr.wine",     // paid
    "wss://welcome.nostr.wine",    // special feed relay
    "wss://nostr.mutinywallet.com", // blastr (write-only)
    "wss://feeds.nostr.band",      // special feeds
    "wss://search.nos.today",
    "wss://relay.getalby.com",     // NWC only
    "sendit.nosflare.com",         // rejects REQs
]
```

If ANY write relay in a kind 10002 matches this list, the entire kind 10002 is discarded.

### Outbox Algorithm (NostrEssentials Library)

**File:** `/Users/e/Desktop/develop/nostrability/outbox/nostr-essentials-src/Sources/NostrEssentials/Outbox/Outbox.swift`

**Data structures:**

```swift
public struct PreferredRelays {
    // key = relayUrl, value = pubkeys writing to that relay
    public let findEventsRelays: [String: Set<String>]
    // key = relayUrl, value = pubkeys reading from that relay
    public let reachUserRelays: [String: Set<String>]
}
```

**`pubkeysByRelay()`** -- Processes kind 10002 events into two dictionaries:
- `findEventsRelays`: Maps each relay URL to the set of pubkeys whose kind 10002 marks that relay as "write" (or no marker = both)
- `reachUserRelays`: Maps each relay URL to the set of pubkeys whose kind 10002 marks that relay as "read" (or no marker = both)

**`createRequestPlan()`** -- Generates per-relay REQ filters:
- Starts with relays sorted by most pubkeys (most coverage first)
- **Skips top N relays** (`skipTopRelays: 3` for Following feed) to avoid centralizing on popular relays
- For single-pubkey requests (profile views), finds up to 2 relays
- For multi-pubkey requests, greedily assigns pubkeys to relays, tracking which are accounted for
- Returns a `RequestPlan` with the original filters + per-relay `FindEventsRequest` objects

```swift
public func createRequestPlan(
    pubkeys: Set<String>,
    reqFilters: [Filters],
    ourReadRelays: Set<String>,
    preferredRelays: PreferredRelays,
    skipTopRelays: Int = 0
) -> RequestPlan
```

**`createWritePlan()`** -- Determines where to publish events to reach tagged users:
- For each pubkey in `p` tags, finds their read relays from `PreferredRelays.reachUserRelays`
- Excludes relays already in the user's write set (for redundancy)
- Greedy assignment: most-covered relays first

### Connection Management

**File:** `/tmp/outbox-research/nostur/Nostur/Relays/Network/ConnectionPool.swift`

Nostur maintains **three separate connection pools**:

1. **`connections`** -- User's configured relays (persistent)
2. **`outboxConnections`** -- Outbox-derived relays (managed automatically, cleaned up after 10 min idle)
3. **`ephemeralConnections`** -- Relay hint connections (auto-removed after 35 seconds)

The outbox flow in `sendMessageAlreadyInQueue()`:

```swift
// Guard checks before outbox routing
guard SettingsStore.shared.enableOutboxRelays, vpnGuardOK() else { return }
guard let preferredRelays = self.preferredRelays else { return }

// For REQ: send to others' write relays
if message.type == .REQ && !preferredRelays.findEventsRelays.isEmpty {
    self.sendToOthersPreferredWriteRelays(...)
}

// For EVENT: send to others' read relays (for replies/mentions)
else if message.type == .EVENT && !preferredRelays.reachUserRelays.isEmpty {
    // Only for our own events, not rebroadcasts
    guard AccountsState.shared.bgFullAccountPubkeys.contains(pubkey) else { return }
    self.sendToOthersPreferredReadRelays(...)
}
```

**Max outbox connections:** Capped at 50 (`maxPreferredRelays`).

**Special-purpose relay exclusion:**
```swift
let SPECIAL_PURPOSE_RELAYS: Set<String> = [
    "wss://nostr.mutinywallet.com",  // blastr
    "wss://filter.nostr.wine",
    "wss://purplepag.es"
]
```

### Relay Hint Resolution

**File:** `/tmp/outbox-research/nostur/Nostur/Relays/Network/OutboxLoader.swift` (function `resolveRelayHint`)

When composing posts (quotes, replies), Nostur resolves relay hints using a priority cascade:

1. **Write relay (kind 10002) + connection stats + received-from relay** -- highest confidence
2. **Write relay + received-from relay**
3. **Write relay + connection stats**
4. **Write relay alone** -- lowest confidence

All results exclude: localhost, non-wss, 127.0.x.x, "local", "iCloud", and auth-required relays.

### Privacy Features

- **VPN detection gate:** If enabled, outbox connections only proceed when a VPN is detected
- **Low data mode:** Disables all outbox routing entirely
- **Outbox preview:** Optional UI showing which additional relays will be used when composing

### Kind 10002 Publishing (Configuration Wizard)

**File:** `/tmp/outbox-research/nostur/Nostur/Relays/Kind10002ConfigurationWizard.swift`

A multi-step wizard lets users configure:
1. Write relays (max 3) -- "Which relays should others use to find your posts?"
2. Read relays (max 3) -- "Which relays should others use to reach you?"
3. DM relays (max 3) -- Published as kind 10050

Supports both local signing and NSecBunker (remote signer) workflows.

---

## Yakihonne (Dart/Flutter)

### Architecture Overview

Yakihonne is a Dart/Flutter client focused on long-form content (articles, flash news, videos, curations). Its relay architecture is **centralized around its own relay infrastructure** with user relay lists serving primarily as self-configuration.

### Kind 10002 Processing

**File:** `/tmp/outbox-research/yakihonne/lib/nostr/nips/nip_065.dart`

Yakihonne has a proper NIP-65 decoder:

```dart
class Nip65 {
  static List<FavoriteRelay> decodeRelaysList(Event event) {
    // Parses "r" tags with read/write markers
    for (final tag in event.tags) {
      if (tag.first == 'r') {
        bool read = true;
        bool write = true;
        write = !(tag.length > 2 && tag[2] == 'read');
        read = !(tag.length > 2 && tag[2] == 'write');
        relays.add(FavoriteRelay(relay: tag[1], read: read, write: write));
      }
    }
    return relays;
  }
}
```

**However, this decoder is never used for outbox routing.** It exists but is not referenced in the codebase's relay selection logic.

### How Relays Are Actually Used

**File:** `/tmp/outbox-research/yakihonne/lib/repositories/nostr_functions_repository.dart` (line ~1960)

On login, Yakihonne:
1. Disconnects from all non-constant relays
2. Resets to `constantRelays` (hardcoded Yakihonne relays + relay.damus.io)
3. Fetches the user's kind 10002 and connects to those relays

```dart
final relays = NostrConnect.sharedInstance.relays()
  ..removeWhere((element) => constantRelays.contains(element));
nostrRepository.relays = constantRelays.toSet();

await NostrConnect.sharedInstance.closeConnect(relays);
```

Then when processing kind 10002 events:
```dart
} else if (event.kind == EventKind.RELAY_LIST_METADATA) {
  for (final tag in event.tags) {
    if (tag.first == 'r' && tag.length > 1) {
      if (!nostrRepository.relays.contains(tag[1])) {
        nostrRepository.relays.add(tag[1]);
        NostrConnect.sharedInstance.connect(tag[1]);
      }
    }
  }
}
```

**Key observation:** Yakihonne connects to ALL relays from the user's own kind 10002 (no read/write distinction). It does NOT fetch or use kind 10002 from other users for feed routing.

### Constant/Default Relays

**File:** `/tmp/outbox-research/yakihonne/lib/utils/constants.dart`

```dart
const constantRelays = [
  'wss://nostr-01.yakihonne.com',
  'wss://nostr-02.yakihonne.com',
  'wss://nostr-03.dorafactory.org',
  'wss://nostr-02.dorafactory.org',
  'wss://relay.damus.io',
];
```

These relays cannot be removed by the user and are always connected.

### On-Demand Relay Fallback for Event Lookup

**File:** `/tmp/outbox-research/yakihonne/lib/blocs/main_cubit/main_cubit.dart` (line ~570)

When an event cannot be found on connected relays, Yakihonne has a fallback that fetches the author's kind 10002 and temporarily connects to their relays:

```dart
final relaysListEvent = await getForwardEvent(
  kinds: [EventKind.RELAY_LIST_METADATA],
  author: author,
);

if (relaysListEvent != null) {
  Set<String> searchedRelays = {};
  for (final tag in relaysListEvent.tags) {
    if (tag.first == 'r' && tag.length > 1) {
      searchedRelays.add(tag[1]);
    }
  }

  final connectedRelays = NostrConnect.sharedInstance.relays().toSet();
  final differedRelays = searchedRelays.difference(connectedRelays);

  if (differedRelays.isNotEmpty) {
    BotToastUtils.showInformation("Fetching event from user's relays");
    NostrConnect.sharedInstance.connectRelays([
      ...connectedRelays.toList(),
      ...differedRelays.toList(),
    ]);
    await Future.delayed(const Duration(seconds: 2));
    final e = await getForwardEvent(/* ... */);
    await NostrConnect.sharedInstance.closeConnect(differedRelays.toList());
    return e;
  }
}
```

This is the closest thing to outbox behavior: connect to author's relays, fetch event, disconnect. But it only triggers for individual event lookups (naddr/nevent resolution), not for feeds.

### Kind 10002 Publishing

**File:** `/tmp/outbox-research/yakihonne/lib/blocs/properties_cubit/update_relays_cubit/update_relays_cubit.dart`

Users can publish their relay list as kind 10002. Notably, Yakihonne publishes ALL relays as bare `["r", url]` tags with **no read/write markers**:

```dart
final kind10002Event = await Event.genEvent(
  content: '',
  kind: EventKind.RELAY_LIST_METADATA,
  tags: state.relays.map((relay) => ['r', relay]).toList(),
);
```

### Connection Management

**File:** `/tmp/outbox-research/yakihonne/lib/repositories/nostr_connect_repository.dart`

Simple WebSocket management. All subscriptions are sent to all connected relays (no per-relay filtering):

```dart
String addSubscription(
  List<Filter> filters,
  List<String> relays, {
  EventCallBack? eventCallBack,
  EOSECallBack? eoseCallBack,
}) {
  Map<String, List<Filter>> result = {};
  final webSocketRelays = NostrConnect.sharedInstance.relays();
  for (var relay in webSocketRelays) {
    if (relays.isNotEmpty && relays.contains(relay) || relays.isEmpty) {
      if (webSockets[relay] != null) {
        result[relay] = filters;
      }
    }
  }
  return addSubscriptions(result, relays, ...);
}
```

Events are published to all connected relays (or a specified subset):

```dart
void sendEvent(Event event, List<String> selectedRelays, ...) {
  _send(
    event.serialize(),
    chosenRelays: selectedRelays.isNotEmpty ? selectedRelays : null,
  );
}
```

### What Yakihonne Does NOT Do

- No outbox routing for feeds (does not fetch follows' kind 10002)
- No per-author relay selection for subscriptions
- No inbox routing when publishing (does not check p-tagged users' read relays)
- No read/write marker distinction in relay selection
- Profile view relay display is informational only -- shows relays from kind 10002 but does not connect to them for fetching

---

## Notedeck (Rust)

### Architecture Overview

Notedeck is a Rust client built on `nostrdb` (a local C database for nostr events) and `egui` (immediate mode GUI). Its relay architecture is currently focused on managing the user's own relay set, with outbox support planned via PR #1288.

### Kind 10002 Processing (Foundation)

**File:** `/tmp/outbox-research/notedeck/crates/notedeck/src/account/relay.rs`

Notedeck has solid NIP-65 infrastructure:

```rust
pub(crate) struct AccountRelayData {
    pub filter: Filter,
    pub local: BTreeSet<RelaySpec>,     // used locally but not advertised
    pub advertised: BTreeSet<RelaySpec>, // advertised via NIP-65
}

impl AccountRelayData {
    pub fn new(pubkey: &[u8; 32]) -> Self {
        let filter = Filter::new()
            .authors([pubkey])
            .kinds([10002])
            .limit(1)
            .build();
        AccountRelayData {
            filter,
            local: BTreeSet::new(),
            advertised: BTreeSet::new(),
        }
    }
}
```

**NIP-65 tag parsing:**

```rust
pub(crate) fn harvest_nip65_relays(ndb: &Ndb, txn: &Transaction, nks: &[NoteKey]) -> Vec<RelaySpec> {
    let mut relays = Vec::new();
    for nk in nks.iter() {
        if let Ok(note) = ndb.get_note_by_key(txn, *nk) {
            for tag in note.tags() {
                match tag.get(0).and_then(|t| t.variant().str()) {
                    Some("r") => {
                        if let Some(url) = tag.get(1).and_then(|f| f.variant().str()) {
                            let has_read_marker = tag.get(2)
                                .is_some_and(|m| m.variant().str() == Some("read"));
                            let has_write_marker = tag.get(2)
                                .is_some_and(|m| m.variant().str() == Some("write"));
                            relays.push(RelaySpec::new(
                                Self::canonicalize_url(url),
                                has_read_marker,
                                has_write_marker,
                            ));
                        }
                    }
                    // ...
                }
            }
        }
    }
    relays
}
```

### RelaySpec (NIP-65 Markers)

**File:** `/tmp/outbox-research/notedeck/crates/notedeck/src/relayspec.rs`

Clean implementation with correct NIP-65 semantics:

```rust
pub struct RelaySpec {
    pub url: String,
    pub has_read_marker: bool,
    pub has_write_marker: bool,
}

impl RelaySpec {
    pub fn is_readable(&self) -> bool {
        !self.has_write_marker // only "write" relays are not readable
    }
    pub fn is_writable(&self) -> bool {
        !self.has_read_marker // only "read" relays are not writable
    }
}
```

Handles the NIP-65 edge case: if both markers are set, both are turned off (treating the relay as both read+write).

### Relay Configuration

**File:** `/tmp/outbox-research/notedeck/crates/notedeck/src/account/relay.rs` (function `update_relay_configuration`)

On account selection, Notedeck reconciles desired relays with the pool:

```rust
pub(super) fn update_relay_configuration(
    pool: &mut RelayPool,
    relay_defaults: &RelayDefaults,
    pk: &Pubkey,
    data: &AccountRelayData,
    wakeup: impl Fn() + Send + Sync + Clone + 'static,
) {
    // Priority: forced relays > local+advertised > bootstrap
    let mut desired_relays = relay_defaults.forced_relays.clone();
    if desired_relays.is_empty() {
        desired_relays.extend(data.local.iter().cloned());
        desired_relays.extend(data.advertised.iter().cloned());
    }
    if desired_relays.is_empty() {
        desired_relays = relay_defaults.bootstrap_relays.clone();
    }

    // Diff-based add/remove
    let add: BTreeSet<RelaySpec> = desired_relays.difference(&pool_specs).cloned().collect();
    let sub: BTreeSet<RelaySpec> = pool_specs.difference(&desired_relays).cloned().collect();
    // ...
}
```

### Bootstrap/Default Relays

```rust
let bootstrap_relays = [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://nostr.wine",
    "wss://purplepag.es",
];
```

### Live Updates via Subscription

Kind 10002 changes are tracked via a nostrdb subscription:

```rust
pub fn poll_for_updates(&mut self, ndb: &Ndb, txn: &Transaction, sub: Subscription) -> bool {
    let nks = ndb.poll_for_notes(sub, 1);
    if nks.is_empty() { return false; }
    let relays = AccountRelayData::harvest_nip65_relays(ndb, txn, &nks);
    self.advertised = relays.into_iter().collect();
    true
}
```

When updates are detected, `update_relay_configuration` is called again to reconcile the pool.

### Relay Pool

**File:** `/tmp/outbox-research/notedeck/crates/enostr/src/relay/pool.rs`

Currently a flat pool -- all relays receive all messages:

```rust
pub fn send(&mut self, cmd: &ClientMessage) {
    for relay in &mut self.relays {
        if let Err(err) = relay.send(cmd) {
            error!("error sending {:?} to {}: {err}", cmd, relay.url());
        }
    }
}
```

No per-relay filtering based on read/write markers. The `send_to()` method exists for targeted sending but is not used for outbox routing.

### Multicast Relay (Unique Feature)

Notedeck includes a multicast relay for local network discovery:

```rust
if let Err(err) = pool.add_multicast_relay(move || ctx.request_repaint()) {
    error!("error setting up multicast relay: {err}");
}
```

This is the "nostrdb local relay" concept -- events published locally can be discovered by other Notedeck instances on the same network without going through remote relays.

### What Notedeck Does NOT Yet Do

- No fetching of kind 10002 for followed pubkeys (only own account)
- No per-author relay routing for subscriptions
- No inbox routing when publishing events
- No relay hint following
- The `RelaySpec.is_readable()` / `is_writable()` methods exist but are not used for routing decisions
- `FilterStates` has per-relay tracking infrastructure (in `filter.rs`) that could support outbox routing

### PR #1288 Context

Based on the codebase structure, PR #1288 likely builds on:
- The existing `AccountRelayData` and `RelaySpec` types
- The `FilterStates` per-relay state machine in `filter.rs`
- The `send_to()` method in `RelayPool` for targeted relay communication
- The subscription infrastructure that already supports per-relay EOSE tracking

The foundation pieces are clearly in place: NIP-65 parsing, relay set management, live subscription updates, and per-relay state tracking. What is missing is the "fan out" logic -- querying different relays for different pubkeys based on their kind 10002.

---

## Comparative Analysis

### Reading (Fetching Posts from Follows)

| Feature | Nostur | Yakihonne | Notedeck |
|---------|--------|-----------|----------|
| Fetches kind 10002 for follows | Yes (up to 2000) | No | No (own account only) |
| Per-author relay routing | Yes (RequestPlan) | No | No |
| Skips centralized relays | Yes (skipTopRelays) | No | No |
| Connection limit | 50 outbox relays | N/A | N/A |
| Since optimization | Yes | N/A | N/A |

### Writing (Publishing to Reach Recipients)

| Feature | Nostur | Yakihonne | Notedeck |
|---------|--------|-----------|----------|
| Publishes to p-tagged users' read relays | Yes (WritePlan) | No | No |
| Own kind 10002 publishing | Yes (wizard) | Yes (no markers) | Yes |
| Read/write marker support | Yes | No (bare "r" tags) | Yes |
| DM relay support (kind 10050) | Yes | No | No |

### Relay Hint Handling

| Feature | Nostur | Yakihonne | Notedeck |
|---------|--------|-----------|----------|
| Follows relay hints in events | Yes (opt-in) | Partial (event lookup only) | No |
| Relay hint in composed events | Yes (resolveRelayHint) | No | No |
| Ephemeral connections | Yes (35s timeout) | Yes (2s delay + disconnect) | No |

### Privacy / Resource Controls

| Feature | Nostur | Yakihonne | Notedeck |
|---------|--------|-----------|----------|
| VPN detection gate | Yes | No | No |
| Low data mode | Yes (disables outbox) | No | No |
| Outbox on/off toggle | Yes (default off) | N/A | N/A |
| Connection cleanup | Yes (stale outbox: 10min, ephemeral: 35s) | Manual disconnect | N/A |
| Penalty box for bad relays | Yes | No | No |

### Misconfigured Kind 10002 Handling

| Feature | Nostur | Yakihonne | Notedeck |
|---------|--------|-----------|----------|
| Detects bad write relays | Yes (hardcoded list) | No | No |
| Discards garbage kind 10002 | Yes (entire event) | No | No |
| Validates relay URLs | Yes (filters localhost, non-wss) | No | Yes (URL parsing) |
